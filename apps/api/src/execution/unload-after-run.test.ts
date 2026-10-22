import { describe, expect, it, vi } from 'vitest'
import { ExecutionService } from './execution.service.js'

type Row = { selectedModelClass: string | null; selectedModelName: string | null; manualModel: string | null }

function fixture(options: { unloadAfterRun?: boolean; own?: Row[]; attempts?: string[]; otherRuns?: string[]; otherSubtasks?: Row[]; otherAttempts?: string[]; loaded?: string[]; unloadFails?: string[] } = {}) {
  const prisma = {
    task: { update: vi.fn().mockResolvedValue({}), findUniqueOrThrow: vi.fn().mockResolvedValue({ projectId: 'p', project: { name: 'repo', repoPath: 'C:/repo' }, userPrompt: 'x' }), findUnique: vi.fn().mockResolvedValue(null) },
    subtask: { findMany: vi.fn().mockImplementation(async ({ where }) => (typeof where.taskId === 'string' ? (options.own ?? []) : (options.otherSubtasks ?? []))) },
    agentRun: { findMany: vi.fn().mockImplementation(async ({ where }) => ((typeof where.executionId === 'string' ? options.attempts : options.otherAttempts) ?? []).map((name) => ({ selectedModelClass: 'local_llm', selectedModelName: name }))) },
    executionRun: { findMany: vi.fn().mockImplementation(async () => (options.otherRuns ?? []).map((taskId) => ({ id: `run-${taskId}`, taskId }))) },
  }
  const settings = { get: vi.fn().mockResolvedValue({ unloadAfterRun: options.unloadAfterRun ?? true, keepAliveMinutes: 15, modelWarmup: true, modelRoles: { fast: 'a:1b', balanced: null, advanced: null } }) }
  const localModels = {
    warmup: vi.fn().mockResolvedValue([]),
    running: vi.fn().mockImplementation(async () => (options.loaded ?? []).map((name) => ({ name, model: name, size: 1, size_vram: 1, expires_at: '' }))),
    loadsSettled: vi.fn().mockResolvedValue(undefined),
    unload: vi.fn().mockImplementation(async (model: string) => {
      if (options.unloadFails?.includes(model)) throw new Error('Ollama is not reachable')
      return { ok: true }
    }),
  }
  const jobs = { enqueue: vi.fn().mockImplementation(async (_type, payload) => ({ id: 'job', payload, createdAt: new Date(), status: 'queued' })) }
  const service = new ExecutionService(prisma as never, settings as never, { active: vi.fn() } as never, localModels as never, {} as never, jobs as never, { publish: vi.fn() } as never)
  return { service, prisma, localModels, options }
}

const local = (name: string, manualModel: string | null = null): Row => ({ selectedModelClass: 'local_llm', selectedModelName: name, manualModel })

describe('unload after run', () => {
  it('unloads the loaded models of the run that no other active run needs', async () => {
    const { service, localModels } = fixture({
      own: [local('qwen2.5-coder:7b'), local('devstral:24b'), { selectedModelClass: 'premium_llm', selectedModelName: 'Claude Code', manualModel: null }],
      attempts: ['qwen2.5-coder:14b'],
      otherRuns: ['other'],
      otherSubtasks: [local('devstral:24b')],
      loaded: ['qwen2.5-coder:7b', 'devstral:24b', 'qwen2.5-coder:14b', 'llama3:8b'],
    })
    expect(await service.unloadRunModels('run', 'task')).toEqual(['qwen2.5-coder:7b', 'qwen2.5-coder:14b'])
    // devstral is used by the other run, llama3 was never used by this run, Claude Code is no local model
    expect(localModels.unload.mock.calls.map(([model]) => model)).toEqual(['qwen2.5-coder:7b', 'qwen2.5-coder:14b'])
  })

  it('also unloads models warmed for the task and skips models that are not loaded', async () => {
    const { service, localModels } = fixture({ own: [local('a:1b', 'b:2b')], loaded: ['b:2b', 'warm:3b'] })
    ;(service as unknown as { rememberWarmed: (taskId: string, models: string[]) => void }).rememberWarmed('task', ['warm:3b'])
    expect(await service.unloadRunModels('run', 'task')).toEqual(['b:2b', 'warm:3b'])
    expect(localModels.unload).not.toHaveBeenCalledWith('a:1b')
  })

  it('keeps models warmed for another task that waits for its plan approval', async () => {
    const { service } = fixture({ own: [local('a:1b')], loaded: ['a:1b'] })
    ;(service as unknown as { rememberWarmed: (taskId: string, models: string[]) => void }).rememberWarmed('planned-task', ['a:1b'])
    expect(await service.unloadRunModels('run', 'task')).toEqual([])
  })

  it('keeps models that local agent attempts (escalations) of another active run use', async () => {
    const { service, prisma } = fixture({ own: [local('a:1b')], attempts: ['big:14b'], otherRuns: ['other'], otherSubtasks: [local('c:3b')], otherAttempts: ['big:14b'], loaded: ['a:1b', 'big:14b'] })
    expect(await service.unloadRunModels('run', 'task')).toEqual(['a:1b'])
    expect(prisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { executionId: { in: ['run-other'] }, selectedModelClass: 'local_llm' } }))
  })

  it('waits for a pending warm-up of the task and its background load, then unloads the warmed model', async () => {
    const { service, localModels, options } = fixture({ own: [local('a:1b')], loaded: ['a:1b'] })
    let finishPrepare!: (models: string[]) => void
    const internals = service as unknown as { trackWarmup: (taskId: string, warmup: Promise<string[] | undefined>) => void }
    internals.trackWarmup('task', new Promise<string[]>((resolve) => { finishPrepare = resolve }))
    // the model only shows up as loaded once its background load is done
    localModels.loadsSettled.mockImplementation(async (models: string[]) => { if (models.includes('late:7b')) options.loaded = ['a:1b', 'late:7b'] })
    const unloading = service.unloadRunModels('run', 'task')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(localModels.unload).not.toHaveBeenCalled()
    finishPrepare(['late:7b'])
    expect(await unloading).toEqual(['a:1b', 'late:7b'])
    expect(localModels.loadsSettled).toHaveBeenCalledWith(['a:1b', 'late:7b'])
  })

  it('keeps the models when the task runs again (resumed) by the time the unload happens', async () => {
    const { service, localModels } = fixture({ own: [local('a:1b')], otherRuns: ['task'], loaded: ['a:1b'] })
    expect(await service.unloadRunModels('run', 'task')).toEqual([])
    expect(localModels.unload).not.toHaveBeenCalled()
  })

  it('does nothing when the setting is off and never throws', async () => {
    const off = fixture({ unloadAfterRun: false, own: [local('a:1b')], loaded: ['a:1b'] })
    expect(await off.service.unloadRunModels('run', 'task')).toEqual([])
    expect(off.localModels.unload).not.toHaveBeenCalled()

    const failing = fixture({ own: [local('a:1b'), local('b:2b')], loaded: ['a:1b', 'b:2b'], unloadFails: ['a:1b'] })
    expect(await failing.service.unloadRunModels('run', 'task')).toEqual(['b:2b'])

    const broken = fixture({ own: [local('a:1b')] })
    broken.localModels.running.mockRejectedValue(new Error('down'))
    await expect(broken.service.unloadRunModels('run', 'task')).resolves.toEqual([])
  })

  it('does not warm models up at planning start any more', async () => {
    const { service, localModels } = fixture()
    await service.requestPlan('task')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(localModels.warmup).not.toHaveBeenCalled()
  })
})
