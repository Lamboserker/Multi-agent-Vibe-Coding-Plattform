import { existsSync } from 'node:fs'
import os from 'node:os'
import type { OllamaRunningModel } from '../ollama/client.js'
import { resolveExecutable, runProcess } from '../util/process.js'

/*
 * Live resource monitor: CPU, RAM, GPU load/VRAM and how the loaded Ollama models are split between
 * GPU and CPU. Everything measured is labelled with its source; values that cannot be measured on
 * this machine stay undefined instead of being guessed.
 */

export interface GpuUsage {
  index: number
  name: string
  utilizationPct?: number
  vramUsedMb?: number
  vramTotalMb?: number
  temperatureC?: number
  powerW?: number
  powerLimitW?: number
}

export interface ResourceSample {
  at: string
  cpuPct: number
  ramUsedBytes: number
  ramTotalBytes: number
  gpus: GpuUsage[]
  /** Where the GPU figures come from ('none' = no live GPU telemetry on this machine). */
  gpuSource: 'nvidia-smi' | 'none'
}

export interface LoadedModelUsage {
  name: string
  sizeBytes: number
  vramBytes: number
  /** Share of the model held in VRAM (1 = fully on the GPU). */
  gpuShare: number
  contextLength?: number
  expiresAt?: string
}

export interface ResourceWarning {
  code: 'vram_full' | 'cpu_offload' | 'ram_high' | 'cpu_high' | 'gpu_hot' | 'no_gpu_telemetry'
  severity: 'info' | 'warn' | 'error'
  message: string
  model?: string
}

const number = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value.trim())
  return value.trim() && Number.isFinite(parsed) ? parsed : undefined
}

export const NVIDIA_USAGE_QUERY = 'index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit'

/** Parses `nvidia-smi --query-gpu=<NVIDIA_USAGE_QUERY> --format=csv,noheader,nounits` ("[N/A]" → undefined). */
export function parseNvidiaSmiUsage(csv: string): GpuUsage[] {
  return csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, position) => {
      const [index, name, util, used, total, temperature, power, limit] = line.split(',').map((part) => part.trim())
      return {
        index: number(index) ?? position,
        name: name || 'NVIDIA GPU',
        utilizationPct: number(util),
        vramUsedMb: number(used),
        vramTotalMb: number(total),
        temperatureC: number(temperature),
        powerW: number(power),
        powerLimitW: number(limit),
      }
    })
}

export type CpuTimes = Array<{ idle: number; total: number }>

export function cpuTimes(cpus: os.CpuInfo[] = os.cpus()): CpuTimes {
  return cpus.map((cpu) => {
    const { user, nice, sys, idle, irq } = cpu.times
    return { idle, total: user + nice + sys + idle + irq }
  })
}

/** Busy share of all cores between two snapshots of the CPU counters (0–100). */
export function cpuPercent(previous: CpuTimes, next: CpuTimes): number {
  let idle = 0
  let total = 0
  for (let index = 0; index < Math.min(previous.length, next.length); index += 1) {
    idle += next[index]!.idle - previous[index]!.idle
    total += next[index]!.total - previous[index]!.total
  }
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 1000) / 10))
}

/** GPU/CPU split of the models Ollama currently holds in memory (`/api/ps`). */
export function loadedModelUsage(running: OllamaRunningModel[]): LoadedModelUsage[] {
  return running.map((model) => {
    const size = Math.max(0, model.size ?? 0)
    const vram = Math.max(0, Math.min(size, model.size_vram ?? 0))
    return {
      name: model.name || model.model,
      sizeBytes: size,
      vramBytes: vram,
      gpuShare: size > 0 ? Math.round((vram / size) * 1000) / 1000 : 0,
      contextLength: model.context_length,
      expiresAt: model.expires_at,
    }
  })
}

export function assessResources(input: { sample: ResourceSample; models: LoadedModelUsage[]; hasGpu: boolean }): ResourceWarning[] {
  const { sample, models } = input
  const warnings: ResourceWarning[] = []
  for (const model of models) {
    if (model.sizeBytes > 0 && model.gpuShare < 0.98) {
      const gpu = Math.round(model.gpuShare * 100)
      warnings.push({
        code: 'cpu_offload',
        severity: 'warn',
        model: model.name,
        message: gpu > 0 ? `${model.name} läuft nur zu ${gpu} % auf der GPU, der Rest auf der CPU – Inferenz ist dadurch deutlich langsamer.` : `${model.name} läuft vollständig auf der CPU.`,
      })
    }
  }
  for (const gpu of sample.gpus) {
    if (gpu.vramTotalMb && gpu.vramUsedMb !== undefined && gpu.vramUsedMb / gpu.vramTotalMb >= 0.95) {
      warnings.push({ code: 'vram_full', severity: 'warn', message: `VRAM von ${gpu.name} ist zu ${Math.round((gpu.vramUsedMb / gpu.vramTotalMb) * 100)} % belegt. Weitere Modelle werden teilweise auf die CPU ausgelagert.` })
    }
    if (gpu.temperatureC !== undefined && gpu.temperatureC >= 85) warnings.push({ code: 'gpu_hot', severity: 'warn', message: `${gpu.name} ist ${gpu.temperatureC} °C warm; die GPU kann drosseln.` })
  }
  if (sample.ramTotalBytes > 0 && sample.ramUsedBytes / sample.ramTotalBytes >= 0.92) {
    warnings.push({ code: 'ram_high', severity: 'warn', message: `Arbeitsspeicher zu ${Math.round((sample.ramUsedBytes / sample.ramTotalBytes) * 100)} % belegt.` })
  }
  if (sample.cpuPct >= 95) warnings.push({ code: 'cpu_high', severity: 'info', message: `CPU-Auslastung ${Math.round(sample.cpuPct)} %.` })
  if (input.hasGpu && sample.gpuSource === 'none') {
    warnings.push({ code: 'no_gpu_telemetry', severity: 'info', message: 'Für diese GPU gibt es keine Live-Werte (nvidia-smi fehlt). VRAM wird aus den von Ollama gemeldeten Modellgrößen abgeleitet.' })
  }
  return warnings
}

async function readNvidiaUsage(): Promise<GpuUsage[] | undefined> {
  const candidates = ['nvidia-smi']
  if (process.platform === 'win32') candidates.push('C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe')
  for (const candidate of candidates) {
    if (!resolveExecutable(candidate) && !existsSync(candidate)) continue
    const result = await runProcess(candidate, [`--query-gpu=${NVIDIA_USAGE_QUERY}`, '--format=csv,noheader,nounits'], { timeoutMs: 4000 })
    if (result.exitCode === 0 && result.stdout.trim()) return parseNvidiaSmiUsage(result.stdout)
  }
  return undefined
}

export interface ResourceSamplerOptions {
  /** Replaces nvidia-smi (tests, other vendors). Returning undefined means "no telemetry". */
  readGpu?: () => Promise<GpuUsage[] | undefined>
  readCpu?: () => CpuTimes
  readMemory?: () => { totalBytes: number; freeBytes: number }
  now?: () => Date
  historySize?: number
  /** Samples requested more often than this reuse the last one. */
  minIntervalMs?: number
}

/**
 * Samples on demand (no background timer): every request older than `minIntervalMs` takes a new
 * sample, so the monitor costs nothing while nobody looks at it. The history keeps the last samples.
 */
export class ResourceSampler {
  private previousCpu: CpuTimes
  private readonly history: ResourceSample[] = []
  private inflight?: Promise<ResourceSample>
  private gpuAvailable = true

  constructor(private readonly options: ResourceSamplerOptions = {}) {
    this.previousCpu = (options.readCpu ?? cpuTimes)()
  }

  samples(): ResourceSample[] {
    return [...this.history]
  }

  latest(): ResourceSample | undefined {
    return this.history.at(-1)
  }

  async sample(): Promise<ResourceSample> {
    const last = this.latest()
    const now = (this.options.now ?? (() => new Date()))()
    if (last && now.getTime() - Date.parse(last.at) < (this.options.minIntervalMs ?? 1000)) return last
    this.inflight ??= this.take(now).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async take(now: Date): Promise<ResourceSample> {
    const readGpu = this.options.readGpu ?? readNvidiaUsage
    // a machine without nvidia-smi is not probed again on every sample
    const gpus = this.gpuAvailable ? await readGpu().catch(() => undefined) : undefined
    if (!this.options.readGpu && gpus === undefined) this.gpuAvailable = false
    const cpu = (this.options.readCpu ?? cpuTimes)()
    const memory = (this.options.readMemory ?? (() => ({ totalBytes: os.totalmem(), freeBytes: os.freemem() })))()
    const sample: ResourceSample = {
      at: now.toISOString(),
      cpuPct: cpuPercent(this.previousCpu, cpu),
      ramUsedBytes: Math.max(0, memory.totalBytes - memory.freeBytes),
      ramTotalBytes: memory.totalBytes,
      gpus: gpus ?? [],
      gpuSource: gpus ? 'nvidia-smi' : 'none',
    }
    this.previousCpu = cpu
    this.history.push(sample)
    const limit = this.options.historySize ?? 40
    if (this.history.length > limit) this.history.splice(0, this.history.length - limit)
    return sample
  }
}
