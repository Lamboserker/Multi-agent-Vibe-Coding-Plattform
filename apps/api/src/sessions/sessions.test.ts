import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase, withNotices } from '../test-db.js'

const db = useTempDatabase('mac-sessions-')
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { JobQueueService } = await import('../runtime/job-queue.service.js')
const { SettingsService } = await import('../runtime/settings.service.js')
const { ExecutionService } = await import('../execution/execution.service.js')
const { SessionsService, deriveSessionStatus, DESIGN_START_TEXT, DESIGN_PENDING_TEXT, DESIGN_UNCLEAR_TEXT } = await import('./sessions.service.js')
const { DESIGN_APPROVAL, designAnswer } = await import('./session-model.js')
const { DesignService } = await import('../design/design.service.js')
const { OrchestratorError } = await import('@multi-ai-coder/engine')

const prisma = new PrismaService()
const events = new EventBusService()
const settings = new SettingsService(prisma, events)
let projectId = ''
const queues: Array<InstanceType<typeof JobQueueService>> = []

/** Orchestrator stub: answers questions without any real (billable) call. */
const orchestrators = {
  active: async () => ({
    id: 'codex',
    displayName: 'Codex',
    chat: async (input: { question: string; history?: unknown[] }) => ({
      result: { answer: `Antwort auf: ${input.question} (Verlauf ${input.history?.length ?? 0})` },
      meta: { sessionId: 'thread-123', model: 'fake', durationMs: 5, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, measured: true, billing: 'subscription' } },
    }),
  }),
}
const repoContext = { digest: async () => ({ digest: { summary: '', relevantFiles: [], validationCommands: [] }, index: {}, checks: [] }) }

function makeSessions(jobs = new JobQueueService(prisma, events), orchestratorStub: unknown = orchestrators, options: { designNext?: boolean } = {}) {
  queues.push(jobs)
  // Real design service without a registered design handler: design jobs stay queued, no designer is ever called.
  const design = new DesignService(prisma, { designer: async () => undefined, invalidate: () => undefined } as never, repoContext as never, jobs, events)
  // Planning is not under test here: requestPlan only marks the task and queues the job.
  const clarificationCalls: Array<{ taskId: string; answer: string }> = []
  const planRequests: Array<{ taskId: string; feedback: unknown; autoStart: unknown }> = []
  const executions = {
    // Records the call and delegates to the real implementation (it only needs prisma).
    clarificationAnswer: async (taskId: string, answer: string) => {
      clarificationCalls.push({ taskId, answer })
      return ExecutionService.prototype.clarificationAnswer.call({ prisma } as never, taskId, answer)
    },
    requestPlan: async (taskId: string, feedback?: unknown, autoStart?: unknown) => {
      planRequests.push({ taskId, feedback, autoStart })
      // like the design gate in ExecutionService.requestPlan: a UI request starts the design phase instead
      if (options.designNext) {
        const started = await design.start(taskId, { feedback: typeof feedback === 'string' ? feedback : undefined, autoStart: autoStart === true })
        return { jobId: started.jobId, design: true as const }
      }
      await prisma.task.update({ where: { id: taskId }, data: { currentStep: 'planning', status: 'running' } })
      await jobs.enqueue('execution.plan', { taskId }, { dedupeKey: `plan:${taskId}` })
      return { jobId: 'x' }
    },
    start: async () => ({ id: 'run' }),
  }
  const service = new SessionsService(prisma, events, jobs, settings, withNotices(orchestratorStub as object) as never, repoContext as never, executions as never, undefined, design)
  service.onModuleInit()
  return { service, jobs, clarificationCalls, planRequests, design }
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

beforeAll(async () => {
  await prisma.onModuleInit()
  await applyMigrations(prisma, MIGRATIONS_DIR)
  const repo = path.join(db.dir, 'repo')
  mkdirSync(repo)
  writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: repo })
  projectId = (await prisma.project.create({ data: { name: 'demo', repoPath: repo } })).id
})

afterAll(async () => {
  for (const queue of queues) await queue.onApplicationShutdown()
  await prisma.$disconnect()
  db.cleanup()
})

describe('deriveSessionStatus', () => {
  const base = { session: { archivedAt: null, lastActivityAt: new Date(), recovery: {} }, activePlanTaskIds: new Set<string>(), askRunning: false, now: Date.now() }
  const task = (status: string, currentStep = 'x', execution?: string) => ({ id: 't', status, currentStep, executions: execution ? [{ status: execution }] : [] })
  it('reports only what is actually running', () => {
    expect(deriveSessionStatus({ ...base, tasks: [task('running', 'running_agents', 'running')] })).toBe('running')
    expect(deriveSessionStatus({ ...base, tasks: [task('running', 'running_agents', 'interrupted')] })).toBe('interrupted')
    expect(deriveSessionStatus({ ...base, tasks: [task('running', 'running_agents', 'paused')] })).toBe('paused')
    expect(deriveSessionStatus({ ...base, tasks: [task('failed', 'plan_interrupted')] })).toBe('interrupted')
    expect(deriveSessionStatus({ ...base, tasks: [task('failed', 'plan_failed')] })).toBe('failed')
    expect(deriveSessionStatus({ ...base, tasks: [task('completed', 'applied', 'applied')] })).toBe('completed')
    expect(deriveSessionStatus({ ...base, tasks: [task('planned', 'awaiting_plan_approval')], session: { ...base.session, lastActivityAt: new Date(0) } })).toBe('active')
    expect(deriveSessionStatus({ ...base, tasks: [task('planned', 'plan_clarification')], session: { ...base.session, lastActivityAt: new Date(0) } })).toBe('active')
    expect(deriveSessionStatus({ ...base, tasks: [task('planned', 'plan_clarification', 'failed')], session: { ...base.session, lastActivityAt: new Date(0) } })).toBe('active')
    expect(deriveSessionStatus({ ...base, tasks: [], session: { ...base.session, lastActivityAt: new Date(0) } })).toBe('idle')
    expect(deriveSessionStatus({ ...base, tasks: [task('planning', 'planning')], activePlanTaskIds: new Set(['t']) })).toBe('running')
    expect(deriveSessionStatus({ ...base, tasks: [], session: { ...base.session, archivedAt: new Date() } })).toBe('archived')
  })

  it('maps the design phase: drafting runs, a draft waits for the user, a failed draft fails', () => {
    const old = { ...base.session, lastActivityAt: new Date(0) }
    expect(deriveSessionStatus({ ...base, tasks: [task('running', 'designing')], activePlanTaskIds: new Set(['t']) })).toBe('running')
    expect(deriveSessionStatus({ ...base, tasks: [task('planned', 'awaiting_design_approval')], session: old })).toBe('active')
    // an older failed run does not hide the open draft
    expect(deriveSessionStatus({ ...base, tasks: [task('planned', 'awaiting_design_approval', 'failed')], session: old })).toBe('active')
    expect(deriveSessionStatus({ ...base, tasks: [task('failed', 'design_failed')], session: old })).toBe('failed')
  })
})

describe('DESIGN_APPROVAL', () => {
  it('accepts plain confirmations only; anything with a request is feedback', () => {
    for (const text of ['passt', 'Passt so!', 'ok', 'OK, los', 'ja passt', 'sieht gut aus', 'freigeben.', 'Gefällt mir']) expect(DESIGN_APPROVAL.test(text), text).toBe(true)
    for (const text of ['ok, aber dunkler', 'passt nicht', 'Bitte mehr Abstand', 'los geht es mit einem anderen Layout', 'okay die Farben ändern']) expect(DESIGN_APPROVAL.test(text), text).toBe(false)
  })

  it('accepts polite approvals with fillers and emoji', () => {
    const approvals = ['Ja, bitte', 'passt so, danke', 'Gut', 'sehr gut', 'Mach weiter', 'Freigabe', 'ja gerne', '👍', 'OK 👍', 'gefällt mir sehr', 'Super, danke!', 'prima.', 'klasse', 'perfekt ✅', '👍🏽', 'top, weiter']
    for (const text of approvals) expect([text, designAnswer(text)]).toEqual([text, 'approval'])
  })
})

describe('designAnswer', () => {
  it('treats change requests as feedback, also short ones', () => {
    for (const text of ['ok, aber dunkler', 'passt nicht', 'dunkler', 'zu hell', 'größere Buttons', 'ohne Sidebar', 'mehr Kontrast', 'Mach es blau', 'less padding', 'Erstelle eine Variante mit viel Weißraum und runden Ecken']) expect([text, designAnswer(text)]).toEqual([text, 'feedback'])
  })

  it('marks short replies without approval or change hint as unclear', () => {
    for (const text of ['hmm', 'nein', 'bin zufrieden', 'Was meinst du?', 'interessant']) expect([text, designAnswer(text)]).toEqual([text, 'unclear'])
  })
})

describe('SessionsService', () => {
  it('persists a task message, links the task to the session and is idempotent per clientId', async () => {
    const { service } = makeSessions()
    const session = await service.create(projectId)
    const first = await service.send(session.id, { content: 'Baue eine Login-Seite', mode: 'task', clientId: 'client-msg-0001' })
    expect(first.duplicate).toBe(false)
    expect(first.session.status).toBe('running') // the plan job is queued
    expect(first.session.title).toBe('Baue eine Login-Seite')

    const again = await service.send(session.id, { content: 'Baue eine Login-Seite', mode: 'task', clientId: 'client-msg-0001' })
    expect(again.duplicate).toBe(true)
    expect(await prisma.task.count({ where: { sessionId: session.id } })).toBe(1)
    expect(await prisma.chatMessage.count({ where: { sessionId: session.id, role: 'user' } })).toBe(1)

    const detail = await service.get(session.id)
    expect(detail.activeTaskId).toBeTruthy()
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'system'])
    expect(detail.tasks[0]!.id).toBe(detail.activeTaskId)
  })

  async function taskInState(service: ReturnType<typeof makeSessions>['service'], currentStep: string) {
    const session = await service.create(projectId)
    await service.send(session.id, { content: 'Baue eine Login-Seite', mode: 'task' })
    const task = await prisma.task.findFirstOrThrow({ where: { sessionId: session.id } })
    await prisma.task.update({ where: { id: task.id }, data: { currentStep, status: 'planned' } })
    return { session, task }
  }

  it('feeds the answer to planner questions into the prompt as a clarification, not a follow-up', async () => {
    const { service, clarificationCalls, planRequests } = makeSessions()
    const { session, task } = await taskInState(service, 'plan_clarification')
    await prisma.chatMessage.create({ data: { projectId, sessionId: session.id, taskId: task.id, role: 'assistant', content: 'Rückfragen', metadata: { kind: 'plan_questions', questions: ['Welches Framework?', 'Mit Registrierung?'] } } })
    planRequests.length = 0

    await service.send(session.id, { content: 'React, ohne Registrierung', mode: 'task' })
    expect(clarificationCalls).toEqual([{ taskId: task.id, answer: 'React, ohne Registrierung' }])
    expect(await prisma.task.count({ where: { sessionId: session.id } })).toBe(1)
    const refined = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(refined.userPrompt).toBe('Baue eine Login-Seite\n\nClarification – the planner asked:\n1. Welches Framework?\n2. Mit Registrierung?\nThe user answered:\nReact, ohne Registrierung')
    expect(refined.userPrompt).not.toContain('Follow-up:')
    expect(planRequests).toHaveLength(1)
    expect(planRequests[0]!.taskId).toBe(task.id)
    expect(planRequests[0]!.feedback).toBeUndefined()
  })

  it('uses a plain follow-up when the task is not waiting for a clarification', async () => {
    const { service, clarificationCalls } = makeSessions()
    const { session, task } = await taskInState(service, 'awaiting_plan_approval')
    // Questions from an earlier, already answered clarification must not be picked up again.
    await prisma.chatMessage.create({ data: { projectId, sessionId: session.id, taskId: task.id, role: 'assistant', content: 'Rückfragen', metadata: { kind: 'plan_questions', questions: ['Welches Framework?'] } } })

    await service.send(session.id, { content: 'Bitte mit Dark Mode', mode: 'task' })
    expect(clarificationCalls).toEqual([])
    expect(await prisma.task.count({ where: { sessionId: session.id } })).toBe(1)
    const refined = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(refined.userPrompt).toBe('Baue eine Login-Seite\n\nFollow-up: Bitte mit Dark Mode')
  })

  it('refines the same task with the answer even if an older execution exists', async () => {
    const { service, clarificationCalls } = makeSessions()
    const { session, task } = await taskInState(service, 'plan_clarification')
    await prisma.executionRun.create({ data: { taskId: task.id, projectId, status: 'failed' } })
    await prisma.chatMessage.create({ data: { projectId, sessionId: session.id, taskId: task.id, role: 'assistant', content: 'Rückfragen', metadata: { kind: 'plan_questions', questions: ['Welches Framework?'] } } })

    await service.send(session.id, { content: 'React', mode: 'task' })
    expect(clarificationCalls).toEqual([{ taskId: task.id, answer: 'React' }])
    expect(await prisma.task.count({ where: { sessionId: session.id } })).toBe(1)
    const refined = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(refined.userPrompt).toBe('Baue eine Login-Seite\n\nClarification – the planner asked:\n1. Welches Framework?\nThe user answered:\nReact')
  })

  it('starts a new task after an execution when no clarification is pending', async () => {
    const { service, clarificationCalls } = makeSessions()
    const { session, task } = await taskInState(service, 'awaiting_plan_approval')
    await prisma.executionRun.create({ data: { taskId: task.id, projectId, status: 'failed' } })

    await service.send(session.id, { content: 'Jetzt mit Dark Mode', mode: 'task' })
    expect(clarificationCalls).toEqual([])
    expect(await prisma.task.count({ where: { sessionId: session.id } })).toBe(2)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).userPrompt).toBe('Baue eine Login-Seite')
  })

  it('falls back to a follow-up when the clarification has no stored questions', async () => {
    const { service, clarificationCalls } = makeSessions()
    const { session, task } = await taskInState(service, 'plan_clarification')

    await service.send(session.id, { content: 'React', mode: 'task' })
    expect(clarificationCalls).toEqual([{ taskId: task.id, answer: 'React' }])
    const refined = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(refined.userPrompt).toBe('Baue eine Login-Seite\n\nFollow-up: React')
  })

  describe('design phase in the chat', () => {
    const lastMessage = async (sessionId: string) => prisma.chatMessage.findFirstOrThrow({ where: { sessionId }, orderBy: { createdAt: 'desc' } })
    const drafts = (taskId: string) => prisma.designDraft.findMany({ where: { taskId }, orderBy: { version: 'asc' } })

    it('announces the design draft instead of planning when the gate takes over', async () => {
      const { service, planRequests } = makeSessions(undefined, undefined, { designNext: true })
      const session = await service.create(projectId)
      const sent = await service.send(session.id, { content: 'Baue ein CRM-Dashboard', mode: 'task' })
      expect(planRequests).toHaveLength(1)
      const task = await prisma.task.findFirstOrThrow({ where: { sessionId: session.id } })
      expect(task.currentStep).toBe('designing')
      expect(sent.session.status).toBe('running') // the design job is queued
      const last = await lastMessage(session.id)
      expect(last.content).toBe(DESIGN_START_TEXT)
      expect(last.metadata).toMatchObject({ kind: 'design_requested' })
      expect(await prisma.chatMessage.count({ where: { sessionId: session.id, content: { contains: 'Analysiere das Repository' } } })).toBe(0)
    })

    it('approves the open draft with "passt" and starts planning', async () => {
      const { service, planRequests } = makeSessions()
      const { session, task } = await taskInState(service, 'awaiting_design_approval')
      await prisma.designDraft.create({ data: { taskId: task.id, version: 1, status: 'draft', summary: 'v1' } })
      planRequests.length = 0

      const sent = await service.send(session.id, { content: 'Passt so!', mode: 'task' })
      expect(sent.message.metadata).toMatchObject({ kind: 'design_approval' })
      expect((await drafts(task.id)).map((draft) => draft.status)).toEqual(['approved'])
      expect(planRequests).toEqual([{ taskId: task.id, feedback: undefined, autoStart: false }])
      expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).currentStep).toBe('planning')
      const last = await lastMessage(session.id)
      expect(last.metadata).toMatchObject({ kind: 'planning' })
      expect(last.content).toContain('Design freigegeben')
      expect(await prisma.task.count({ where: { sessionId: session.id } })).toBe(1)
    })

    it('turns any other message into feedback for the next draft version', async () => {
      const { service, planRequests, jobs } = makeSessions()
      const { session, task } = await taskInState(service, 'awaiting_design_approval')
      await prisma.designDraft.create({ data: { taskId: task.id, version: 1, status: 'draft', summary: 'v1' } })
      planRequests.length = 0

      await service.send(session.id, { content: 'ok, aber dunkler und mit mehr Abstand', mode: 'task' })
      const [v1, v2] = await drafts(task.id)
      expect(v1).toMatchObject({ status: 'rejected', feedback: 'ok, aber dunkler und mit mehr Abstand' })
      expect(v2).toMatchObject({ version: 2, status: 'generating', feedback: 'ok, aber dunkler und mit mehr Abstand' })
      const refined = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
      expect(refined.currentStep).toBe('designing')
      expect(refined.userPrompt).toBe('Baue eine Login-Seite')
      expect(planRequests).toEqual([])
      expect(await jobs.activeFor('design.create', (payload) => payload.taskId === task.id)).toHaveLength(1)
      expect((await lastMessage(session.id)).metadata).toMatchObject({ kind: 'design_requested' })
    })

    it('asks back on a short unclear reply instead of drafting again or approving', async () => {
      const { service, planRequests, jobs } = makeSessions()
      const { session, task } = await taskInState(service, 'awaiting_design_approval')
      await prisma.designDraft.create({ data: { taskId: task.id, version: 1, status: 'draft', summary: 'v1' } })
      planRequests.length = 0

      const sent = await service.send(session.id, { content: 'hmm, naja', mode: 'task' })
      expect(sent.message.metadata).toMatchObject({ kind: 'design_unclear' })
      expect((await drafts(task.id)).map((draft) => draft.status)).toEqual(['draft'])
      expect(planRequests).toEqual([])
      expect(await jobs.activeFor('design.create', (payload) => payload.taskId === task.id)).toHaveLength(0)
      expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).currentStep).toBe('awaiting_design_approval')
      expect(await lastMessage(session.id)).toMatchObject({ role: 'assistant', content: DESIGN_UNCLEAR_TEXT, metadata: { kind: 'design_unclear' } })
    })

    it('approves a polite chat approval ("Ja, bitte")', async () => {
      const { service, planRequests } = makeSessions()
      const { session, task } = await taskInState(service, 'awaiting_design_approval')
      await prisma.designDraft.create({ data: { taskId: task.id, version: 1, status: 'draft', summary: 'v1' } })
      planRequests.length = 0

      const sent = await service.send(session.id, { content: 'Ja, bitte', mode: 'task' })
      expect(sent.message.metadata).toMatchObject({ kind: 'design_approval' })
      expect((await drafts(task.id)).map((draft) => draft.status)).toEqual(['approved'])
      expect(planRequests).toHaveLength(1)
    })

    it('only notes a message while the draft is being generated (no new draft, no plan, no new task)', async () => {
      const { service, planRequests } = makeSessions()
      const { session, task } = await taskInState(service, 'designing')
      planRequests.length = 0

      const sent = await service.send(session.id, { content: 'Und bitte mit Logo', mode: 'task' })
      expect(sent.message.metadata).toMatchObject({ kind: 'design_pending' })
      expect(await drafts(task.id)).toEqual([])
      expect(planRequests).toEqual([])
      expect(await prisma.task.count({ where: { sessionId: session.id } })).toBe(1)
      const unchanged = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
      expect(unchanged).toMatchObject({ currentStep: 'designing', userPrompt: 'Baue eine Login-Seite' })
      expect(await lastMessage(session.id)).toMatchObject({ role: 'system', content: DESIGN_PENDING_TEXT })
    })

    it('retries a failed design with the message as follow-up and feedback', async () => {
      const { service, planRequests } = makeSessions(undefined, undefined, { designNext: true })
      const session = await service.create(projectId)
      await service.send(session.id, { content: 'Baue ein CRM-Dashboard', mode: 'task' })
      const task = await prisma.task.findFirstOrThrow({ where: { sessionId: session.id } })
      await prisma.designDraft.updateMany({ where: { taskId: task.id }, data: { status: 'failed' } })
      for (const job of await prisma.job.findMany({ where: { type: 'design.create', status: 'queued' } })) {
        if ((job.payload as Record<string, unknown>).taskId === task.id) await prisma.job.update({ where: { id: job.id }, data: { status: 'failed' } })
      }
      await prisma.task.update({ where: { id: task.id }, data: { currentStep: 'design_failed', status: 'failed' } })
      planRequests.length = 0

      await service.send(session.id, { content: 'Nochmal, bitte heller', mode: 'task' })
      expect(planRequests).toEqual([{ taskId: task.id, feedback: 'Nochmal, bitte heller', autoStart: false }])
      expect(await prisma.task.count({ where: { sessionId: session.id } })).toBe(1)
      const retried = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
      expect(retried).toMatchObject({ currentStep: 'designing', userPrompt: 'Baue ein CRM-Dashboard\n\nFollow-up: Nochmal, bitte heller' })
      expect((await drafts(task.id)).map((draft) => [draft.version, draft.status, draft.feedback])).toEqual([[1, 'failed', null], [2, 'generating', 'Nochmal, bitte heller']])
      expect((await lastMessage(session.id)).content).toBe(DESIGN_START_TEXT)
    })

    it('marks a design cut off by a restart as failed; a design with a live job keeps running', async () => {
      const { service, design } = makeSessions()
      const stuck = await service.create(projectId)
      const live = await service.create(projectId)
      const stuckTask = await prisma.task.create({ data: { projectId, sessionId: stuck.id, userPrompt: 'Baue ein CRM', currentStep: 'draft' } })
      const liveTask = await prisma.task.create({ data: { projectId, sessionId: live.id, userPrompt: 'Baue ein Dashboard', currentStep: 'draft' } })
      await design.start(stuckTask.id)
      await design.start(liveTask.id)
      // the app stopped: the job of the first task is gone, the task still says "designing"
      for (const job of await prisma.job.findMany({ where: { type: 'design.create', status: 'queued' } })) {
        if ((job.payload as Record<string, unknown>).taskId === stuckTask.id) await prisma.job.update({ where: { id: job.id }, data: { status: 'failed' } })
      }

      const restarted = makeSessions().service
      await restarted.recover()
      expect((await prisma.task.findUniqueOrThrow({ where: { id: stuckTask.id } })).currentStep).toBe('design_failed')
      expect((await drafts(stuckTask.id)).map((draft) => draft.status)).toEqual(['failed'])
      const detail = await restarted.get(stuck.id)
      expect(detail.status).toBe('failed')
      expect(detail.messages.at(-1)!.metadata).toMatchObject({ kind: 'design_error', interrupted: true })
      expect((await prisma.task.findUniqueOrThrow({ where: { id: liveTask.id } })).currentStep).toBe('designing')
      expect((await restarted.get(live.id)).status).toBe('running')
    })
  })

  it('answers a question as a background job and keeps it in the session history', async () => {
    const { service } = makeSessions()
    const session = await service.create(projectId)
    await service.send(session.id, { content: 'Wie ist das Projekt aufgebaut?', mode: 'ask', clientId: 'client-ask-0001' })
    // the answer is stored first, the pending marker is cleared right after (under the session lock)
    const answered = await waitFor(async () => {
      const detail = await service.get(session.id)
      const recovery = (await prisma.chatSession.findUniqueOrThrow({ where: { id: session.id } })).recovery as Record<string, unknown>
      return detail.messages.some((message) => message.role === 'assistant') && recovery.pendingAsk === undefined && detail
    })
    expect(answered.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(answered.messages[1]!.content).toContain('Antwort auf: Wie ist das Projekt aufgebaut?')
    const stored = await prisma.chatSession.findUniqueOrThrow({ where: { id: session.id } })
    expect(stored.externalSessionId).toBe('thread-123')
    expect((stored.recovery as Record<string, unknown>).pendingAsk).toBeUndefined()
    // A new UI instance (reload) sees the same history.
    expect((await makeSessions().service.get(session.id)).messages).toHaveLength(2)
  })

  it('books the measured usage of a rejected chat answer on the failed model call', async () => {
    const failing = {
      active: async () => ({
        id: 'codex',
        displayName: 'Codex',
        chat: async () => {
          throw new OrchestratorError('bad', 'invalid_output', { meta: { sessionId: 'err-sess-1', model: 'fake-err', durationMs: 5, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, measured: true, billing: 'api_key' } } })
        },
      }),
    }
    const { service } = makeSessions(undefined, failing)
    const session = await service.create(projectId)
    await service.send(session.id, { content: 'Frage mit Fehler?', mode: 'ask', clientId: 'client-ask-err01' })
    const call = await waitFor(async () => (await prisma.modelCall.findFirst({ where: { purpose: 'chat', status: 'error', sessionId: 'err-sess-1' } })) ?? undefined)
    expect(call).toMatchObject({ model: 'fake-err', inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, tokensMeasured: true, errorClass: 'invalid_output', billing: 'api_key' })
  })

  it('duo chat: both answer, the partner session is stored and resumed, every call is booked', async () => {
    const { DuoOrchestrator } = await import('@multi-ai-coder/engine')
    const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, measured: true, billing: 'subscription' as const }
    const calls: Array<{ id: string; resume?: string; partnerResume?: unknown }> = []
    const side = (id: 'claude-code' | 'codex', displayName: string) => ({
      id,
      displayName,
      chat: async (input: { question: string; resumeSessionId?: string; partnerResumeSessionId?: string }) => {
        calls.push({ id, resume: input.resumeSessionId, partnerResume: input.partnerResumeSessionId })
        return { result: { answer: `${displayName}: ${input.question}` }, meta: { sessionId: `${id}-thread`, model: `${id}-model`, durationMs: 5, usage } }
      },
    })
    const duo = new DuoOrchestrator(side('claude-code', 'Claude Code') as never, side('codex', 'Codex') as never)
    const overrides: unknown[] = []
    const stub = { activeWithNotice: async (override?: unknown) => (overrides.push(override), { adapter: duo }) }
    const { service } = makeSessions(undefined, stub)
    const session = await service.create(projectId)
    const answers = async (count: number) => waitFor(async () => {
      const detail = await service.get(session.id)
      const done = detail.messages.filter((message) => message.role === 'assistant').length >= count
      const pending = ((await prisma.chatSession.findUniqueOrThrow({ where: { id: session.id } })).recovery as Record<string, unknown>).pendingAsk
      return done && pending === undefined && detail
    })
    await service.send(session.id, { content: 'Erste Frage?', mode: 'ask', clientId: 'client-duo-ask-1', orchestrator: 'duo' })
    const first = await answers(1)
    expect(overrides).toEqual(['duo'])
    expect(first.messages[0]!.metadata).toMatchObject({ kind: 'question', askOrchestrator: 'duo' })
    expect((first.messages[0]!.metadata as { orchestrator?: unknown }).orchestrator).toBeUndefined()
    const answer = first.messages.find((message) => message.role === 'assistant')!
    expect(answer.content).toBe('Claude Code: Erste Frage?')
    expect(answer.metadata).toMatchObject({ kind: 'answer', orchestrator: 'claude-code', duo: { lead: 'claude-code', partner: 'codex', partnerAnswer: 'Codex: Erste Frage?', partnerSessionId: 'codex-thread' } })
    // the session keeps the lead's CLI session (the duo's id is the lead's)
    expect(await prisma.chatSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ provider: 'claude-code', externalSessionId: 'claude-code-thread' })
    const booked = await prisma.modelCall.findMany({ where: { purpose: 'chat', sessionId: { in: ['claude-code-thread', 'codex-thread'] } } })
    expect(booked.map((call) => call.provider).sort()).toEqual(['claude-code', 'codex'])

    await service.send(session.id, { content: 'Zweite Frage?', mode: 'ask', clientId: 'client-duo-ask-2', orchestrator: 'duo' })
    await answers(2)
    // each CLI resumes its own session; the partner's id never reaches the lead
    expect(calls.slice(2)).toEqual([{ id: 'claude-code', resume: 'claude-code-thread', partnerResume: undefined }, { id: 'codex', resume: 'codex-thread', partnerResume: undefined }])
    const latest = (await service.get(session.id)).messages.filter((message) => message.role === 'assistant').at(-1)!
    expect(latest.metadata).toMatchObject({ resumedSession: true, duo: { partnerSessionId: 'codex-thread', partnerResumed: true } })
  })

  it('posts the hint when the requested duo is not possible and answers with the remaining CLI', async () => {
    const single = { id: 'claude-code', displayName: 'Claude Code', chat: async () => ({ result: { answer: 'allein' }, meta: { durationMs: 1, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, measured: false, billing: 'unknown' } } }) }
    const notice = 'Duo-Modus nicht möglich: Codex ist nicht angemeldet – Claude Code arbeitet allein.'
    const { service } = makeSessions(undefined, { activeWithNotice: async () => ({ adapter: single, notice }) })
    const session = await service.create(projectId)
    await service.send(session.id, { content: 'Frage im Duo?', mode: 'ask', clientId: 'client-duo-ask-3', orchestrator: 'duo' })
    const detail = await waitFor(async () => {
      const current = await service.get(session.id)
      return current.messages.some((message) => message.role === 'assistant') && current
    })
    expect(detail.messages.map((message) => [message.role, (message.metadata as { kind?: string }).kind])).toEqual([['user', 'question'], ['system', 'orchestrator_notice'], ['assistant', 'answer']])
    expect(detail.messages[1]!.content).toBe(notice)
    expect(detail.messages[2]!.metadata).toMatchObject({ orchestrator: 'claude-code' })
    expect((detail.messages[2]!.metadata as { duo?: unknown }).duo).toBeUndefined()
  })

  it('keeps the composer choice on the task message (the task resolves its orchestrator from it)', async () => {
    const { service } = makeSessions()
    const session = await service.create(projectId)
    await service.send(session.id, { content: 'Baue eine Liste', mode: 'task', clientId: 'client-duo-task-1', orchestrator: 'codex' })
    const task = await prisma.task.findFirstOrThrow({ where: { sessionId: session.id } })
    const { taskOverride } = await import('../orchestration/orchestrator-choice.js')
    expect(await taskOverride(prisma, task.id)).toBe('codex')
    const message = await prisma.chatMessage.findFirstOrThrow({ where: { clientId: 'client-duo-task-1' } })
    expect(message.metadata).toMatchObject({ source: 'session_chat', orchestrator: 'codex' })
  })

  it('a plain question is answered with its own choice but does not change the task orchestrator', async () => {
    const overrides: unknown[] = []
    const single = { id: 'claude-code', displayName: 'Claude Code', chat: async () => ({ result: { answer: 'ok' }, meta: { durationMs: 1, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, measured: false, billing: 'unknown' } } }) }
    const { service } = makeSessions(undefined, { activeWithNotice: async (override?: unknown) => (overrides.push(override), { adapter: single }) })
    const session = await service.create(projectId)
    await service.send(session.id, { content: 'Baue eine Tabelle', mode: 'task', clientId: 'client-ask-own-1', orchestrator: 'codex' })
    const task = await prisma.task.findFirstOrThrow({ where: { sessionId: session.id } })
    await service.send(session.id, { content: 'Wie heißt die Datei?', mode: 'ask', clientId: 'client-ask-own-2', orchestrator: 'claude-code' })
    await waitFor(async () => (await service.get(session.id)).messages.some((message) => message.role === 'assistant'))
    expect(overrides).toEqual(['claude-code'])
    const question = await prisma.chatMessage.findFirstOrThrow({ where: { clientId: 'client-ask-own-2' } })
    expect(question).toMatchObject({ taskId: task.id, metadata: { kind: 'question', askOrchestrator: 'claude-code' } })
    const { taskOverride } = await import('../orchestration/orchestrator-choice.js')
    expect(await taskOverride(prisma, task.id)).toBe('codex')
    // older questions stored the choice as orchestrator: they do not count either
    await prisma.chatMessage.create({ data: { projectId, sessionId: session.id, taskId: task.id, role: 'user', content: 'alt', metadata: { kind: 'question', orchestrator: 'duo' } } })
    expect(await taskOverride(prisma, task.id)).toBe('codex')
  })

  it('marks planning that was cut off by a restart as interrupted instead of running forever', async () => {
    const { service } = makeSessions()
    const session = await service.create(projectId)
    await service.send(session.id, { content: 'Refactor', mode: 'task' })
    const task = await prisma.task.findFirstOrThrow({ where: { sessionId: session.id } })
    // the app stopped: the plan job is gone, the task still says "planning"
    await prisma.job.updateMany({ where: { type: 'execution.plan' }, data: { status: 'failed' } })

    const restarted = makeSessions().service
    await restarted.recover()
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).currentStep).toBe('plan_interrupted')
    const detail = await restarted.get(session.id)
    expect(detail.status).toBe('interrupted')
    expect(detail.messages.at(-1)!.metadata).toMatchObject({ kind: 'plan_interrupted' })
  })

  it('records an ask job that was running during a crash as interrupted (no automatic premium call)', async () => {
    const { service } = makeSessions()
    const session = await service.create(projectId)
    const question = await prisma.chatMessage.create({ data: { projectId, sessionId: session.id, role: 'user', content: 'Frage?' } })
    await prisma.job.create({ data: { type: 'chat.ask', status: 'running', payload: { sessionId: session.id, messageId: question.id } } })

    const jobs = new JobQueueService(prisma, events)
    const recovered = makeSessions(jobs).service
    await jobs.start() // job recovery runs the sessions' recovery hook
    await recovered.recover()
    const detail = await recovered.get(session.id)
    expect(detail.status).toBe('interrupted')
    expect(detail.messages.some((message) => (message.metadata as Record<string, unknown>).kind === 'answer_interrupted')).toBe(true)
    expect(await prisma.chatMessage.count({ where: { sessionId: session.id, role: 'assistant' } })).toBe(0)
  })

  it('archives, pins, renames, searches and exports sessions', async () => {
    const { service } = makeSessions()
    const session = await service.create(projectId, 'Alt')
    await prisma.chatMessage.create({ data: { projectId, sessionId: session.id, role: 'user', content: 'Suchbegriff Zebra im Verlauf' } })
    expect((await service.update(session.id, { title: 'Neu', pinned: true })).pinned).toBe(true)
    expect((await service.list(projectId))[0]!.id).toBe(session.id)
    expect((await service.search(projectId, 'Zebra'))[0]!.sessionId).toBe(session.id)
    expect((await service.update(session.id, { archived: true })).status).toBe('archived')
    expect((await service.list(projectId)).some((entry) => entry.id === session.id)).toBe(false)
    expect((await service.list(projectId, { includeArchived: true })).some((entry) => entry.id === session.id)).toBe(true)
    const markdown = await service.export(session.id, 'md')
    expect(markdown.content).toContain('# Neu')
    expect(markdown.content).toContain('Zebra')
  })
})

describe('ExecutionService.start', () => {
  it('creates exactly one run when started concurrently (double click / repeated request)', async () => {
    const task = await prisma.task.create({ data: { projectId, userPrompt: 'x', currentStep: 'awaiting_plan_approval', status: 'planned' } })
    await prisma.subtask.create({ data: { taskId: task.id, title: 'x', goal: 'x', assignedAgentType: 'LocalCoderAgent', selectedModelClass: 'local_llm', expectedChange: 'x' } })
    const jobs = new JobQueueService(prisma, events)
    queues.push(jobs)
    const execution = new ExecutionService(prisma, settings, { active: async () => undefined } as never, {} as never, {} as never, jobs, events)
    const runs = await Promise.all([execution.start(task.id), execution.start(task.id), execution.start(task.id)])
    expect(new Set(runs.map((run) => run.id)).size).toBe(1)
    expect(await prisma.executionRun.count({ where: { taskId: task.id } })).toBe(1)
    expect(await prisma.job.count({ where: { type: 'execution.run' } })).toBe(1)
  })
})
