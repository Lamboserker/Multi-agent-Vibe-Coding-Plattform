import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveExecutable, runProcess } from '../util/process.js'

export type VramSource = 'nvidia-smi' | 'rocm-smi' | 'registry' | 'unified-memory' | 'wmi-capped' | 'system_profiler' | 'unknown'

export interface GpuInfo {
  name: string
  vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other'
  vramTotalMb?: number
  vramUsedMb?: number
  /** Whether the VRAM figure can be trusted for model sizing decisions. */
  vramReliable: boolean
  vramSource: VramSource
  driver?: string
}

export interface DiskInfo {
  path: string
  freeBytes?: number
  totalBytes?: number
}

export interface HardwareProfile {
  os: { platform: NodeJS.Platform; release: string; arch: string; version?: string }
  cpu: { model: string; physicalCores?: number; logicalCores: number }
  memory: { totalBytes: number; freeBytes: number }
  gpus: GpuInfo[]
  acceleration: Array<'cuda' | 'rocm' | 'metal' | 'vulkan' | 'cpu'>
  disks: { appData?: DiskInfo; ollamaModels?: DiskInfo }
  ollamaModelsDir: string
  detectedAt: string
  warnings: string[]
}

/** Ollama's model directory: OLLAMA_MODELS or ~/.ollama/models (Linux service installs use /usr/share/ollama). */
export function ollamaModelsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OLLAMA_MODELS) return env.OLLAMA_MODELS
  const home = path.join(os.homedir(), '.ollama', 'models')
  if (process.platform === 'linux' && !existsSync(home) && existsSync('/usr/share/ollama/.ollama/models')) {
    return '/usr/share/ollama/.ollama/models'
  }
  return home
}

export async function diskInfo(target: string): Promise<DiskInfo> {
  let probe = path.resolve(target)
  while (!existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  try {
    const stats = await fs.statfs(probe)
    return { path: target, freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) }
  } catch {
    return { path: target }
  }
}

export function parseNvidiaSmi(csv: string): GpuInfo[] {
  return csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, total, used, driver] = line.split(',').map((part) => part.trim())
      return {
        name: name ?? 'NVIDIA GPU',
        vendor: 'nvidia' as const,
        vramTotalMb: Number(total) || undefined,
        vramUsedMb: Number(used) || undefined,
        vramReliable: Number(total) > 0,
        vramSource: 'nvidia-smi' as const,
        driver,
      }
    })
}

function vendorOf(name: string): GpuInfo['vendor'] {
  if (/nvidia|geforce|rtx|quadro|tesla/i.test(name)) return 'nvidia'
  if (/amd|radeon|ati /i.test(name)) return 'amd'
  if (/intel|iris|arc/i.test(name)) return 'intel'
  if (/apple/i.test(name)) return 'apple'
  return 'other'
}

async function nvidiaGpus(): Promise<GpuInfo[]> {
  const candidates = ['nvidia-smi']
  if (process.platform === 'win32') candidates.push('C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe')
  for (const candidate of candidates) {
    if (!resolveExecutable(candidate) && !existsSync(candidate)) continue
    const result = await runProcess(candidate, ['--query-gpu=name,memory.total,memory.used,driver_version', '--format=csv,noheader,nounits'], { timeoutMs: 8000 })
    if (result.exitCode === 0 && result.stdout.trim()) return parseNvidiaSmi(result.stdout)
  }
  return []
}

async function windowsGpus(): Promise<GpuInfo[]> {
  // Win32_VideoController.AdapterRAM is a 32-bit field capped at 4 GB; the driver registry key
  // HardwareInformation.qwMemorySize carries the real 64-bit value for most vendors.
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$out=@()',
    "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | ForEach-Object {",
    "  if ($_.DriverDesc) { $out += [pscustomobject]@{ name=$_.DriverDesc; bytes=$_.'HardwareInformation.qwMemorySize'; source='registry'; driver=$_.DriverVersion } } }",
    'if ($out.Count -eq 0) { Get-CimInstance Win32_VideoController | ForEach-Object { $out += [pscustomobject]@{ name=$_.Name; bytes=$_.AdapterRAM; source=\'wmi\'; driver=$_.DriverVersion } } }',
    '$out | ConvertTo-Json -Compress',
  ].join('\n')
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15_000 })
  if (result.exitCode !== 0 || !result.stdout.trim()) return []
  try {
    const parsed = JSON.parse(result.stdout.trim()) as unknown
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ name?: string; bytes?: number | number[]; source?: string; driver?: string }>
    const seen = new Set<string>()
    return rows
      .filter((row) => row.name && !/basic display|remote display|virtual/i.test(row.name))
      .filter((row) => (seen.has(row.name!) ? false : (seen.add(row.name!), true)))
      .map((row) => {
        const bytes = Array.isArray(row.bytes) ? row.bytes[0] : row.bytes
        const mb = bytes ? Math.round(Number(bytes) / 1024 / 1024) : undefined
        const capped = row.source === 'wmi'
        return {
          name: row.name!,
          vendor: vendorOf(row.name!),
          vramTotalMb: mb,
          vramReliable: Boolean(mb) && !capped,
          vramSource: capped ? ('wmi-capped' as const) : ('registry' as const),
          driver: row.driver,
        }
      })
  } catch {
    return []
  }
}

async function macGpus(totalMemory: number): Promise<GpuInfo[]> {
  const result = await runProcess('system_profiler', ['SPDisplaysDataType', '-json'], { timeoutMs: 15_000 })
  const appleSilicon = process.arch === 'arm64'
  try {
    const parsed = JSON.parse(result.stdout) as { SPDisplaysDataType?: Array<{ sppci_model?: string; spdisplays_vram?: string; _name?: string }> }
    return (parsed.SPDisplaysDataType ?? []).map((gpu) => {
      const name = gpu.sppci_model ?? gpu._name ?? 'GPU'
      if (appleSilicon) {
        return { name, vendor: 'apple' as const, vramTotalMb: Math.round((totalMemory / 1024 / 1024) * 0.7), vramReliable: true, vramSource: 'unified-memory' as const }
      }
      const vram = gpu.spdisplays_vram?.match(/(\d+)\s*(GB|MB)/i)
      const mb = vram ? Number(vram[1]) * (vram[2]!.toUpperCase() === 'GB' ? 1024 : 1) : undefined
      return { name, vendor: vendorOf(name), vramTotalMb: mb, vramReliable: Boolean(mb), vramSource: 'system_profiler' as const }
    })
  } catch {
    return appleSilicon
      ? [{ name: 'Apple Silicon GPU', vendor: 'apple', vramTotalMb: Math.round((totalMemory / 1024 / 1024) * 0.7), vramReliable: true, vramSource: 'unified-memory' }]
      : []
  }
}

async function linuxAmdGpus(): Promise<GpuInfo[]> {
  if (!resolveExecutable('rocm-smi')) return []
  const result = await runProcess('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json'], { timeoutMs: 10_000 })
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, Record<string, string>>
    return Object.values(parsed).map((card) => {
      const total = Number(card['VRAM Total Memory (B)'] ?? 0)
      const used = Number(card['VRAM Total Used Memory (B)'] ?? 0)
      return {
        name: card['Card series'] ?? card['Card model'] ?? 'AMD GPU',
        vendor: 'amd' as const,
        vramTotalMb: total ? Math.round(total / 1024 / 1024) : undefined,
        vramUsedMb: used ? Math.round(used / 1024 / 1024) : undefined,
        vramReliable: total > 0,
        vramSource: 'rocm-smi' as const,
      }
    })
  } catch {
    return []
  }
}

export async function detectHardware(options: { appDataDir?: string; ollamaModelsDir?: string } = {}): Promise<HardwareProfile> {
  const warnings: string[] = []
  const cpus = os.cpus()
  const totalMemory = os.totalmem()

  let gpus: GpuInfo[] = await nvidiaGpus().catch(() => [])
  if (process.platform === 'win32') {
    const others = await windowsGpus().catch(() => [])
    for (const gpu of others) {
      if (gpu.vendor === 'nvidia' && gpus.some((existing) => existing.vendor === 'nvidia')) continue
      gpus.push(gpu)
    }
  } else if (process.platform === 'darwin') {
    gpus = [...gpus, ...(await macGpus(totalMemory).catch(() => []))]
  } else {
    gpus = [...gpus, ...(await linuxAmdGpus().catch(() => []))]
  }
  for (const gpu of gpus) {
    if (!gpu.vramReliable) warnings.push(`VRAM of "${gpu.name}" could not be determined reliably (${gpu.vramSource}); model sizing treats it as unknown.`)
  }

  const acceleration: HardwareProfile['acceleration'] = []
  if (gpus.some((gpu) => gpu.vendor === 'nvidia')) acceleration.push('cuda')
  if (gpus.some((gpu) => gpu.vendor === 'amd') && process.platform === 'linux') acceleration.push('rocm')
  if (gpus.some((gpu) => gpu.vendor === 'apple')) acceleration.push('metal')
  if (gpus.some((gpu) => gpu.vendor === 'amd' || gpu.vendor === 'intel') && process.platform === 'win32') acceleration.push('vulkan')
  acceleration.push('cpu')

  const modelsDir = options.ollamaModelsDir || ollamaModelsDirectory()
  const [appData, ollamaModels] = await Promise.all([
    options.appDataDir ? diskInfo(options.appDataDir) : Promise.resolve(undefined),
    diskInfo(modelsDir),
  ])
  if (ollamaModels.freeBytes !== undefined && ollamaModels.freeBytes < 10 * 1024 ** 3) {
    warnings.push(
      `Only ${(ollamaModels.freeBytes / 1024 ** 3).toFixed(1)} GB free on the drive holding Ollama models (${modelsDir}). Set OLLAMA_MODELS to a larger drive before downloading bigger models.`,
    )
  }

  let physicalCores: number | undefined
  if (process.platform === 'win32') {
    const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum'], { timeoutMs: 10_000 })
    physicalCores = Number(result.stdout.trim()) || undefined
  }

  return {
    os: { platform: process.platform, release: os.release(), arch: process.arch, version: typeof os.version === 'function' ? os.version() : undefined },
    cpu: { model: cpus[0]?.model.trim() ?? 'unknown', physicalCores, logicalCores: cpus.length },
    memory: { totalBytes: totalMemory, freeBytes: os.freemem() },
    gpus,
    acceleration,
    disks: { appData, ollamaModels },
    ollamaModelsDir: modelsDir,
    detectedAt: new Date().toISOString(),
    warnings,
  }
}

/** Usable accelerator memory in MB (largest reliable GPU), or undefined if unknown / CPU only. */
export function usableVramMb(profile: HardwareProfile): number | undefined {
  const reliable = profile.gpus.filter((gpu) => gpu.vramReliable && gpu.vramTotalMb)
  if (!reliable.length) return undefined
  return Math.max(...reliable.map((gpu) => gpu.vramTotalMb!))
}
