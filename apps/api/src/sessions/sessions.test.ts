import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const db = useTempDatabase('mac-sessions-')
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { JobQueueService } = await import('../runtime/job-queue.service.js')
const { SettingsService } = await import('../runtime/settings.service.js')
const { ExecutionService } = await import('../execution/execution.service.js')
const { SessionsService, deriveSessionStatus } = await import('./sessions.service.js')

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

function makeSessions(jobs = new JobQueueService(prisma, events)) {
  queues.push(jobs)
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
      await prisma.task.update({ where: { id: taskId }, data: { currentStep: 'planning', status: 'running' } })
      await jobs.enqueue('execution.plan', { taskId }, { dedupeKey: `plan:${taskId}` })
      return { jobId: 'x' }
    },
    start: async () => ({ id: 'run' }),
  }
  const service = new SessionsService(prisma, events, jobs, settings, orchestrators as never, repoContext as never, executions as never)
  service.onModuleInit()
  return { service, jobs, clarificationCalls, planRequests }
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
