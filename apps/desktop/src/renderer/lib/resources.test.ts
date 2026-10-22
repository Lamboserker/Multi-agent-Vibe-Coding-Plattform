import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResourceModel, ResourceSnapshot } from './types'

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }))
vi.mock('./api', () => ({ api: { post: mocks.post, get: mocks.get }, enc: encodeURIComponent, errorMessage: (error: unknown) => String(error) }))
import { liveLabel, modelStatus, resourceMetrics, resourceStore, unloadAllModels, unloadModel } from './resources'

const GB = 1024 ** 3

function model(patch: Partial<ResourceModel> = {}): ResourceModel {
  return { name: 'qwen2.5-coder:7b', sizeBytes: 5 * GB, vramBytes: 5 * GB, gpuShare: 1, agents: [], instance: 'app', baseUrl: 'http://127.0.0.1:11435', state: 'idle', unloadsInSec: 720, ...patch }
}

function snapshot(patch: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    at: '2026-10-21T10:00:00.000Z',
    sampledAt: Date.parse('2026-10-21T10:00:00.000Z'),
    intervalMs: 1000,
    cpu: { pct: 10, model: 'CPU', logicalCores: 16 },
    ram: { usedBytes: 8 * GB, totalBytes: 32 * GB },
    gpu: { name: 'NVIDIA GeForce RTX 4080', utilizationPct: 20, vramUsedMb: 8192, vramTotalMb: 16384, source: 'nvidia-smi' },
    history: [
      { at: 'a', cpuPct: 10, ramUsedBytes: 8 * GB, gpuPct: 50, vramUsedMb: 8192 },
      // nvidia-smi gave nothing for this sample
      { at: 'b', cpuPct: 12, ramUsedBytes: 8 * GB },
      { at: 'c', cpuPct: 14, ramUsedBytes: 8 * GB, gpuPct: 0, vramUsedMb: 4096 },
    ],
    ollama: { reachable: true },
    models: [model()],
    vram: { appModelsGb: 5, otherGb: 3 },
    slots: { local: 1, premium: 1, busyLocal: 0, busyPremium: 0 },
    waiting: [],
    warnings: [],
    ...patch,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('document', { hidden: false })
  mocks.get.mockResolvedValue(snapshot())
  mocks.post.mockResolvedValue({ ok: true })
})

describe('resource monitor helpers', () => {
  it('draws a missing GPU sample as a gap instead of 0', () => {
    const metrics = Object.fromEntries(resourceMetrics(snapshot()).map((metric) => [metric.id, metric]))
    expect(metrics.gpu!.bars).toEqual([50, null, 0])
    expect(metrics.vram!.bars).toEqual([50, null, 25])
    expect(metrics.cpu!.bars).toEqual([10, 12, 14])
    expect(metrics.vram!.sub).toBe('davon App-Modelle 5,0 GB · Sonstige 3,0 GB')
  })

  it('keeps the model count as VRAM note without a VRAM figure', () => {
    const metrics = resourceMetrics(snapshot({ vram: { appModelsGb: 5, otherGb: null } }))
    expect(metrics.find((metric) => metric.id === 'vram')!.sub).toBe('1 Modell')
  })

  it('derives the live label from the sample time and cadence', () => {
    const sampledAt = Date.parse('2026-10-21T10:00:00.000Z')
    expect(liveLabel({ sampledAt, intervalMs: 1000 }, sampledAt + 800)).toEqual({ text: 'live · 1,0 s', live: true })
    expect(liveLabel({ sampledAt, intervalMs: 10_000 }, sampledAt + 2000).text).toBe('live · 10,0 s')
    expect(liveLabel({ sampledAt, intervalMs: 1000 }, sampledAt + 5001)).toEqual({ text: 'veraltet', live: false })
    expect(liveLabel(undefined).live).toBe(false)
  })

  it('describes the model state honestly', () => {
    expect(modelStatus(model({ state: 'generating', agents: ['task-007'] })).text).toBe('generiert · task-007')
    expect(modelStatus(model({ unloadsInSec: 720 })).text).toBe('im Leerlauf · entlädt in 12 min')
    expect(modelStatus(model({ unloadsInSec: 40 })).text).toBe('im Leerlauf · entlädt in 40 s')
    expect(modelStatus(model({ unloadsInSec: null })).text).toBe('im Leerlauf')
    expect(modelStatus(model({ state: 'external', instance: 'external' })).text).toBe('andere Ollama-Instanz')
  })

  it('unloads one or all app models and refreshes the snapshot', async () => {
    await unloadModel('qwen2.5-coder:7b')
    expect(mocks.post).toHaveBeenCalledWith('/local-models/qwen2.5-coder%3A7b/unload')
    expect(mocks.get).toHaveBeenCalledWith('/system/resources')
    mocks.post.mockClear()
    await unloadAllModels(snapshot({ models: [model(), model({ name: 'devstral:24b' }), model({ name: 'llama3:8b', instance: 'external', state: 'external' })] }))
    expect(mocks.post.mock.calls.map(([path]) => path)).toEqual(['/local-models/qwen2.5-coder%3A7b/unload', '/local-models/devstral%3A24b/unload'])
    expect(resourceStore.get().snapshot?.sampledAt).toBe(Date.parse('2026-10-21T10:00:00.000Z'))
  })
})
