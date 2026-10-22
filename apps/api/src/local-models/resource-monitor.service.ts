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
  type OllamaRunningModel,
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

export type MonitoredModel = LoadedModelUsage & {
  agents: string[]
  /** app = the instance the app works with (ollamaBaseUrl); external = another local Ollama instance. */
  instance: 'app' | 'external'
  baseUrl: string
  /** generating = active agents use it; idle = loaded without work; external = held by the other instance. */
  state: 'generating' | 'idle' | 'external'
  /** Seconds until Ollama unloads the model (keep_alive), null without a known expiry. */
  unloadsInSec: number | null
}

export interface ResourceSnapshot {
  at: string
  /** Time of the sample (ms since epoch) and the sampling cadence: the client derives "live"/"stale" from it. */
  sampledAt: number
  intervalMs: number
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
  models: MonitoredModel[]
  /** VRAM held by the app instance's models and the rest (other processes/instances), in GB. */
  vram: { appModelsGb: number; otherGb: number | null }
  slots: { local: number; premium: number; busyLocal: number; busyPremium: number }
  /** Local subtasks of active runs that wait for a slot or for their model. */
  waiting: Array<{ key: string; title: string; model?: string; reason: string }>
  warnings: ResourceWarning[]
}

const ENERGY_INTERVAL_MS = 10_000
/** Cadence of the history while a client polls the monitor. */
const LIVE_INTERVAL_MS = 1000
/** The live sampler stops when no client asked for this long (window hidden or monitor closed). */
const LIVE_IDLE_MS = 5000
/** The other Ollama instance must not hold up the snapshot. */
const EXTRA_INSTANCE_TIMEOUT_MS = 1500

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    timer.unref?.()
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })

/**
 * Live hardware load for the resource monitor. While a client polls (the renderer pauses when the
 * window is hidden), a 1 s sampler fills the history so the sparklines have no holes; it stops 5 s
 * after the last request. Otherwise only the 10 s energy meter samples.
 */

@Injectable()
export class ResourceMonitorService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('ResourceMonitor')
  private ledger: EnergyLedger = emptyLedger()
  private lastEnergy?: { at: Date; reading: PowerReading; inferenceActive: boolean }
  private energyTimer?: NodeJS.Timeout
  private ledgerDirty = false
  private savedAt = 0
  private ledgerFile?: string
  // slightly below the live cadence: timer jitter must not make every other tick reuse the last sample
  private readonly sampler = new ResourceSampler({ historySize: HISTORY, minIntervalMs: LIVE_INTERVAL_MS - 100 })
  private readonly points: ResourcePoint[] = []
  private running?: { at: number; reachable: boolean; models: Array<LoadedModelUsage & { instance: 'app' | 'external'; baseUrl: string }> }
  private liveTimer?: NodeJS.Timeout
  private lastRequestAt = 0
  /** VRAM from Ollama's model sizes when there is no nvidia-smi (stands in for history points of the live sampler). */
  private fallbackVramMb?: number

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
    this.stopLive()
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

  /** Keeps the 1 s sampler running while clients ask; it ends itself after LIVE_IDLE_MS without a request. */
  private keepLive() {
    this.lastRequestAt = Date.now()
    if (this.liveTimer) return
    this.liveTimer = setInterval(() => {
      if (Date.now() - this.lastRequestAt > LIVE_IDLE_MS) return this.stopLive()
      void this.sampler
        .sample()
        .then((sample) => this.record(sample, this.fallbackVramMb))
        .catch((error: unknown) => this.logger.warn(`live sample failed: ${String(error)}`))
    }, LIVE_INTERVAL_MS)
    this.liveTimer.unref?.()
  }

  private stopLive() {
    if (this.liveTimer) clearInterval(this.liveTimer)
    this.liveTimer = undefined
  }

  /** Loaded models of the app instance and (best effort, failures ignored) of the other local instances. */
  private async loadedModels() {
    if (this.running && Date.now() - this.running.at < 2000) return this.running
    const ps = (promise: Promise<OllamaRunningModel[]>) => promise.then((models) => ({ ok: true, models }), () => ({ ok: false, models: [] as OllamaRunningModel[] }))
    const [app, extras] = await Promise.all([this.localModels.client(), this.localModels.extraClients().catch(() => [])])
    const [own, ...others] = await Promise.all([ps(app.running()), ...extras.map((client) => ps(withTimeout(client.running(), EXTRA_INSTANCE_TIMEOUT_MS)))])
    const models = [
      ...loadedModelUsage(own!.models).map((model) => ({ ...model, instance: 'app' as const, baseUrl: app.baseUrl })),
      ...others.flatMap((result, index) => loadedModelUsage(result.models).map((model) => ({ ...model, instance: 'external' as const, baseUrl: extras[index]!.baseUrl }))),
    ]
    this.running = { at: Date.now(), reachable: own!.ok, models }
    return this.running
  }

  private async activeSubtasks() {
    return this.prisma.subtask.findMany({
      where: { status: { in: ['queued', 'running', 'validating', 'repairing'] }, task: { executions: { some: { status: { in: [...ACTIVE_RUNS] } } } } },
      select: { key: true, title: true, status: true, selectedModelClass: true, selectedModelName: true, manualModel: true },
      orderBy: [{ createdAt: 'asc' }, { priority: 'desc' }],
    })
  }

  /** Running local agent attempts of active runs (an escalation may use another model than its subtask's). */
  private async activeAgentRuns() {
    return this.prisma.agentRun.findMany({
      where: { status: 'running', selectedModelClass: 'local_llm', execution: { status: { in: [...ACTIVE_RUNS] } } },
      select: { selectedModelName: true, subtask: { select: { key: true } } },
    })
  }

  async snapshot(): Promise<ResourceSnapshot> {
    this.keepLive()
    const [sample, hardware, loaded, subtasks, localSlots, settings, agentRuns] = await Promise.all([
      this.sampler.sample(),
      this.localModels.hardware(),
      this.loadedModels(),
      this.activeSubtasks().catch(() => []),
      this.localModels.localSlots().catch(() => 1),
      this.settings.get(),
      this.activeAgentRuns().catch(() => []),
    ])
    const local = (subtask: (typeof subtasks)[number]) => subtask.selectedModelClass === 'local_llm' && subtask.manualModel !== 'premium'
    const working = subtasks.filter((subtask) => WORKING.includes(subtask.status))
    const now = Date.now()
    // a subtask with a running attempt works with that attempt's model (an escalation may use a bigger one)
    const attempting = new Set(agentRuns.map((run) => run.subtask?.key).filter((key): key is string => Boolean(key)))
    const models: MonitoredModel[] = loaded.models.map((model) => {
      const agents = model.instance === 'app'
        ? [...new Set([
            ...working.filter((subtask) => local(subtask) && !attempting.has(subtask.key) && subtask.selectedModelName === model.name).map((subtask) => subtask.key),
            ...agentRuns.filter((run) => run.selectedModelName === model.name).map((run) => run.subtask?.key ?? 'Agent'),
          ])]
        : []
      const expires = model.expiresAt ? Date.parse(model.expiresAt) : Number.NaN
      // keep_alive -1 shows up as an expiry centuries ahead: that is "never", not a countdown
      const unloadsInSec = Number.isFinite(expires) && expires - now < 7 * 86_400_000 ? Math.max(0, Math.round((expires - now) / 1000)) : null
      return { ...model, agents, state: model.instance === 'external' ? 'external' : agents.length ? 'generating' : 'idle', unloadsInSec }
    })
    const appModels = models.filter((model) => model.instance === 'app')
    const busyLocal = working.filter(local).length
    const busyPremium = working.length - busyLocal

    const profileGpu = [...hardware.gpus].sort((a, b) => (b.vramTotalMb ?? 0) - (a.vramTotalMb ?? 0))[0]
    const measured = sample.gpus[0]
    const appModelsVramMb = Math.round(appModels.reduce((sum, model) => sum + model.vramBytes, 0) / MB)
    // without nvidia-smi: the models of every instance share the same card
    const modelsVramMb = Math.round(models.reduce((sum, model) => sum + model.vramBytes, 0) / MB)
    const gpu: ResourceSnapshot['gpu'] = measured
      ? { name: measured.name, utilizationPct: measured.utilizationPct, vramUsedMb: measured.vramUsedMb, vramTotalMb: measured.vramTotalMb ?? profileGpu?.vramTotalMb, temperatureC: measured.temperatureC, powerW: measured.powerW, powerLimitW: measured.powerLimitW, source: 'nvidia-smi' }
      : profileGpu
        ? { name: profileGpu.name, vramTotalMb: profileGpu.vramReliable ? profileGpu.vramTotalMb : undefined, vramUsedMb: loaded.reachable ? modelsVramMb : undefined, source: loaded.reachable ? 'ollama' : 'none' }
        : undefined

    this.fallbackVramMb = gpu?.source === 'ollama' ? gpu.vramUsedMb : undefined
    this.record(sample, this.fallbackVramMb)

    const waiting = subtasks
      .filter((subtask) => subtask.status === 'queued' && local(subtask))
      .map((subtask) => {
        const resident = appModels.some((model) => model.name === subtask.selectedModelName)
        const reason = busyLocal >= localSlots
          ? `wartet auf einen freien lokalen Slot (${busyLocal}/${localSlots} belegt)`
          : !resident && gpu?.vramTotalMb && gpu.vramUsedMb !== undefined && gpu.vramUsedMb / gpu.vramTotalMb > 0.85
            ? 'wartet, bis genug VRAM für das Modell frei ist'
            : 'wartet auf Abhängigkeiten oder den Scheduler'
        return { key: subtask.key, title: subtask.title, model: subtask.selectedModelName ?? undefined, reason }
      })

    const warnings = assessResources({ sample, models: appModels, hasGpu: Boolean(profileGpu) })
    const vram = usableVramMb(hardware)
    if (vram && settings.localParallelism !== 'auto' && settings.localParallelism > 1 && localSlots > 1 && appModelsVramMb > vram * 0.95) {
      warnings.push({ code: 'vram_full', severity: 'warn', message: `Die feste Parallelität (${settings.localParallelism}) überschreitet den VRAM; Modelle werden ausgelagert.` })
    }

    const gbOf = (mb: number) => Math.round((mb / 1024) * 10) / 10
    return {
      at: sample.at,
      sampledAt: Date.parse(sample.at),
      intervalMs: this.liveTimer ? LIVE_INTERVAL_MS : ENERGY_INTERVAL_MS,
      cpu: { pct: sample.cpuPct, model: hardware.cpu.model, logicalCores: hardware.cpu.logicalCores, physicalCores: hardware.cpu.physicalCores },
      ram: { usedBytes: sample.ramUsedBytes, totalBytes: sample.ramTotalBytes },
      gpu,
      disk: hardware.disks.ollamaModels,
      history: [...this.points],
      ollama: { reachable: loaded.reachable },
      models,
      vram: { appModelsGb: gbOf(appModelsVramMb), otherGb: gpu?.vramUsedMb === undefined ? null : gbOf(Math.max(0, gpu.vramUsedMb - appModelsVramMb)) },
      slots: { local: localSlots, premium: settings.premiumParallelism, busyLocal, busyPremium },
      waiting,
      warnings,
    }
  }

  /** Adds a sample to the history once; fallbackVramMb stands in for VRAM when nvidia-smi gave no value. */
  private record(sample: ResourceSample, fallbackVramMb?: number) {
    if (this.points.some((point) => point.at === sample.at)) return
    const measured = sample.gpus[0]
    this.points.push({ at: sample.at, cpuPct: sample.cpuPct, ramUsedBytes: sample.ramUsedBytes, gpuPct: measured?.utilizationPct, vramUsedMb: measured ? measured.vramUsedMb : fallbackVramMb })
    // a request and a live tick may resolve out of order
    this.points.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    if (this.points.length > HISTORY) this.points.splice(0, this.points.length - HISTORY)
  }
}
