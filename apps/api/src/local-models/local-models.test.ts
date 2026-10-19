import { describe, expect, it, vi } from 'vitest'
import { LocalModelsService } from './local-models.service.js'
import { DEFAULT_SETTINGS } from '../runtime/settings.service.js'
import type { HardwareProfile, OllamaClient } from '@multi-ai-coder/engine'

describe('speculative model warmup', () => {
  it('reserves KV/runtime memory across concurrent callers and matches execution context', async () => {
    const settings = { ...DEFAULT_SETTINGS, modelWarmup: true }
    const service = new LocalModelsService({ get: async () => settings } as never, { publish() {} } as never, {} as never)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const load = vi.fn(() => pending)
    vi.spyOn(service, 'client').mockResolvedValue({ isReachable: async () => true, running: async () => [], load } as unknown as OllamaClient)
    vi.spyOn(service, 'hardware').mockResolvedValue({ memory: { totalBytes: 32 * 1024 ** 3, freeBytes: 16 * 1024 ** 3 }, gpus: [{ name: 'GPU', vendor: 'nvidia', vramTotalMb: 16384, vramReliable: true, vramSource: 'nvidia-smi' }] } as HardwareProfile)
    vi.spyOn(service, 'installed').mockResolvedValue(['A', 'B'].map(name => ({ name, sizeBytes: 6 * 1024 ** 3, capabilities: ['tools'], loaded: false, roles: ['balanced'] })))
    vi.spyOn(service, 'engineProfiles').mockResolvedValue(['A', 'B'].map(model => ({ model, contextWindow: 8192, available: true, toolCalling: true, roles: ['balanced'] })))
    const results = await Promise.all([service.warmup(['A'], 'planning'), service.warmup(['B'], 'plan')])
    expect(results).toEqual([['A'], []])
    expect(load).toHaveBeenCalledExactlyOnceWith('A', '15m', 8192)
    expect(service.warmups).toContainEqual(expect.objectContaining({ model: 'B', skipped: 'memory' }))
    release()
    await pending
  })
})
