import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { ConflictException } from '@nestjs/common'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase, withNotices } from '../test-db.js'

const db = useTempDatabase('mac-design-')
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { ExecutionService } = await import('../execution/execution.service.js')
const { DesignService, DESIGN_UNAVAILABLE_TEXT } = await import('./design.service.js')
const { DesignController } = await import('./design.controller.js')
const { DESIGN_TASK_ID, MOCKUP_CSP, briefOf, designFilesTool, designMarkdown, requestDesignSkill, withDesignGuidance, withDesignTask, withMockupCsp, designPlanTask } = await import('./design-files.js')
const { OrchestratorError } = await import('@multi-ai-coder/engine')
type DesignDraftResult = import('@multi-ai-coder/engine').DesignDraft
type ExecutionPlanResult = import('@multi-ai-coder/engine').ExecutionPlan

const prisma = new PrismaService()
const events = new EventBusService()
let projectId = ''
let repoPath = ''

const DRAFT: DesignDraftResult = {
  summary: 'CRM mit Kontaktliste und Pipeline',
  designType: 'crm',
  direction: 'Neutral zinc base, one indigo accent, hairline borders.',
  tokens: [
    { name: '--accent', value: '#4f46e5', darkValue: '#818cf8', group: 'color' },
    { name: '--radius-md', value: '10px', darkValue: '', group: 'radius' },
  ],
  components: [{ name: 'ContactTable', purpose: 'Kontaktliste', file: 'src/components/ContactTable.tsx', spec: 'Table with hairline row borders, sticky header, empty state.', tokens: ['--accent'] }],
  screens: [{ name: 'Kontakte', route: '/contacts', layout: 'Sidebar left, table right.', components: ['ContactTable'] }],
  mockupHtml: '<!doctype html><html><body><h1>CRM</h1></body></html>',
  questions: ['Brauchst du einen Dark Mode?'],
}
const META = { model: 'claude-test', sessionId: 's-1', durationMs: 7, usage: { inputTokens: 5000, outputTokens: 9000, cachedInputTokens: 100, measured: true, billing: 'subscription' as const } }

const plannedTask = (id: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) => ({
  id, title: `Task ${id}`, description: 'Build the contact table', category: 'react-ui', complexity: 2, risk: 1, relevantFiles: [], newFiles: [`src/${id}.tsx`], dependsOn, capabilities: [],
  acceptanceCriteria: ['Done.'], testStrategy: 'none', expectedInputTokens: 1000, suggestedExecutor: 'local' as const, rationale: 'r', agent: '', skills: [] as string[], ...extra,
})
const PLAN: ExecutionPlanResult = {
  summary: 'Plan auf Basis des Designs',
  analysis: { summary: 's', taskType: 'frontend', complexity: 3, risk: 1, securitySensitive: false, affectedAreas: [], needsDecomposition: true, openQuestions: [] },
  tasks: [plannedTask('task-001'), plannedTask('task-002', ['task-001'], { skills: ['design-crm'] })],
  warnings: [],
}

/** In-memory job queue: records jobs; tests run a job's handler explicitly. */
function jobQueue() {
  const handlers = new Map<string, (payload: Record<string, unknown>, ctx: { signal: AbortSignal }) => Promise<unknown>>()
  const recovered: Array<(job: unknown, outcome: string) => Promise<void> | void> = []
  const jobs: Array<{ id: string; type: string; payload: Record<string, unknown>; status: string; createdAt: Date }> = []
  return {
    jobs,
    recovered,
    register: (type: string, handler: (payload: Record<string, unknown>, ctx: { signal: AbortSignal }) => Promise<unknown>) => void handlers.set(type, handler),
    onRecovered: (listener: (job: unknown, outcome: string) => Promise<void> | void) => void recovered.push(listener),
    enqueue: vi.fn(async (type: string, payload: Record<string, unknown>, options: { dedupeKey?: string } = {}) => {
      const existing = jobs.find((job) => job.type === type && ['queued', 'running'].includes(job.status) && job.payload.dedupeKey === options.dedupeKey)
      if (existing) return existing
      const job = { id: `job-${jobs.length + 1}`, type, payload: { ...payload, dedupeKey: options.dedupeKey }, status: 'queued', createdAt: new Date() }
      jobs.push(job)
      return job
    }),
    activeFor: async (type: string, match: (payload: Record<string, unknown>) => boolean) => jobs.filter((job) => job.type === type && ['queued', 'running'].includes(job.status) && match(job.payload)),
    cancel: vi.fn(async (id: string) => {
      const job = jobs.find((entry) => entry.id === id)
      if (job) job.status = 'cancelled'
    }),
    /** Runs the newest queued job of a type like the real queue would. */
    async run(type: string) {
      const job = [...jobs].reverse().find((entry) => entry.type === type && entry.status === 'queued')
      if (!job) throw new Error(`no queued ${type} job`)
      job.status = 'running'
      try {
        await handlers.get(type)!(job.payload, { signal: new AbortController().signal })
        job.status = 'completed'
      } catch (error) {
        job.status = 'failed'
        throw error
      }
    },
  }
}

function setup(options: { designer?: 'claude' | 'none'; createDesign?: ReturnType<typeof vi.fn>; createPlan?: ReturnType<typeof vi.fn> } = {}) {
  const jobs = jobQueue()
  const createDesign = options.createDesign ?? vi.fn().mockResolvedValue({ result: DRAFT, meta: META })
  const createPlan = options.createPlan ?? vi.fn().mockResolvedValue({ result: PLAN, meta: META })
  const designer = { id: 'claude-code' as const, displayName: 'Claude Code', createDesign }
  const orchestrators = withNotices({
    designer: vi.fn().mockResolvedValue(options.designer === 'none' ? undefined : designer),
    active: vi.fn().mockResolvedValue({ id: 'codex', displayName: 'Codex', createPlan }),
    invalidate: vi.fn(),
  })
  const settings = { get: vi.fn().mockResolvedValue({ modelRoles: {}, fastPath: true, costMode: 'balanced', maxTasks: 8, planApproval: true, autoStartSmallPlans: false, orchestrator: 'codex' }) }
  const localModels = { warmup: vi.fn().mockResolvedValue([]), engineProfiles: vi.fn().mockResolvedValue([]) }
  const repoContext = { digest: vi.fn().mockResolvedValue({ index: { files: [], frameworks: [] }, checks: [], digest: { summary: 'digest', relevantFiles: [], validationCommands: [], tokenEstimate: 1 } }) }
  const agentResources = {
    catalog: vi.fn().mockResolvedValue([
      { name: 'ui-design', description: 'UI rules.', requested: false },
      { name: 'design-crm', description: 'CRM recipe.', requested: false },
    ]),
    promptContext: vi.fn().mockResolvedValue({ text: '', inlined: [] }),
    designerContext: vi.fn().mockResolvedValue({ text: '### Skill: ui-design\nrules', inlined: ['ui-design', 'design-crm'], catalog: [{ name: 'design-crm', description: 'CRM recipe.' }] }),
  }
  const design = new DesignService(prisma, orchestrators as never, repoContext as never, jobs as never, events, agentResources as never)
  const execution = new ExecutionService(prisma, settings as never, orchestrators as never, localModels as never, repoContext as never, jobs as never, events, undefined, agentResources as never, undefined, design)
  // no worktree pool and no routing in these tests
  Object.assign(execution as object, { worktrees: () => ({ prewarm: async () => 0 }), previewRouting: vi.fn().mockResolvedValue({ assignments: [] }) })
  design.onModuleInit()
  execution.onModuleInit()
  const controller = new DesignController(design, execution)
  return { jobs, design, execution, controller, orchestrators, createDesign, createPlan, agentResources, repoContext }
}

const newTask = async (userPrompt: string, designMode = 'auto') => (await prisma.task.create({ data: { projectId, userPrompt, designMode, currentStep: 'draft' } })).id
const step = async (taskId: string) => (await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).currentStep
const kinds = async (taskId: string) => (await prisma.chatMessage.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } })).map((message) => (message.metadata as { kind?: string }).kind)
const jobTypes = (jobs: ReturnType<typeof jobQueue>) => jobs.jobs.map((job) => job.type)

beforeAll(async () => {
  await prisma.onModuleInit()
  await applyMigrations(prisma, MIGRATIONS_DIR)
  repoPath = path.join(db.dir, 'repo')
  mkdirSync(repoPath)
  projectId = (await prisma.project.create({ data: { name: 'demo', repoPath } })).id
})

afterAll(async () => {
  await prisma.$disconnect()
  db.cleanup()
})

beforeEach(() => vi.clearAllMocks())

describe('design gate in requestPlan', () => {
  it('starts the design phase for a UI request instead of planning', async () => {
    const { execution, jobs } = setup()
    const taskId = await newTask('Erstelle ein CRM-Dashboard mit Kontaktliste')
    const result = await execution.requestPlan(taskId, undefined, true)
    expect(result.design).toBe(true)
    expect(await step(taskId)).toBe('designing')
    expect(jobTypes(jobs)).toEqual(['design.create'])
    expect(jobs.jobs[0]!.payload).toMatchObject({ taskId, autoStart: true, dedupeKey: `design:${taskId}` })
    const draft = await prisma.designDraft.findFirstOrThrow({ where: { taskId } })
    expect(draft).toMatchObject({ version: 1, status: 'generating' })
  })

  it('plans a non-UI request as before', async () => {
    const { execution, jobs } = setup()
    const taskId = await newTask('Füge einen REST-Endpunkt /api/health im Server hinzu')
    expect((await execution.requestPlan(taskId)).design).toBeUndefined()
    expect(jobTypes(jobs)).toEqual(['execution.plan'])
    expect(await step(taskId)).toBe('planning')
  })

  it('respects designMode skip and force', async () => {
    const { execution, jobs } = setup()
    const skipped = await newTask('Erstelle ein CRM-Dashboard mit Kontaktliste', 'skip')
    await execution.requestPlan(skipped)
    const forced = await newTask('Füge einen REST-Endpunkt /api/health im Server hinzu', 'force')
    await execution.requestPlan(forced)
    expect(jobs.jobs.map((job) => [job.type, job.payload.taskId])).toEqual([['execution.plan', skipped], ['design.create', forced]])
    expect(await step(forced)).toBe('designing')
  })

  it('plans without a design (and says so once) when no premium designer is available', async () => {
    const { execution, jobs } = setup({ designer: 'none' })
    const taskId = await newTask('Baue eine Landingpage für mein Café')
    await execution.requestPlan(taskId)
    await execution.requestPlan(taskId, 'kürzer')
    expect(jobTypes(jobs)).toEqual(['execution.plan'])
    const notes = await prisma.chatMessage.findMany({ where: { taskId } })
    expect(notes.map((note) => note.content)).toEqual([DESIGN_UNAVAILABLE_TEXT])
    expect((notes[0]!.metadata as { kind: string }).kind).toBe('design_unavailable')
  })

  it('does not start a design call when a planned task is re-planned', async () => {
    const { execution, jobs } = setup({ designer: 'none' })
    const taskId = await newTask('Erstelle ein CRM-Dashboard mit Kontaktliste')
    await execution.requestPlan(taskId)
    await jobs.run('execution.plan')
    expect(await prisma.taskPlan.count({ where: { taskId } })).toBe(1)
    // the designer is available again: "Neu planen" with feedback still plans
    const ctx = setup()
    const result = await ctx.execution.requestPlan(taskId, 'Bitte noch eine Seite')
    expect(result.design).toBeUndefined()
    expect(jobTypes(ctx.jobs)).toEqual(['execution.plan'])
    expect(await prisma.designDraft.count({ where: { taskId } })).toBe(0)
  })

  it('does not gate the answers to planner questions', async () => {
    const { execution, jobs } = setup()
    const taskId = await newTask('Erstelle ein CRM-Dashboard mit Kontaktliste')
    await prisma.task.update({ where: { id: taskId }, data: { currentStep: 'plan_clarification' } })
    await execution.requestPlan(taskId, 'React')
    expect(jobTypes(jobs)).toEqual(['execution.plan'])
  })
})

describe('design job', () => {
  it('stores the draft, waits for approval, posts it in the chat and books the call', async () => {
    const { execution, jobs, createDesign } = setup()
    const taskId = await newTask('Erstelle ein CRM-Dashboard mit Kontaktliste')
    await execution.requestPlan(taskId)
    await jobs.run('design.create')
    const input = createDesign.mock.calls[0]![0]
    expect(input).toMatchObject({ goal: 'Erstelle ein CRM-Dashboard mit Kontaktliste', skills: '### Skill: ui-design\nrules', skillCatalog: [{ name: 'design-crm', description: 'CRM recipe.' }], provider: 'claude-code' })
    expect(input.feedback).toBeUndefined()
    expect(input.previous).toBeUndefined()
    expect(createDesign.mock.calls[0]![1]).toMatchObject({ runId: `design-${taskId}`, cwd: repoPath, timeoutMs: 600_000, effort: 'medium' })
    const draft = await prisma.designDraft.findFirstOrThrow({ where: { taskId } })
    expect(draft).toMatchObject({ status: 'draft', provider: 'claude-code', designType: 'crm', summary: DRAFT.summary, mockupHtml: DRAFT.mockupHtml })
    expect(draft.spec).toMatchObject({ direction: DRAFT.direction, tokens: DRAFT.tokens, components: DRAFT.components, screens: DRAFT.screens, questions: DRAFT.questions })
    expect(await step(taskId)).toBe('awaiting_design_approval')
    const message = await prisma.chatMessage.findFirstOrThrow({ where: { taskId } })
    expect(message.metadata).toEqual({ kind: 'design_draft', draftId: draft.id, version: 1, designType: 'crm', summary: DRAFT.summary, questions: DRAFT.questions })
    expect(message.content).toContain('Design-Entwurf 1 von Claude Code')
    expect(message.content).toContain('1. Brauchst du einen Dark Mode?')
    const call = await prisma.modelCall.findFirstOrThrow({ where: { purpose: 'design', status: 'ok', sessionId: 's-1' }, orderBy: { createdAt: 'desc' } })
    expect(call).toMatchObject({ provider: 'claude-code', model: 'claude-test', inputTokens: 5000, outputTokens: 9000, tokensMeasured: true })
  })

  it('posts the duo reconciliation of a draft designed by both orchestrators', async () => {
    const duo = { phase: 'design', lead: 'claude-code', partner: 'codex', proposals: [{ provider: 'claude-code', summary: 'crm, 3 Komponente(n)' }, { provider: 'codex', summary: 'crm, 2 Komponente(n)' }], notes: [], winner: 'merged' }
    const createDesign = vi.fn().mockResolvedValue({ result: DRAFT, meta: { ...META, sessionId: 's-duo', duo } })
    const { execution, jobs } = setup({ createDesign })
    const taskId = await newTask('Erstelle ein CRM-Dashboard mit Kontaktliste')
    await execution.requestPlan(taskId)
    await jobs.run('design.create')
    expect((await kinds(taskId)).sort()).toEqual(['design_draft', 'duo_reconciled'])
    const message = (await prisma.chatMessage.findMany({ where: { taskId } })).find((entry) => (entry.metadata as { kind?: string }).kind === 'duo_reconciled')!
    expect(message.metadata).toMatchObject({ kind: 'duo_reconciled', phase: 'design', lead: 'claude-code', partner: 'codex', winner: 'merged', proposals: duo.proposals })
    expect(message.content).toContain('Duo-Abgleich (Design)')
  })

  it('marks the draft failed and books the tokens of a rejected design call', async () => {
    const meta = { ...META, sessionId: 's-failed', usage: { ...META.usage, inputTokens: 1234, outputTokens: 56 } }
    const createDesign = vi.fn().mockRejectedValue(new OrchestratorError('Design output invalid.', 'invalid_output', { meta }))
    const { execution, jobs } = setup({ createDesign })
    const taskId = await newTask('Erstelle ein CRM-Dashboard mit Kontaktliste')
    await execution.requestPlan(taskId)
    await expect(jobs.run('design.create')).rejects.toThrow('Design output invalid.')
    expect((await prisma.designDraft.findFirstOrThrow({ where: { taskId } })).status).toBe('failed')
    expect(await step(taskId)).toBe('design_failed')
    expect(await kinds(taskId)).toEqual(['design_error'])
    const call = await prisma.modelCall.findFirstOrThrow({ where: { sessionId: 's-failed' } })
    expect(call).toMatchObject({ purpose: 'design', status: 'error', errorClass: 'invalid_output', inputTokens: 1234, outputTokens: 56, tokensMeasured: true, model: 'claude-test' })
  })

  it('plans directly when the designer disappears during the job, even if it is back for the gate', async () => {
    const { execution, jobs, orchestrators, createDesign } = setup()
    const taskId = await newTask('Erstelle ein CRM-Dashboard mit Kontaktliste')
    await execution.requestPlan(taskId)
    orchestrators.designer.mockResolvedValueOnce(undefined)
    await jobs.run('design.create')
    expect(createDesign).not.toHaveBeenCalled()
    expect(jobTypes(jobs)).toEqual(['design.create', 'execution.plan'])
    expect(await step(taskId)).toBe('planning')
    expect((await prisma.designDraft.findFirstOrThrow({ where: { taskId } })).status).toBe('failed')
  })

  it('marks an interrupted design job as failed after a restart', async () => {
    const { execution, jobs } = setup()
    const taskId = await newTask('Erstelle ein CRM-Dashboard mit Kontaktliste')
    await execution.requestPlan(taskId)
    for (const listener of jobs.recovered) await listener(jobs.jobs[0], 'interrupted')
    expect(await step(taskId)).toBe('design_failed')
    expect((await prisma.designDraft.findFirstOrThrow({ where: { taskId } })).status).toBe('failed')
  })

  it('refuses to start a run while the draft waits for approval', async () => {
    const { execution, jobs } = setup()
    const taskId = await newTask('Erstelle ein CRM-Dashboard mit Kontaktliste')
    await execution.requestPlan(taskId)
    await expect(execution.start(taskId)).rejects.toThrow('wird noch erstellt')
    await jobs.run('design.create')
    await expect(execution.start(taskId)).rejects.toThrow('wartet auf deine Freigabe')
  })
})

describe('approve, reject, skip', () => {
  async function drafted(options: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(options)
    const taskId = await newTask('Erstelle ein CRM-Dashboard mit Kontaktliste')
    await ctx.execution.requestPlan(taskId)
    await ctx.jobs.run('design.create')
    return { ...ctx, taskId }
  }

  it('approve plans on the draft: design brief, one task less, design-001 first and requested type skill', async () => {
    const { controller, jobs, createPlan, taskId, execution } = await drafted()
    const approved = await controller.approve(taskId)
    expect(approved.draft.status).toBe('approved')
    // the button posts the same note as an approval in the chat
    expect(await kinds(taskId)).toContain('planning')
    expect((await prisma.chatMessage.findFirstOrThrow({ where: { taskId, role: 'system', content: { startsWith: 'Design freigegeben' } } })).metadata).toEqual({ kind: 'planning' })
    expect(approved.design).toBeUndefined()
    expect(jobTypes(jobs)).toEqual(['design.create', 'execution.plan'])
    await jobs.run('execution.plan')
    const input = createPlan.mock.calls[0]![0]
    const { mockupHtml: _mockup, questions: _questions, ...brief } = DRAFT
    expect(input.design).toEqual(brief)
    expect(input.maxTasks).toBe(7)
    expect(input.skills[0]).toEqual({ name: 'design-crm', description: 'CRM recipe.', requested: true })
    const subtasks = await prisma.subtask.findMany({ where: { taskId }, orderBy: [{ createdAt: 'asc' }, { priority: 'desc' }] })
    expect(subtasks.map((subtask) => subtask.key)).toEqual([DESIGN_TASK_ID, 'task-001', 'task-002'])
    const [first, ...rest] = subtasks
    expect(first!.title).toBe('Design-Dateien anlegen')
    const tool = first!.fastPath as { kind: string; files: string[]; contents: string[] }
    expect(tool.kind).toBe('write-files')
    expect(tool.files).toEqual(['design/tokens.css', 'design/DESIGN.md', 'design/mockup.html'])
    expect(tool.contents[0]).toContain('--accent: #4f46e5;')
    expect(tool.contents[1]).toContain('ContactTable')
    expect(tool.contents[2]).toBe(withMockupCsp(DRAFT.mockupHtml))
    expect(tool.contents[2]).toContain(MOCKUP_CSP)
    expect(first!.dependsOn).toEqual([])
    expect(rest.map((subtask) => subtask.dependsOn)).toEqual([[DESIGN_TASK_ID], [DESIGN_TASK_ID, 'task-001']])
    expect(rest[1]!.skills).toEqual(['design-crm'])
    // the subtask reaches the engine as a tool task
    const engineTasks = await (execution as unknown as { engineTasks: (taskId: string) => Promise<Array<{ key: string; tool?: { kind: string } }>> }).engineTasks(taskId)
    expect(engineTasks.find((task) => task.key === DESIGN_TASK_ID)?.tool?.kind).toBe('write-files')
    const plan = await prisma.taskPlan.findFirstOrThrow({ where: { taskId } })
    expect((plan.dag as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id)).toEqual([DESIGN_TASK_ID, 'task-001', 'task-002'])
    // a re-plan keeps the approved design (no second design call)
    await execution.requestPlan(taskId, 'noch eine Seite')
    expect(jobTypes(jobs).filter((type) => type === 'design.create')).toHaveLength(1)
  })

  it('an approved design never takes the fast path', async () => {
    const prompt = 'Organisiere die Importe in `src/use.ts`'
    const withIndex = (ctx: ReturnType<typeof setup>) => ctx.repoContext.digest.mockResolvedValue({ index: { files: [{ path: 'src/use.ts' }], frameworks: [] }, checks: [], digest: { summary: 'digest', relevantFiles: [], validationCommands: [], tokenEstimate: 1 } })
    // control: without a design the request is a fast-path tool task
    const plain = setup()
    withIndex(plain)
    const plainTask = await newTask(prompt)
    await plain.execution.requestPlan(plainTask)
    await plain.jobs.run('execution.plan')
    expect((await prisma.taskPlan.findFirstOrThrow({ where: { taskId: plainTask } })).source).toBe('fast-path')
    // forced design, approved: the premium planner plans on the draft
    const ctx = setup()
    withIndex(ctx)
    const taskId = await newTask(prompt, 'force')
    await ctx.execution.requestPlan(taskId)
    await ctx.jobs.run('design.create')
    await ctx.controller.approve(taskId)
    await ctx.jobs.run('execution.plan')
    expect(ctx.createPlan).toHaveBeenCalledTimes(1)
    expect((await prisma.taskPlan.findFirstOrThrow({ where: { taskId } })).source).toBe('codex')
  })

  it('reject regenerates version 2 with the feedback and the previous brief', async () => {
    const { controller, jobs, createDesign, taskId } = await drafted()
    await controller.reject(taskId, { feedback: 'Mehr Kontrast, dunkle Sidebar' })
    expect(await kinds(taskId)).toContain('design_requested')
    const drafts = await prisma.designDraft.findMany({ where: { taskId }, orderBy: { version: 'asc' } })
    expect(drafts.map((draft) => [draft.version, draft.status, draft.feedback])).toEqual([[1, 'rejected', 'Mehr Kontrast, dunkle Sidebar'], [2, 'generating', 'Mehr Kontrast, dunkle Sidebar']])
    expect(await step(taskId)).toBe('designing')
    await jobs.run('design.create')
    const input = createDesign.mock.calls[1]![0]
    expect(input.feedback).toBe('Mehr Kontrast, dunkle Sidebar')
    expect(input.previous).toEqual(briefOf(drafts[0]!))
    expect(input.previous.designType).toBe('crm')
    expect((await prisma.designDraft.findFirstOrThrow({ where: { taskId, version: 2 } })).status).toBe('draft')
  })

  it('skip plans without a design and keeps designMode skip', async () => {
    const { controller, jobs, createPlan, taskId } = await drafted()
    const result = await controller.skip(taskId)
    expect(result.design).toBeUndefined()
    expect(await kinds(taskId)).toContain('planning')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).designMode).toBe('skip')
    expect((await prisma.designDraft.findFirstOrThrow({ where: { taskId } })).status).toBe('rejected')
    await jobs.run('execution.plan')
    const input = createPlan.mock.calls[0]![0]
    expect(input.design).toBeUndefined()
    expect(input.maxTasks).toBe(8)
    expect((await prisma.subtask.findMany({ where: { taskId } })).map((subtask) => subtask.key)).not.toContain(DESIGN_TASK_ID)
  })

  it('regenerate drafts the next version without feedback and notes it in the chat', async () => {
    const { controller, taskId } = await drafted()
    await controller.regenerate(taskId)
    const drafts = await prisma.designDraft.findMany({ where: { taskId }, orderBy: { version: 'asc' } })
    expect(drafts.map((draft) => [draft.version, draft.status, draft.feedback])).toEqual([[1, 'rejected', null], [2, 'generating', null]])
    expect(await step(taskId)).toBe('designing')
    expect(await kinds(taskId)).toContain('design_requested')
  })

  it('approve refuses a draft that is still being generated (409)', async () => {
    const { controller, execution } = setup()
    const taskId = await newTask('Erstelle ein CRM-Dashboard mit Kontaktliste')
    await execution.requestPlan(taskId)
    await expect(controller.approve(taskId)).rejects.toBeInstanceOf(ConflictException)
  })

  it('approve of an approved draft that still waits restarts planning ("Planung starten")', async () => {
    const { controller, jobs, taskId } = await drafted()
    await prisma.designDraft.updateMany({ where: { taskId }, data: { status: 'approved' } })
    const result = await controller.approve(taskId)
    expect(result.draft.status).toBe('approved')
    expect(result.design).toBeUndefined()
    expect(jobTypes(jobs)).toEqual(['design.create', 'execution.plan'])
    expect(await step(taskId)).toBe('planning')
    // once planning runs, a second approval is refused
    await expect(controller.approve(taskId)).rejects.toBeInstanceOf(ConflictException)
  })

  it('guards reject, regenerate and skip by the design step (409)', async () => {
    const { controller, jobs, taskId } = await drafted()
    await controller.reject(taskId, { feedback: 'dunkler' })
    expect(await step(taskId)).toBe('designing')
    // feedback while the next version is generated
    await prisma.task.update({ where: { id: taskId }, data: { currentStep: 'awaiting_design_approval' } })
    await expect(controller.reject(taskId, { feedback: 'heller' })).rejects.toBeInstanceOf(ConflictException)
    await prisma.task.update({ where: { id: taskId }, data: { currentStep: 'designing' } })
    await expect(controller.regenerate(taskId)).rejects.toBeInstanceOf(ConflictException)
    await jobs.run('design.create')
    // a planned task has left the design phase
    await prisma.task.update({ where: { id: taskId }, data: { currentStep: 'planned' } })
    await expect(controller.reject(taskId, { feedback: 'heller' })).rejects.toBeInstanceOf(ConflictException)
    await expect(controller.regenerate(taskId)).rejects.toBeInstanceOf(ConflictException)
    await expect(controller.skip(taskId)).rejects.toBeInstanceOf(ConflictException)
    await expect(controller.approve(taskId)).rejects.toBeInstanceOf(ConflictException)
    // after a failed draft a new one is allowed
    await prisma.task.update({ where: { id: taskId }, data: { currentStep: 'design_failed' } })
    await expect(controller.regenerate(taskId)).resolves.toMatchObject({ jobId: expect.any(String) })
  })

  it('skip after an approval plans without the design (no design-001)', async () => {
    const { controller, jobs, createPlan, taskId } = await drafted()
    await prisma.designDraft.updateMany({ where: { taskId }, data: { status: 'approved' } })
    await controller.skip(taskId)
    await jobs.run('execution.plan')
    expect(createPlan.mock.calls[0]![0].design).toBeUndefined()
    expect(createPlan.mock.calls[0]![0].maxTasks).toBe(8)
    expect((await prisma.subtask.findMany({ where: { taskId } })).map((subtask) => subtask.key)).not.toContain(DESIGN_TASK_ID)
  })
})

describe('design files and guidance', () => {
  const { mockupHtml: _mockup, questions: _questions, ...brief } = DRAFT

  it('adds a restrictive CSP to the written mockup', () => {
    expect(MOCKUP_CSP).toContain(`default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:`)
    expect(withMockupCsp('<html lang="de"><head><title>x</title></head><body></body></html>')).toBe(`<html lang="de"><head>${MOCKUP_CSP}<title>x</title></head><body></body></html>`)
    expect(withMockupCsp('<!doctype html><HTML><Body>x</Body></HTML>')).toBe(`<!doctype html><HTML><head>${MOCKUP_CSP}</head><Body>x</Body></HTML>`)
    expect(withMockupCsp('<header>x</header>')).toBe(`${MOCKUP_CSP}<header>x</header>`)
    const tool = designFilesTool(brief, '<html><head></head><body>x</body></html>')
    expect(tool.contents[2]).toBe(`<html><head>${MOCKUP_CSP}</head><body>x</body></html>`)
  })

  it('leaves out mockup.html when the sanitizer dropped the mockup', () => {
    expect(designFilesTool(brief, '').files).toEqual(['design/tokens.css', 'design/DESIGN.md'])
  })

  it('writes a readable DESIGN.md', () => {
    const markdown = designMarkdown(brief)
    expect(markdown).toContain('# Design')
    expect(markdown).toContain('| `--accent` | #4f46e5 | #818cf8 | color |')
    expect(markdown).toContain('### ContactTable (`src/components/ContactTable.tsx`)')
    expect(markdown).toContain('### Kontakte (`/contacts`)')
  })

  it('prepends design-001 without duplicating dependencies', () => {
    const tool = designFilesTool(brief, '')
    const plan = withDesignTask({ tasks: [plannedTask('task-001', ['design-001'])] }, designPlanTask(tool))
    expect(plan.tasks.map((task) => [task.id, task.dependsOn])).toEqual([['design-001', []], ['task-001', ['design-001']]])
  })

  it('requests the design skill of the type only when it is offered', () => {
    const catalog = [{ name: 'a', description: '', requested: false }, { name: 'design-crm', description: '', requested: false }]
    expect(requestDesignSkill(catalog, 'crm')[0]).toEqual({ name: 'design-crm', description: '', requested: true })
    expect(requestDesignSkill(catalog, 'other')).toBe(catalog)
  })

  it('adds the design guidance to UI tasks only', () => {
    const base = { tools: [], instructions: '### Skill: ui-design', sources: ['Skills: ui-design'] }
    const ui = withDesignGuidance(base, brief, { title: 'ContactTable bauen', description: 'Kontaktliste', category: 'react-ui', relevantFiles: [], newFiles: ['src/components/ContactTable.tsx'] })
    expect(ui.instructions).toContain('### Skill: ui-design\n\n## Design draft (approved)')
    expect(ui.instructions).toContain('### ContactTable')
    expect(ui.instructions).toContain('--accent')
    expect(ui.sources).toEqual(['Skills: ui-design', 'Design-Entwurf'])
    const backend = withDesignGuidance(base, brief, { title: 'Health endpoint', description: 'API', category: 'api-endpoint', relevantFiles: ['src/server.ts'], newFiles: [] })
    expect(backend).toBe(base)
    const tool = withDesignGuidance(base, brief, { title: 'Design-Dateien anlegen', description: '', category: 'fast-path', relevantFiles: [], newFiles: ['design/mockup.html'], tool: { kind: 'write-files' } })
    expect(tool).toBe(base)
  })
})
