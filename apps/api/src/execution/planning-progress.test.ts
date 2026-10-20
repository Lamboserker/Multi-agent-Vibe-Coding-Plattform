import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestratorError } from '@multi-ai-coder/engine'
import { ExecutionService } from './execution.service.js'

function fixture() {
  const prisma = { task: { update: vi.fn().mockResolvedValue({}), findUniqueOrThrow: vi.fn().mockResolvedValue({ projectId: 'p', project: { name: 'repo', repoPath: 'C:/repo' }, userPrompt: 'change a component' }) } }
  const settings = { get: vi.fn().mockResolvedValue({ modelRoles: {} }) }
  const orchestrators = { active: vi.fn().mockResolvedValue(undefined) }
  const localModels = { warmup: vi.fn().mockResolvedValue(undefined), engineProfiles: vi.fn().mockResolvedValue([]) }
  const repoContext = { digest: vi.fn() }
  const jobs = {
    enqueue: vi.fn().mockImplementation(async (_type, payload) => ({ id: 'job', payload, createdAt: new Date(), status: 'queued' })),
    activeFor: vi.fn(),
  }
  const events = { publish: vi.fn() }
  const service = new ExecutionService(prisma as never, settings as never, orchestrators as never, localModels as never, repoContext as never, jobs as never, events as never)
  return { service, prisma, repoContext, jobs, events }
}

afterEach(() => vi.useRealTimers())

describe('planning timing', () => {
  it('stores the request time in the job before preparation and uses the original time on duplicate enqueue', async () => {
    vi.useFakeTimers()
    const requestedAt = '2026-10-14T10:00:00.000Z'
    vi.setSystemTime(new Date(requestedAt))
    const { service, jobs, events } = fixture()
    await service.requestPlan('task')
    expect(jobs.enqueue).toHaveBeenCalledWith('execution.plan', expect.objectContaining({ taskId: 'task', requestedAt }), { dedupeKey: 'plan:task' })
    vi.setSystemTime(new Date('2026-10-14T10:00:30.000Z'))
    jobs.enqueue.mockResolvedValueOnce({ id: 'job', payload: { requestedAt }, createdAt: new Date(requestedAt), status: 'running' })
    await service.requestPlan('task')
    expect(events.publish).toHaveBeenLastCalledWith('run', 'plan_requested', { taskId: 'task', jobId: 'job', requestedAt })
  })

  describe('answers to planner questions', () => {
    const clarifying = (messages: unknown[]) => {
      const ctx = fixture()
      ctx.prisma.task.findUniqueOrThrow.mockResolvedValue({ currentStep: 'plan_clarification', userPrompt: 'Mach es besser' })
      Object.assign(ctx.prisma, { chatMessage: { findMany: vi.fn().mockResolvedValue(messages) } })
      return ctx
    }

    it('stores questions and answer in the request and enqueues without feedback', async () => {
      const { service, prisma, jobs } = clarifying([
        { metadata: { kind: 'plan_progress' } },
        { metadata: { kind: 'plan_questions', questions: ['Welche Datei?', 'Welches Format?'] } },
      ])
      await service.requestPlan('task', ' src/a.ts, JSON ')
      const block = 'Clarification – the planner asked:\n1. Welche Datei?\n2. Welches Format?\nThe user answered:\nsrc/a.ts, JSON'
      expect(prisma.task.update).toHaveBeenCalledWith({ where: { id: 'task' }, data: { currentStep: 'planning', status: 'running', userPrompt: `Mach es besser\n\n${block}` } })
      expect(jobs.enqueue).toHaveBeenCalledWith('execution.plan', expect.objectContaining({ taskId: 'task', feedback: undefined }), { dedupeKey: 'plan:task' })
    })

    it('passes the feedback on unchanged when no questions message exists', async () => {
      const { service, prisma, jobs } = clarifying([{ metadata: { kind: 'plan_progress' } }])
      await service.requestPlan('task', 'nur Feedback')
      expect(prisma.task.update).toHaveBeenCalledWith({ where: { id: 'task' }, data: { currentStep: 'planning', status: 'running' } })
      expect(jobs.enqueue).toHaveBeenCalledWith('execution.plan', expect.objectContaining({ feedback: 'nur Feedback' }), { dedupeKey: 'plan:task' })
    })

    it('refuses to start while questions are open', async () => {
      const { service, prisma } = fixture()
      prisma.task.findUniqueOrThrow.mockResolvedValue({ currentStep: 'plan_clarification', subtasks: [{ id: 's' }] })
      await expect(service.start('task')).rejects.toThrow('Rückfragen')
    })
  })

  it('announces preparation while the repository digest is still pending', async () => {
    const { service, repoContext, events } = fixture()
    let fail!: (error: Error) => void
    repoContext.digest.mockReturnValue(new Promise((_resolve, reject) => { fail = reject }))
    const requestedAt = '2026-10-14T10:00:00.000Z'
    const planning = service.plan('task', undefined, false, requestedAt)
    const rejected = expect(planning).rejects.toThrow('test preparation failure')
    await vi.waitFor(() => expect(repoContext.digest).toHaveBeenCalled())
    expect(events.publish).toHaveBeenCalledWith('run', 'planning_started', { taskId: 'task', requestedAt })
    fail(new Error('test preparation failure'))
    await rejected
  })

  it('gives the planner only enabled coder agents and the skill catalog, and keeps requested skills out of its context', async () => {
    const { service, prisma, repoContext } = fixture()
    const createPlan = vi.fn().mockRejectedValue(new OrchestratorError('stop after capture', 'cancelled'))
    const orchestrator = { id: 'codex', displayName: 'Codex', createPlan }
    Object.assign(service as object, {
      settings: { get: vi.fn().mockResolvedValue({ modelRoles: {}, fastPath: false, costMode: 'balanced', maxTasks: 8 }) },
      orchestrators: { active: vi.fn().mockResolvedValue(orchestrator), invalidate: vi.fn() },
      agentProfiles: {
        list: vi.fn().mockResolvedValue([
          { name: 'coder-a', description: 'Active coder', role: 'coder', enabled: true, categories: ['ui'], skills: ['projekt-doku'] },
          { name: 'coder-off', description: 'Disabled coder', role: 'coder', enabled: false, categories: [], skills: [] },
          { name: 'reviewer', description: 'Reviewer', role: 'reviewer', enabled: true, categories: [], skills: [] },
        ]),
      },
      agentResources: {
        catalog: vi.fn().mockResolvedValue([{ name: 'projekt-doku', description: 'Docs.', requested: true }, { name: 'other', description: 'Other.', requested: false }]),
        promptContext: vi.fn().mockResolvedValue({ text: '### Skill: other\nbody', inlined: ['other'] }),
      },
    })
    prisma.task.findUniqueOrThrow.mockResolvedValue({ projectId: 'p', project: { name: 'repo', repoPath: 'C:/repo' }, userPrompt: 'Nutze den Skill "projekt-doku"' })
    ;(prisma as Record<string, unknown>).modelCall = { create: vi.fn().mockResolvedValue({}) }
    repoContext.digest.mockResolvedValue({ index: { files: [] }, checks: [], digest: { summary: 'digest', tokenEstimate: 1 } })
    await expect(service.plan('task')).rejects.toThrow('stop after capture')
    const input = createPlan.mock.calls[0]![0]
    expect(input.agents.map((agent: { name: string }) => agent.name)).toEqual(['coder-a'])
    expect(input.skills).toEqual([{ name: 'projekt-doku', description: 'Docs.', requested: true }, { name: 'other', description: 'Other.', requested: false }])
    expect((service as unknown as { agentResources: { promptContext: ReturnType<typeof vi.fn> } }).agentResources.promptContext).toHaveBeenCalledWith('planner', 'p', 'Nutze den Skill "projekt-doku"', ['projekt-doku'])
    expect(input.context.summary).not.toContain('### Skill: projekt-doku')
  })

  it('stores only active skills per subtask; a one-task plan inherits the skills named in the request', async () => {
    const plannedTask = (id: string, skills: string[]) => ({
      id, title: `Task ${id}`, description: 'Write the docs', category: 'docs', complexity: 1, risk: 1, relevantFiles: ['README.md'], newFiles: [], dependsOn: [], capabilities: [],
      acceptanceCriteria: ['Docs updated.'], testStrategy: 'none', expectedInputTokens: 1000, suggestedExecutor: 'local', rationale: 'r', agent: '', skills,
    })
    const run = async (tasks: ReturnType<typeof plannedTask>[]) => {
      const { service, prisma, repoContext } = fixture()
      const plan = { summary: 'S', analysis: { summary: 's', taskType: 'docs', complexity: 1, risk: 1, securitySensitive: false, affectedAreas: [], needsDecomposition: false, openQuestions: [] }, tasks, warnings: [] }
      const createPlan = vi.fn().mockResolvedValue({ result: plan, meta: { usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, measured: false, billing: 'subscription' } } })
      const chat = vi.fn().mockResolvedValue(undefined)
      Object.assign(service as object, {
        settings: { get: vi.fn().mockResolvedValue({ modelRoles: {}, fastPath: false, costMode: 'balanced', maxTasks: 8, planApproval: true, autoStartSmallPlans: false }) },
        orchestrators: { active: vi.fn().mockResolvedValue({ id: 'codex', displayName: 'Codex', createPlan }), invalidate: vi.fn() },
        agentResources: {
          catalog: vi.fn().mockResolvedValue([{ name: 'projekt-doku', description: 'Docs.', requested: true }, { name: 'other', description: 'Other.', requested: false }]),
          promptContext: vi.fn().mockResolvedValue({ text: '', inlined: [] }),
        },
        previewRouting: vi.fn().mockResolvedValue({ assignments: [] }),
        chat,
      })
      prisma.task.findUniqueOrThrow.mockResolvedValue({ projectId: 'p', project: { name: 'repo', repoPath: 'C:/repo' }, userPrompt: 'Nutze den Skill "projekt-doku"' })
      const create = vi.fn().mockImplementation(async ({ data }) => data)
      Object.assign(prisma, {
        modelCall: { create: vi.fn().mockResolvedValue({}) },
        subtask: { deleteMany: vi.fn().mockResolvedValue({}), create },
        $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
        taskPlan: { create: vi.fn().mockResolvedValue({ id: 'plan' }) },
      })
      repoContext.digest.mockResolvedValue({ index: { files: [] }, checks: [], digest: { summary: 'digest', tokenEstimate: 1 } })
      await service.plan('task')
      return { saved: create.mock.calls.map(([{ data }]) => data.skills), message: String(chat.mock.calls[0]![2]) }
    }
    const single = await run([plannedTask('task-001', ['other', 'invented-skill'])])
    expect(single.saved).toEqual([['other', 'projekt-doku']])
    expect(single.message).toContain('Skills: other, projekt-doku')
    expect(single.message).not.toContain('invented-skill')
    // several tasks: only the planner's (known, deduplicated) choice, the named skill is not spread over all tasks
    const multi = await run([plannedTask('task-001', ['invented-skill', 'other', 'other']), plannedTask('task-002', [])])
    expect(multi.saved).toEqual([['other'], []])
  })

  describe('planner without tasks', () => {
    const setup = (rejection: OrchestratorError) => {
      const { service, prisma, repoContext, events } = fixture()
      const createPlan = vi.fn().mockRejectedValue(rejection)
      const chat = vi.fn().mockResolvedValue(undefined)
      const modelCallCreate = vi.fn().mockResolvedValue({})
      const subtask = { deleteMany: vi.fn().mockResolvedValue({}), create: vi.fn().mockImplementation(async ({ data }) => data) }
      const taskPlan = { create: vi.fn().mockResolvedValue({ id: 'plan' }) }
      Object.assign(service as object, {
        settings: { get: vi.fn().mockResolvedValue({ modelRoles: {}, fastPath: false, costMode: 'balanced', maxTasks: 8, planApproval: true, autoStartSmallPlans: false }) },
        orchestrators: { active: vi.fn().mockResolvedValue({ id: 'codex', displayName: 'Codex', createPlan }), invalidate: vi.fn() },
        previewRouting: vi.fn().mockResolvedValue({ assignments: [] }),
        chat,
      })
      Object.assign(prisma, { modelCall: { create: modelCallCreate }, subtask, taskPlan, $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)) })
      repoContext.digest.mockResolvedValue({ index: { files: [], frameworks: [] }, checks: [], digest: { summary: 'digest', tokenEstimate: 1 } })
      return { service, prisma, events, createPlan, chat, modelCallCreate, subtask, taskPlan }
    }

    it('shows the open questions instead of a fallback plan and calls the planner once', async () => {
      const questions = ['Welche Datei?', 'Welches Format?']
      const { service, prisma, events, createPlan, chat, modelCallCreate, subtask, taskPlan } = setup(new OrchestratorError('needs input', 'needs_clarification', { retryable: false, questions }))
      const result = await service.plan('task')
      expect(result.source).toBe('clarification')
      expect(createPlan).toHaveBeenCalledTimes(1)
      expect(subtask.deleteMany).not.toHaveBeenCalled()
      expect(subtask.create).not.toHaveBeenCalled()
      expect(taskPlan.create).not.toHaveBeenCalled()
      expect(prisma.task.update).toHaveBeenCalledWith({ where: { id: 'task' }, data: { status: 'planned', currentStep: 'plan_clarification' } })
      expect(chat).toHaveBeenCalledWith('task', 'assistant', expect.stringContaining('1. Welche Datei?'), { kind: 'plan_questions', questions })
      expect(String(chat.mock.calls[0]![2])).toContain('2. Welches Format?')
      expect(modelCallCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'error', errorClass: 'needs_clarification' }) })
      expect(events.publish).toHaveBeenCalledWith('run', 'planned', { taskId: 'task', tasks: 0, source: 'clarification', autoStarted: false })
    })

    it('books the tokens of the planner call that ended with questions', async () => {
      const questions = ['Welche Datei?']
      const meta = { model: 'gpt-x', durationMs: 5, usage: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 100, measured: true, billing: 'subscription' as const } }
      const { service, createPlan, modelCallCreate, subtask, taskPlan } = setup(new OrchestratorError('needs input', 'needs_clarification', { retryable: false, questions, meta }))
      const result = await service.plan('task')
      expect(result.source).toBe('clarification')
      expect(createPlan).toHaveBeenCalledTimes(1)
      expect(subtask.create).not.toHaveBeenCalled()
      expect(taskPlan.create).not.toHaveBeenCalled()
      expect(modelCallCreate).toHaveBeenCalledTimes(1)
      expect(modelCallCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'error', errorClass: 'needs_clarification', purpose: 'plan', inputTokens: 1200, outputTokens: 300, cachedInputTokens: 100, tokensMeasured: true, billing: 'subscription', model: 'gpt-x' }),
      })
    })

    it('books zero unmeasured tokens when the error carries no meta', async () => {
      const { service, modelCallCreate } = setup(new OrchestratorError('needs input', 'needs_clarification', { retryable: false, questions: ['Welche Datei?'] }))
      await service.plan('task')
      expect(modelCallCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ errorClass: 'needs_clarification', inputTokens: 0, outputTokens: 0, tokensMeasured: false }) })
    })

    it('still falls back to the deterministic plan for invalid output', async () => {
      const { service, createPlan, subtask } = setup(new OrchestratorError('The plan contained no usable tasks.', 'invalid_output'))
      const result = await service.plan('task')
      expect(result.source).toBe('deterministic-fallback')
      expect(createPlan).toHaveBeenCalledTimes(1)
      expect(subtask.create).toHaveBeenCalled()
    })

    it('books the tokens of an invalid plan and still falls back', async () => {
      const meta = { durationMs: 5, usage: { inputTokens: 800, outputTokens: 40, cachedInputTokens: 0, measured: true, billing: 'subscription' as const } }
      const { service, createPlan, modelCallCreate } = setup(new OrchestratorError('The plan contained no usable tasks.', 'invalid_output', { meta }))
      const result = await service.plan('task')
      expect(result.source).toBe('deterministic-fallback')
      expect(createPlan).toHaveBeenCalledTimes(1)
      expect(modelCallCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'error', errorClass: 'invalid_output', inputTokens: 800, outputTokens: 40, tokensMeasured: true }) })
    })
  })

  it('hands the pinned skills of a subtask to the engine task', async () => {
    const { service, prisma } = fixture()
    const subtask = (id: string, skills: string[]) => ({
      id, key: id, title: id, goal: 'Write the docs', category: 'docs', complexityScore: 1, riskScore: 1, allowedFiles: [], newFiles: [], dependsOn: [], acceptanceCriteria: [], testStrategy: null,
      expectedInputTokens: 1000, suggestedExecutor: 'local', priority: 0, manualModel: null, status: 'planned', commitSha: null, fastPath: null, agentId: null, skills,
    })
    Object.assign(prisma, { subtask: { findMany: vi.fn().mockResolvedValue([subtask('t1', ['projekt-doku']), subtask('t2', [])]) } })
    const tasks = await (service as unknown as { engineTasks: (taskId: string) => Promise<Array<{ skills?: string[] }>> }).engineTasks('task')
    expect(tasks.map((task) => task.skills)).toEqual([['projekt-doku'], []])
  })

  it('shows agent and skills per task line in the plan message', () => {
    const { service } = fixture()
    const planMessage = (service as unknown as { planMessage: (...args: unknown[]) => string }).planMessage.bind(service)
    const base = { id: 'task-001', title: 'Doku', complexity: 1, risk: 1, dependsOn: [] as string[], agent: '', skills: [] as string[] }
    const plan = { summary: 'S', warnings: [], tasks: [{ ...base, skills: ['projekt-doku'] }, { ...base, id: 'task-002' }] }
    const assignments = [{ key: 'task-001', executor: 'premium' }, { key: 'task-002', executor: 'premium' }]
    const lines = planMessage(plan, 'codex', assignments, [], true, false, ['Doku-Agent', undefined]).split('\n')
    expect(lines.find((line) => line.includes('task-001'))).toContain('→ Premium · Doku-Agent · Skills: projekt-doku')
    const plain = lines.find((line) => line.includes('task-002'))!
    expect(plain.endsWith('→ Premium')).toBe(true)
  })

  it('restores the exact planning clock from the active job after a renderer reload', async () => {
    const { service, jobs } = fixture()
    const requestedAt = '2026-10-14T10:00:00.000Z'
    jobs.activeFor.mockResolvedValue([{ status: 'running', payload: { taskId: 'task', requestedAt }, createdAt: new Date() }])
    expect(await service.planningStatus('task')).toEqual({ startedAt: requestedAt, phase: 'preparing' })
    jobs.activeFor.mockResolvedValue([])
    expect(await service.planningStatus('task')).toBeUndefined()
  })
})
