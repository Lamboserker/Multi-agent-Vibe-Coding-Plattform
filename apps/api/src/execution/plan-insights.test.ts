import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ResourceMonitorService } from '../local-models/resource-monitor.service.js'
import { PlanInsightsService } from './plan-insights.service.js'

const GB = 1024 ** 3

function subtask(key: string, patch: Record<string, unknown> = {}) {
  return { id: `id-${key}`, key, taskId: 'task', title: key, status: 'planned', category: 'implementation', selectedModelClass: 'local_llm', selectedModelName: 'qwen2.5-coder:14b', manualModel: null, fastPath: null, dependsOn: [], allowedFiles: [`src/${key}.ts`], newFiles: [], acceptanceCriteria: [], ...patch }
}

function fixture(subtasks: ReturnType<typeof subtask>[], extra: { executions?: unknown[]; run?: unknown } = {}) {
  const prisma = {
    subtask: {
      findMany: vi.fn().mockResolvedValue(subtasks),
      findUnique: vi.fn().mockImplementation(async ({ where }) => {
        const found = subtasks.find((entry) => entry.id === where.id)
        return found ? { ...found, task: { id: 'task', sessionId: 'session', executions: extra.executions ?? [] } } : null
      }),
      update: vi.fn().mockImplementation(async ({ where, data }) => ({ ...subtasks.find((entry) => entry.id === where.id), ...data })),
    },
    executionRun: { findUnique: vi.fn().mockResolvedValue(extra.run ?? null) },
  }
  const settings = { get: vi.fn().mockResolvedValue({ numCtx: 16384, premiumParallelism: 1, localParallelism: 'auto' }) }
  const hardware = { cpu: { model: 'Ryzen', logicalCores: 16 }, gpus: [{ name: 'RTX', vendor: 'nvidia', vramTotalMb: 16_384, vramReliable: true, vramSource: 'nvidia-smi' }], memory: { totalBytes: 32 * GB, freeBytes: 20 * GB }, disks: {}, ollamaModelsDir: 'D:/models' }
  const localModels = {
    hardware: vi.fn().mockResolvedValue(hardware),
    localSlots: vi.fn().mockResolvedValue(2),
    installed: vi.fn().mockResolvedValue([{ name: 'qwen2.5-coder:14b', sizeBytes: 9 * GB, contextLength: 32768 }, { name: 'deepseek-coder-v2:16b', sizeBytes: 9 * GB, contextLength: 32768 }]),
  }
  const executions = { suitability: vi.fn().mockResolvedValue([{ model: 'qwen2.5-coder:14b', category: 'implementation', attempts: 4, avgDurationMs: 30_000 }]) }
  const events = { publish: vi.fn() }
  const service = new PlanInsightsService(prisma as never, settings as never, localModels as never, executions as never, events as never)
  return { service, prisma, events, localModels }
}

describe('PlanInsightsService', () => {
  it('forecasts waves with measured durations, VRAM-aware batching and dependency waits', async () => {
    const { service } = fixture([
      subtask('T1'),
      subtask('T2', { selectedModelName: 'deepseek-coder-v2:16b' }),
      subtask('T3', { selectedModelClass: 'premium_llm', selectedModelName: 'Claude Code' }),
      subtask('T4', { dependsOn: ['T1', 'T2'] }),
      subtask('T5', { selectedModelClass: 'no_llm', selectedModelName: null }),
    ])
    const forecast = await service.forecast('task')
    // two different ~10 GB models do not fit into 16 GB together: T2 waits for memory
    expect(forecast.tasks.T1).toMatchObject({ wave: 0, reason: 'ready' })
    expect(forecast.tasks.T2).toMatchObject({ reason: 'memory' })
    expect(forecast.tasks.T3).toMatchObject({ wave: 0 })
    expect(forecast.tasks.T4).toMatchObject({ reason: 'dependencies', waitsFor: ['T1', 'T2'] })
    expect(forecast.tasks.T5).toMatchObject({ reason: 'blocked' })
    expect(forecast.slots).toEqual({ local: 2, premium: 1 })
    expect(forecast.measuredDurations).toBe(2)
  })

  it('treats a subtask escalated to premium as premium work', async () => {
    const { service } = fixture([subtask('T1', { manualModel: 'premium' }), subtask('T2', { manualModel: 'premium' })])
    const forecast = await service.forecast('task')
    expect(forecast.tasks.T2).toMatchObject({ wave: 1, reason: 'premium_slot' })
  })

  it('stores a hint once as acceptance criterion and says when it takes effect', async () => {
    const { service, prisma, events } = fixture([subtask('T1', { acceptanceCriteria: ['Tests pass'] })], { executions: [{ id: 'run' }] })
    const result = await service.addHint('id-T1', '  Nutze   die bestehende Fehlerklasse ')
    expect(prisma.subtask.update).toHaveBeenCalledWith({ where: { id: 'id-T1' }, data: { acceptanceCriteria: ['Tests pass', 'Hinweis vom Nutzer: Nutze die bestehende Fehlerklasse'] } })
    expect(result.appliesTo).toBe('next_attempt')
    expect(events.publish).toHaveBeenCalledWith('run', 'subtask_hint', expect.objectContaining({ subtaskId: 'id-T1', appliesTo: 'next_attempt' }), 'task')
    await expect(service.addHint('id-T1', '   ')).rejects.toThrow('empty')
  })

  it('reads the base and agent version of a file and rejects paths outside the repository', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'mac-insights-'))
    try {
      const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
      run('init', '-q')
      run('config', 'user.email', 't@t')
      run('config', 'user.name', 't')
      writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1\n')
      run('add', '.')
      run('commit', '-qm', 'base')
      const base = run('rev-parse', 'HEAD')
      writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2\n')
      run('commit', '-qam', 'agent')
      const head = run('rev-parse', 'HEAD')
      const { service } = fixture([], { run: { id: 'run', baseCommit: base, integrationCommit: head, integrationBranch: null, project: { repoPath: repo } } })
      expect(await service.executionFile('run', 'a.ts')).toMatchObject({ base: 'export const a = 1\n', result: 'export const a = 2\n', revision: head })
      expect(await service.executionFile('run', 'missing.ts')).toMatchObject({ base: null, result: null })
      await expect(service.executionFile('run', '../secret.txt')).rejects.toThrow('Invalid path')
      await expect(service.executionFile('run', 'C:/Windows/win.ini')).rejects.toThrow('Invalid path')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('ResourceMonitorService', () => {
  it('maps loaded models to running agents and explains why local subtasks wait', async () => {
    const prisma = {
      subtask: {
        findMany: vi.fn().mockResolvedValue([
          { key: 'T1', title: 'A', status: 'running', selectedModelClass: 'local_llm', selectedModelName: 'qwen2.5-coder:14b', manualModel: null },
          { key: 'T2', title: 'B', status: 'running', selectedModelClass: 'premium_llm', selectedModelName: 'Claude Code', manualModel: null },
          { key: 'T3', title: 'C', status: 'queued', selectedModelClass: 'local_llm', selectedModelName: 'deepseek-coder-v2:16b', manualModel: null },
        ]),
      },
    }
    const settings = { get: vi.fn().mockResolvedValue({ premiumParallelism: 1, localParallelism: 'auto' }) }
    const client = { running: vi.fn().mockResolvedValue([{ name: 'qwen2.5-coder:14b', model: 'qwen2.5-coder:14b', size: 10 * GB, size_vram: 10 * GB, expires_at: '' }]) }
    const localModels = {
      client: vi.fn().mockResolvedValue(client),
      extraClients: vi.fn().mockResolvedValue([]),
      // no NVIDIA telemetry in CI: VRAM comes from what Ollama reports
      hardware: vi.fn().mockResolvedValue({ cpu: { model: 'CPU', logicalCores: 8 }, gpus: [{ name: 'GPU', vendor: 'amd', vramTotalMb: 16_384, vramReliable: true, vramSource: 'registry' }], disks: {}, memory: { totalBytes: 32 * GB, freeBytes: 16 * GB } }),
      localSlots: vi.fn().mockResolvedValue(1),
    }
    const service = new ResourceMonitorService(prisma as never, settings as never, localModels as never)
    ;(service as unknown as { sampler: { sample: () => Promise<unknown> } }).sampler = { sample: async () => ({ at: '2026-10-16T08:00:00.000Z', cpuPct: 12, ramUsedBytes: 16 * GB, ramTotalBytes: 32 * GB, gpus: [], gpuSource: 'none' }) }
    const snapshot = await service.snapshot()
    expect(snapshot.models).toEqual([expect.objectContaining({ name: 'qwen2.5-coder:14b', gpuShare: 1, agents: ['T1'] })])
    expect(snapshot.slots).toEqual({ local: 1, premium: 1, busyLocal: 1, busyPremium: 1 })
    expect(snapshot.gpu).toMatchObject({ source: 'ollama', vramUsedMb: 10_240, vramTotalMb: 16_384 })
    expect(snapshot.waiting).toEqual([{ key: 'T3', title: 'C', model: 'deepseek-coder-v2:16b', reason: 'wartet auf einen freien lokalen Slot (1/1 belegt)' }])
    expect(snapshot.warnings.map((warning) => warning.code)).toContain('no_gpu_telemetry')
    expect(snapshot.history).toHaveLength(1)
    ;(service as unknown as { stopLive: () => void }).stopLive()
  })

  it('shows both Ollama instances with their state, the unload countdown and the VRAM split', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T10:00:00.000Z'))
    try {
      const prisma = { subtask: { findMany: vi.fn().mockResolvedValue([{ key: 'task-007', title: 'A', status: 'running', selectedModelClass: 'local_llm', selectedModelName: 'qwen2.5-coder:7b', manualModel: null }]) } }
      const settings = { get: vi.fn().mockResolvedValue({ premiumParallelism: 1, localParallelism: 'auto' }) }
      const app = {
        baseUrl: 'http://127.0.0.1:11435',
        running: vi.fn().mockResolvedValue([
          { name: 'qwen2.5-coder:7b', model: 'qwen2.5-coder:7b', size: 5 * GB, size_vram: 5 * GB, expires_at: '2026-10-21T10:15:00.000Z' },
          { name: 'devstral:24b', model: 'devstral:24b', size: 4 * GB, size_vram: 4 * GB, expires_at: '2026-10-21T10:12:00.000Z' },
        ]),
      }
      const external = { baseUrl: 'http://127.0.0.1:11434', running: vi.fn().mockResolvedValue([{ name: 'llama3:8b', model: 'llama3:8b', size: 2 * GB, size_vram: 2 * GB, expires_at: '2318-01-01T00:00:00Z' }]) }
      const localModels = {
        client: vi.fn().mockResolvedValue(app),
        extraClients: vi.fn().mockResolvedValue([external]),
        hardware: vi.fn().mockResolvedValue({ cpu: { model: 'CPU', logicalCores: 8 }, gpus: [{ name: 'RTX', vendor: 'nvidia', vramTotalMb: 16_384, vramReliable: true, vramSource: 'nvidia-smi' }], disks: {}, memory: { totalBytes: 32 * GB, freeBytes: 16 * GB } }),
        localSlots: vi.fn().mockResolvedValue(1),
      }
      const service = new ResourceMonitorService(prisma as never, settings as never, localModels as never)
      let now = Date.now()
      // nvidia-smi counts everything on the card: 9 GB app models + 2 GB other instance + 4.5 GB other processes
      ;(service as unknown as { sampler: { sample: () => Promise<unknown> } }).sampler = { sample: async () => ({ at: new Date(now).toISOString(), cpuPct: 3, ramUsedBytes: 8 * GB, ramTotalBytes: 32 * GB, gpus: [{ index: 0, name: 'RTX', utilizationPct: 4, vramUsedMb: 15_872, vramTotalMb: 16_384 }], gpuSource: 'nvidia-smi' }) }
      const snapshot = await service.snapshot()
      expect(snapshot.models).toEqual([
        expect.objectContaining({ name: 'qwen2.5-coder:7b', instance: 'app', baseUrl: 'http://127.0.0.1:11435', state: 'generating', agents: ['task-007'], unloadsInSec: 900 }),
        expect.objectContaining({ name: 'devstral:24b', instance: 'app', state: 'idle', agents: [], unloadsInSec: 720 }),
        expect.objectContaining({ name: 'llama3:8b', instance: 'external', baseUrl: 'http://127.0.0.1:11434', state: 'external', agents: [], unloadsInSec: null }),
      ])
      expect(snapshot.vram).toEqual({ appModelsGb: 9, otherGb: 6.5 })
      expect(snapshot).toMatchObject({ sampledAt: Date.parse('2026-10-21T10:00:00.000Z'), intervalMs: 1000 })
      // 97 % used, but the app models sit fully on the GPU: the rest belongs to others
      const vramWarning = snapshot.warnings.find((warning) => warning.code === 'vram_full')
      expect(vramWarning?.message).toContain('davon 9,0 GB durch Modelle der App')
      expect(snapshot.warnings.some((warning) => warning.code === 'cpu_offload')).toBe(false)

      // the live sampler fills the history every second while clients ask, and stops 5 s after the last request
      for (let tick = 0; tick < 3; tick += 1) {
        now += 1000
        await vi.advanceTimersByTimeAsync(1000)
      }
      expect((await service.snapshot()).history).toHaveLength(4)
      now += 7000
      await vi.advanceTimersByTimeAsync(7000)
      const points = (service as unknown as { points: unknown[] }).points.length
      now += 3000
      await vi.advanceTimersByTimeAsync(3000)
      expect((service as unknown as { points: unknown[] }).points).toHaveLength(points)
      expect((service as unknown as { liveTimer?: unknown }).liveTimer).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a failing second instance silently', async () => {
    const prisma = { subtask: { findMany: vi.fn().mockResolvedValue([]) } }
    const settings = { get: vi.fn().mockResolvedValue({ premiumParallelism: 1, localParallelism: 'auto' }) }
    const app = { baseUrl: 'http://127.0.0.1:11434', running: vi.fn().mockResolvedValue([{ name: 'a:1b', model: 'a:1b', size: GB, size_vram: GB, expires_at: '' }]) }
    const external = { baseUrl: 'http://127.0.0.1:11435', running: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
    const localModels = {
      client: vi.fn().mockResolvedValue(app),
      extraClients: vi.fn().mockResolvedValue([external]),
      hardware: vi.fn().mockResolvedValue({ cpu: { model: 'CPU', logicalCores: 8 }, gpus: [], disks: {}, memory: { totalBytes: 32 * GB, freeBytes: 16 * GB } }),
      localSlots: vi.fn().mockResolvedValue(1),
    }
    const service = new ResourceMonitorService(prisma as never, settings as never, localModels as never)
    ;(service as unknown as { sampler: { sample: () => Promise<unknown> } }).sampler = { sample: async () => ({ at: new Date().toISOString(), cpuPct: 3, ramUsedBytes: 8 * GB, ramTotalBytes: 32 * GB, gpus: [], gpuSource: 'none' }) }
    const snapshot = await service.snapshot()
    ;(service as unknown as { stopLive: () => void }).stopLive()
    expect(snapshot.ollama.reachable).toBe(true)
    expect(snapshot.models).toEqual([expect.objectContaining({ name: 'a:1b', state: 'idle', unloadsInSec: null })])
    expect(snapshot.vram).toEqual({ appModelsGb: 1, otherGb: null })
  })

  it('counts a model as generating while a running local agent attempt (escalation) uses it', async () => {
    const agentRuns = vi.fn().mockResolvedValue([{ selectedModelName: 'big:14b', subtask: { key: 'task-003' } }])
    const prisma = {
      subtask: { findMany: vi.fn().mockResolvedValue([{ key: 'task-003', title: 'A', status: 'repairing', selectedModelClass: 'local_llm', selectedModelName: 'small:1b', manualModel: null }]) },
      agentRun: { findMany: agentRuns },
    }
    const settings = { get: vi.fn().mockResolvedValue({ premiumParallelism: 1, localParallelism: 'auto' }) }
    const app = { baseUrl: 'http://127.0.0.1:11435', running: vi.fn().mockResolvedValue(['small:1b', 'big:14b'].map((name) => ({ name, model: name, size: GB, size_vram: GB, expires_at: '' }))) }
    const localModels = {
      client: vi.fn().mockResolvedValue(app),
      extraClients: vi.fn().mockResolvedValue([]),
      hardware: vi.fn().mockResolvedValue({ cpu: { model: 'CPU', logicalCores: 8 }, gpus: [], disks: {}, memory: { totalBytes: 32 * GB, freeBytes: 16 * GB } }),
      localSlots: vi.fn().mockResolvedValue(1),
    }
    const service = new ResourceMonitorService(prisma as never, settings as never, localModels as never)
    ;(service as unknown as { sampler: { sample: () => Promise<unknown> } }).sampler = { sample: async () => ({ at: new Date().toISOString(), cpuPct: 3, ramUsedBytes: 8 * GB, ramTotalBytes: 32 * GB, gpus: [], gpuSource: 'none' }) }
    const snapshot = await service.snapshot()
    ;(service as unknown as { stopLive: () => void }).stopLive()
    expect(agentRuns).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'running', selectedModelClass: 'local_llm' }) }))
    expect(snapshot.models).toEqual([
      expect.objectContaining({ name: 'small:1b', state: 'idle', agents: [] }),
      expect.objectContaining({ name: 'big:14b', state: 'generating', agents: ['task-003'] }),
    ])
  })
})

describe('ResourceMonitorService energy', () => {
  it('meters the draw over time and prices it with the tariff (unit price + pro-rata base price)', async () => {
    const tariff = { pricePerKwh: 0.3, basePricePerMonth: 12.17, systemBaseWatts: 50, cpuMaxWatts: 100 }
    const prisma = { subtask: { count: vi.fn().mockResolvedValue(1), findMany: vi.fn().mockResolvedValue([]) } }
    const settings = { get: vi.fn().mockResolvedValue({ electricity: tariff, gpuWatts: null, premiumParallelism: 1, localParallelism: 'auto' }) }
    const service = new ResourceMonitorService(prisma as never, settings as never, {} as never)
    let now = new Date(2026, 9, 16, 10, 0, 0).getTime()
    ;(service as unknown as { sampler: { sample: () => Promise<unknown> } }).sampler = {
      sample: async () => ({ at: new Date(now).toISOString(), cpuPct: 50, ramUsedBytes: 0, ramTotalBytes: 1, gpus: [{ index: 0, name: 'GPU', powerW: 150 }], gpuSource: 'nvidia-smi' }),
    }
    await service.measureEnergy()
    now += 36_000
    await service.measureEnergy()
    const energy = await service.energy(1)
    // 150 W GPU + 50 W base + 50 % of 100 W CPU = 250 W; 36 s → 2.5 Wh, all during inference
    expect(energy.live).toMatchObject({ gpuW: 150, gpuSource: 'nvidia-smi', systemW: 100, systemSource: 'estimate', totalW: 250, inferenceActive: true })
    expect(energy.live.costPerHour).toEqual({ energy: 0.075, base: 0.01667, total: 0.09167 })
    expect(energy.today).toMatchObject({ kWh: 0.0025, inferenceKWh: 0.0025, energyCost: 0.00075, days: 1 })
    expect(energy.today.baseCost).toBeCloseTo(0.4001, 4)
    expect(energy.daily).toHaveLength(1)
  })
})
