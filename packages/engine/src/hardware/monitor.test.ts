import { describe, expect, it } from 'vitest'
import { assessResources, cpuPercent, loadedModelUsage, parseNvidiaSmiUsage, ResourceSampler, type ResourceSample } from './monitor.js'

const GB = 1024 ** 3

describe('resource monitor', () => {
  it('parses nvidia-smi usage rows including unavailable fields', () => {
    const gpus = parseNvidiaSmiUsage('0, NVIDIA GeForce RTX 4060 Ti, 63, 9123, 16380, 54, 87.31, 165.00\n1, Tesla T4, [N/A], 100, 15360, 40, [N/A], [N/A]\n')
    expect(gpus[0]).toEqual({ index: 0, name: 'NVIDIA GeForce RTX 4060 Ti', utilizationPct: 63, vramUsedMb: 9123, vramTotalMb: 16380, temperatureC: 54, powerW: 87.31, powerLimitW: 165 })
    expect(gpus[1]).toMatchObject({ index: 1, utilizationPct: undefined, powerW: undefined, vramUsedMb: 100 })
  })

  it('computes the busy share between two CPU counter snapshots', () => {
    expect(cpuPercent([{ idle: 100, total: 200 }, { idle: 100, total: 200 }], [{ idle: 150, total: 300 }, { idle: 190, total: 300 }])).toBe(30)
    expect(cpuPercent([{ idle: 1, total: 1 }], [{ idle: 1, total: 1 }])).toBe(0)
  })

  it('derives the GPU/CPU split of loaded models and warns about offload', () => {
    const models = loadedModelUsage([
      { name: 'qwen2.5-coder:14b', model: 'qwen2.5-coder:14b', size: 10 * GB, size_vram: 10 * GB, expires_at: '' },
      { name: 'qwen2.5-coder:32b', model: 'qwen2.5-coder:32b', size: 20 * GB, size_vram: 12 * GB, expires_at: '' },
    ])
    expect(models.map((model) => model.gpuShare)).toEqual([1, 0.6])
    const sample: ResourceSample = { at: '', cpuPct: 20, ramUsedBytes: 8 * GB, ramTotalBytes: 32 * GB, gpus: [{ index: 0, name: 'RTX', vramUsedMb: 15_800, vramTotalMb: 16_380 }], gpuSource: 'nvidia-smi' }
    const warnings = assessResources({ sample, models, hasGpu: true })
    expect(warnings.map((warning) => warning.code)).toEqual(['cpu_offload', 'vram_full'])
    expect(warnings[0]!.message).toContain('60 %')
    expect(warnings[1]!.message).toContain('auf die CPU ausgelagert')
  })

  it('attributes full VRAM to other processes when the app models sit fully on the GPU', () => {
    const sample: ResourceSample = { at: '', cpuPct: 5, ramUsedBytes: 8 * GB, ramTotalBytes: 32 * GB, gpus: [{ index: 0, name: 'RTX', vramUsedMb: 15_800, vramTotalMb: 16_380 }], gpuSource: 'nvidia-smi' }
    const models = loadedModelUsage([{ name: 'qwen2.5-coder:7b', model: 'qwen2.5-coder:7b', size: 5 * GB, size_vram: 5 * GB, expires_at: '' }])
    const warnings = assessResources({ sample, models, hasGpu: true })
    expect(warnings.map((warning) => warning.code)).toEqual(['vram_full'])
    expect(warnings[0]!.message).toContain('davon 5,0 GB durch Modelle der App')
    expect(warnings[0]!.message).toContain('anderen Prozessen oder einer anderen Ollama-Instanz')
    expect(warnings[0]!.message).not.toContain('ausgelagert')
    // no app model loaded at all: the whole VRAM belongs to others
    expect(assessResources({ sample, models: [], hasGpu: true })[0]!.message).toContain('davon 0,0 GB')
  })

  it('probes a failed GPU reader again after the retry pause instead of giving up', async () => {
    let now = 0
    let reads = 0
    let available = false
    const sampler = new ResourceSampler({
      now: () => new Date(now),
      readCpu: () => [{ idle: 0, total: 0 }],
      readMemory: () => ({ totalBytes: GB, freeBytes: GB }),
      readGpu: async () => {
        reads += 1
        return available ? [{ index: 0, name: 'GPU', utilizationPct: 40 }] : undefined
      },
      minIntervalMs: 1000,
      gpuRetryMs: 30_000,
    })
    expect(await sampler.sample()).toMatchObject({ gpuSource: 'none' })
    available = true
    for (const at of [1000, 10_000, 29_000]) {
      now = at
      expect((await sampler.sample()).gpuSource).toBe('none')
    }
    expect(reads).toBe(1)
    now = 30_000
    expect(await sampler.sample()).toMatchObject({ gpuSource: 'nvidia-smi', gpus: [{ utilizationPct: 40 }] })
    now = 31_000
    await sampler.sample()
    // telemetry works again: every sample reads the GPU
    expect(reads).toBe(3)
  })

  it('reports missing GPU telemetry instead of guessing', () => {
    const sample: ResourceSample = { at: '', cpuPct: 10, ramUsedBytes: GB, ramTotalBytes: 32 * GB, gpus: [], gpuSource: 'none' }
    expect(assessResources({ sample, models: [], hasGpu: true }).map((warning) => warning.code)).toEqual(['no_gpu_telemetry'])
    expect(assessResources({ sample, models: [], hasGpu: false })).toEqual([])
  })

  it('samples on demand, reuses fresh samples and keeps a bounded history', async () => {
    let now = 0
    let idle = 0
    let gpuReads = 0
    const sampler = new ResourceSampler({
      now: () => new Date(now),
      readCpu: () => [{ idle: (idle += 50), total: idle * 2 }],
      readMemory: () => ({ totalBytes: 32 * GB, freeBytes: 24 * GB }),
      readGpu: async () => {
        gpuReads += 1
        return [{ index: 0, name: 'GPU', utilizationPct: gpuReads }]
      },
      historySize: 3,
      minIntervalMs: 1000,
    })
    const first = await sampler.sample()
    expect(first).toMatchObject({ ramUsedBytes: 8 * GB, gpuSource: 'nvidia-smi', cpuPct: 50 })
    now = 500
    expect(await sampler.sample()).toBe(first)
    for (const at of [1500, 3000, 4500]) {
      now = at
      await sampler.sample()
    }
    expect(gpuReads).toBe(4)
    expect(sampler.samples().map((sample) => sample.gpus[0]!.utilizationPct)).toEqual([2, 3, 4])
  })
})
