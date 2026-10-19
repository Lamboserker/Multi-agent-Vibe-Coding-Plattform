import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  assessResources,
  costPerHour,
  dayKey,
  emptyLedger,
  integrate,
  lastDays,
  loadedModelUsage,
  powerReading,
  ResourceSampler,
  summarizeEnergy,
  usableVramMb,
  type EnergyLedger,
  type LoadedModelUsage,
  type PowerReading,
  type ResourceSample,
  type ResourceWarning,
} from '@multi-ai-coder/engine'
import { runtimeConfig } from '../runtime/runtime-config.js'
import { PrismaService } from '../common/prisma.service.js'
import { SettingsService } from '../runtime/settings.service.js'
import { LocalModelsService } from './local-models.service.js'

const MB = 1024 * 1024
const HISTORY = 40
const ACTIVE_RUNS = ['pending', 'running', 'paused', 'integrating'] as const
const WORKING = ['running', 'validating', 'repairing']

export interface ResourcePoint {
  at: string
  cpuPct: number
  ramUsedBytes: number
  gpuPct?: number
  vramUsedMb?: number
}

export interface ResourceSnapshot {
  at: string
  cpu: { pct: number; model: string; logicalCores: number; physicalCores?: number }
  ram: { usedBytes: number; totalBytes: number }
  gpu?: {
    name: string
    utilizationPct?: number
    vramUsedMb?: number
    vramTotalMb?: number
    temperatureC?: number
    powerW?: number
    powerLimitW?: number
    /** nvidia-smi = measured; ollama = sum of the model memory Ollama reports (no other processes). */
    source: 'nvidia-smi' | 'ollama' | 'none'
  }
  disk?: { path: string; freeBytes?: number; totalBytes?: number }
  history: ResourcePoint[]
  ollama: { reachable: boolean }
  models: Array<LoadedModelUsage & { agents: string[] }>
  slots: { local: number; premium: number; busyLocal: number; busyPremium: number }
  /** Local subtasks of active runs that wait for a slot or for their model. */
  waiting: Array<{ key: string; title: string; model?: string; reason: string }>
  warnings: ResourceWarning[]
}

/**
 * Live hardware load for the resource monitor. Samples only while somebody asks (each request older
 * than a second takes a new sample), so the app does not poll nvidia-smi or Ollama in the background.
 */
const ENERGY_INTERVAL_MS = 10_000

@Injectable()
export class ResourceMonitorService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('ResourceMonitor')
  private ledger: EnergyLedger = emptyLedger()
  private lastEnergy?: { at: Date; reading: PowerReading; inferenceActive: boolean }
  private energyTimer?: NodeJS.Timeout
  private ledgerDirty = false
  private savedAt = 0
  private ledgerFile?: string
  private readonly sampler = new ResourceSampler({ historySize: HISTORY, minIntervalMs: 1000 })
  private readonly points: ResourcePoint[] = []
  private running?: { at: number; reachable: boolean; models: LoadedModelUsage[] }

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly localModels: LocalModelsService,
  ) {}

  async onModuleInit() {
    this.ledgerFile = path.join(runtimeConfig().dataDir, 'energy.json')
    try {
      const stored = JSON.parse(await fs.readFile(this.ledgerFile, 'utf8')) as EnergyLedger
      if (stored?.version === 1 && stored.days) this.ledger = stored
    } catch {
      // first start: empty ledger
    }
    // the meter runs while the app runs, independent of any open view
    this.energyTimer = setInterval(() => void this.measureEnergy().catch((error: unknown) => this.logger.warn(`energy sample failed: ${String(error)}`)), ENERGY_INTERVAL_MS)
    this.energyTimer.unref?.()
    void this.measureEnergy().catch(() => undefined)
  }

  async onApplicationShutdown() {
    if (this.energyTimer) clearInterval(this.energyTimer)
    await this.saveLedger(true)
  }

  private async inferenceActive() {
    const working = await this.prisma.subtask.count({ where: { status: { in: ['running', 'validating', 'repairing'] }, selectedModelClass: 'local_llm', manualModel: null, task: { executions: { some: { status: { in: [...ACTIVE_RUNS] } } } } } }).catch(() => 0)
    return working > 0
  }

  /** One power reading from the latest sample, the tariff and whether a local model is working. */
  private async currentPower(sample?: ResourceSample) {
    const [current, settings, inferenceActive] = await Promise.all([sample ?? this.sampler.sample(), this.settings.get(), this.inferenceActive()])
    const reading = powerReading({ gpuPowerW: current.gpus.reduce<number | undefined>((sum, gpu) => (gpu.powerW === undefined ? sum : (sum ?? 0) + gpu.powerW), undefined), gpuWattsSetting: settings.gpuWatts, inferenceActive, cpuPct: current.cpuPct, tariff: settings.electricity })
    return { at: new Date(current.at), reading, inferenceActive, settings }
  }

  async measureEnergy() {
    const { at, reading, inferenceActive } = await this.currentPower()
    if (this.lastEnergy && at.getTime() <= this.lastEnergy.at.getTime()) return
    const next = integrate(this.ledger, this.lastEnergy, { at, reading, inferenceActive }, ENERGY_INTERVAL_MS * 4)
    if (next !== this.ledger) this.ledgerDirty = true
    this.ledger = next
    this.lastEnergy = { at, reading, inferenceActive }
    await this.saveLedger(false)
  }

  private async saveLedger(force: boolean) {
    if (!this.ledgerFile || !this.ledgerDirty || (!force && Date.now() - this.savedAt < 60_000)) return
    this.ledgerDirty = false
    this.savedAt = Date.now()
    await fs.writeFile(this.ledgerFile, JSON.stringify(this.ledger)).catch((error: unknown) => this.logger.warn(`energy ledger not saved: ${String(error)}`))
  }

  /** Live draw, today's and the period's energy and costs from the user's tariff. */
  async energy(days = 30) {
    const range = Math.max(1, Math.min(366, Math.round(days)))
    const { at, reading, inferenceActive, settings } = await this.currentPower()
    const tariff = settings.electricity
    const keys = lastDays(at, range)
    const daily = keys.map((key) => {
      const summary = summarizeEnergy(this.ledger, [key], tariff)
      return { date: key, kWh: summary.kWh, inferenceKWh: summary.inferenceKWh, hours: summary.hours, energyCost: summary.energyCost }
    })
    return {
      at: at.toISOString(),
      live: { ...reading, inferenceActive, costPerHour: tariff ? costPerHour(reading.totalW, tariff) : null },
      tariff,
      today: summarizeEnergy(this.ledger, [dayKey(at)], tariff),
      period: summarizeEnergy(this.ledger, keys, tariff),
      daily,
      measuringSince: this.ledger.since ?? null,
      sampleIntervalMs: ENERGY_INTERVAL_MS,
    }
  }

  private async loadedModels() {
    if (this.running && Date.now() - this.running.at < 2000) return this.running
    try {
      const models = loadedModelUsage(await (await this.localModels.client()).running())
      this.running = { at: Date.now(), reachable: true, models }
    } catch {
      this.running = { at: Date.now(), reachable: false, models: [] }
    }
    return this.running
  }

  private async activeSubtasks() {
    return this.prisma.subtask.findMany({
      where: { status: { in: ['queued', 'running', 'validating', 'repairing'] }, task: { executions: { some: { status: { in: [...ACTIVE_RUNS] } } } } },
      select: { key: true, title: true, status: true, selectedModelClass: true, selectedModelName: true, manualModel: true },
      orderBy: [{ createdAt: 'asc' }, { priority: 'desc' }],
    })
  }

  async snapshot(): Promise<ResourceSnapshot> {
    const [sample, hardware, loaded, subtasks, localSlots, settings] = await Promise.all([
      this.sampler.sample(),
      this.localModels.hardware(),
      this.loadedModels(),
      this.activeSubtasks().catch(() => []),
      this.localModels.localSlots().catch(() => 1),
      this.settings.get(),
    ])
    const local = (subtask: (typeof subtasks)[number]) => subtask.selectedModelClass === 'local_llm' && subtask.manualModel !== 'premium'
    const working = subtasks.filter((subtask) => WORKING.includes(subtask.status))
    const models = loaded.models.map((model) => ({ ...model, agents: working.filter((subtask) => local(subtask) && subtask.selectedModelName === model.name).map((subtask) => subtask.key) }))
    const busyLocal = working.filter(local).length
    const busyPremium = working.length - busyLocal

    const profileGpu = [...hardware.gpus].sort((a, b) => (b.vramTotalMb ?? 0) - (a.vramTotalMb ?? 0))[0]
    const measured = sample.gpus[0]
    const modelsVramMb = Math.round(models.reduce((sum, model) => sum + model.vramBytes, 0) / MB)
    const gpu: ResourceSnapshot['gpu'] = measured
      ? { name: measured.name, utilizationPct: measured.utilizationPct, vramUsedMb: measured.vramUsedMb, vramTotalMb: measured.vramTotalMb ?? profileGpu?.vramTotalMb, temperatureC: measured.temperatureC, powerW: measured.powerW, powerLimitW: measured.powerLimitW, source: 'nvidia-smi' }
      : profileGpu
        ? { name: profileGpu.name, vramTotalMb: profileGpu.vramReliable ? profileGpu.vramTotalMb : undefined, vramUsedMb: loaded.reachable ? modelsVramMb : undefined, source: loaded.reachable ? 'ollama' : 'none' }
        : undefined

    this.record(sample, gpu)

    const waiting = subtasks
      .filter((subtask) => subtask.status === 'queued' && local(subtask))
      .map((subtask) => {
        const resident = models.some((model) => model.name === subtask.selectedModelName)
        const reason = busyLocal >= localSlots
          ? `wartet auf einen freien lokalen Slot (${busyLocal}/${localSlots} belegt)`
          : !resident && gpu?.vramTotalMb && gpu.vramUsedMb !== undefined && gpu.vramUsedMb / gpu.vramTotalMb > 0.85
            ? 'wartet, bis genug VRAM für das Modell frei ist'
            : 'wartet auf Abhängigkeiten oder den Scheduler'
        return { key: subtask.key, title: subtask.title, model: subtask.selectedModelName ?? undefined, reason }
      })

    const warnings = assessResources({ sample, models, hasGpu: Boolean(profileGpu) })
    const vram = usableVramMb(hardware)
    if (vram && settings.localParallelism !== 'auto' && settings.localParallelism > 1 && localSlots > 1 && modelsVramMb > vram * 0.95) {
      warnings.push({ code: 'vram_full', severity: 'warn', message: `Die feste Parallelität (${settings.localParallelism}) überschreitet den VRAM; Modelle werden ausgelagert.` })
    }

    return {
      at: sample.at,
      cpu: { pct: sample.cpuPct, model: hardware.cpu.model, logicalCores: hardware.cpu.logicalCores, physicalCores: hardware.cpu.physicalCores },
      ram: { usedBytes: sample.ramUsedBytes, totalBytes: sample.ramTotalBytes },
      gpu,
      disk: hardware.disks.ollamaModels,
      history: [...this.points],
      ollama: { reachable: loaded.reachable },
      models,
      slots: { local: localSlots, premium: settings.premiumParallelism, busyLocal, busyPremium },
      waiting,
      warnings,
    }
  }

  private record(sample: ResourceSample, gpu: ResourceSnapshot['gpu']) {
    if (this.points.at(-1)?.at === sample.at) return
    this.points.push({ at: sample.at, cpuPct: sample.cpuPct, ramUsedBytes: sample.ramUsedBytes, gpuPct: gpu?.utilizationPct, vramUsedMb: gpu?.vramUsedMb })
    if (this.points.length > HISTORY) this.points.splice(0, this.points.length - HISTORY)
  }
}
