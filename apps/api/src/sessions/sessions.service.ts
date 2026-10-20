import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { AgentResourcesService } from '../agents/agent-resources.service.js'
import { Prisma, type ChatMessage, type ChatSession, type ExecutionStatus, type Job } from '@prisma/client'
import type { Subscription } from 'rxjs'
import { PrismaService } from '../common/prisma.service.js'
import { asJson, jsonObject } from '../common/json.js'
import { ExecutionService } from '../execution/execution.service.js'
import { RepoContextService } from '../execution/repo-context.service.js'
import { OrchestratorService } from '../orchestration/orchestrator.service.js'
import { failedCallFields } from '../orchestration/model-call.js'
import { EventBusService, type AppEvent } from '../runtime/event-bus.service.js'
import { KeyedMutex } from '../common/locks.js'
import { JobQueueService } from '../runtime/job-queue.service.js'
import { SettingsService } from '../runtime/settings.service.js'
import { DEFAULT_TITLE, deriveSessionStatus, RUN_CONFIRMATION, RUNNING_EXECUTION, titleFrom, type SessionStatus } from './session-model.js'

export { deriveSessionStatus, SESSION_STATUSES, titleFrom, type SessionStatus } from './session-model.js'

export interface SendInput {
  content: string
  mode: 'task' | 'ask'
  autoRun?: boolean
  /** Client-generated idempotency key. */
  clientId?: string
}

/**
 * Orchestrator conversations. A session owns its messages and tasks; it lives in the runtime and the
 * database, never in a UI component, so navigating, reloading the window or restarting the app
 * cannot end it. Long-running work (planning, runs, questions) are jobs that report back here.
 */
@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Sessions')
  private subscription?: Subscription
  private readonly pendingRefresh = new Map<string, NodeJS.Timeout>()
  private readonly sessionByExecution = new Map<string, string | null>()
  private readonly sessionByTask = new Map<string, string | null>()
  private readonly sendLocks = new KeyedMutex()

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    private readonly jobs: JobQueueService,
    private readonly settings: SettingsService,
    private readonly orchestrators: OrchestratorService,
    private readonly repoContext: RepoContextService,
    private readonly executions: ExecutionService,
    @Optional() private readonly agentResources?: AgentResourcesService,
  ) {}

  onModuleInit() {
    this.jobs.register('chat.ask', (payload) => this.answerJob(String(payload.sessionId), String(payload.messageId)), { concurrency: 2, onRecover: 'interrupt' })
    this.jobs.onRecovered((job, outcome) => this.onJobRecovered(job, outcome))
    this.subscription = this.events.stream().subscribe((event) => this.onEvent(event))
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe()
    for (const timer of this.pendingRefresh.values()) clearTimeout(timer)
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async list(projectId: string, options: { includeArchived?: boolean; query?: string } = {}) {
    const sessions = await this.prisma.chatSession.findMany({
      where: {
        projectId,
        ...(options.includeArchived ? {} : { archivedAt: null }),
        ...(options.query ? { OR: [{ title: { contains: options.query } }, { messages: { some: { content: { contains: options.query } } } }] } : {}),
      },
      orderBy: [{ pinned: 'desc' }, { lastActivityAt: 'desc' }],
      take: 200,
      include: { _count: { select: { messages: true, tasks: true } } },
    })
    return sessions.map((session) => this.summary(session))
  }

  private summary(session: ChatSession & { _count?: { messages: number; tasks: number } }) {
    return {
      id: session.id,
      projectId: session.projectId,
      title: session.title,
      status: session.status as SessionStatus,
      provider: session.provider,
      externalSessionId: session.externalSessionId,
      pinned: session.pinned,
      archivedAt: session.archivedAt,
      lastActivityAt: session.lastActivityAt,
      activeTaskId: session.activeTaskId,
      createdAt: session.createdAt,
      messageCount: session._count?.messages,
      taskCount: session._count?.tasks,
      recovery: jsonObject(session.recovery),
    }
  }

  async get(sessionId: string, options: { limit?: number; before?: string } = {}) {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId }, include: { _count: { select: { messages: true, tasks: true } } } })
    if (!session) throw new NotFoundException('Session not found.')
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500)
    const page = await this.prisma.chatMessage.findMany({
      where: { sessionId, ...(options.before ? { createdAt: { lt: new Date(options.before) } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    })
    const tasks = await this.prisma.task.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, userPrompt: true, status: true, currentStep: true, createdAt: true, executions: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true } } },
    })
    return {
      ...this.summary(session),
      messages: page.slice(0, limit).reverse(),
      hasMore: page.length > limit,
      tasks: tasks.map((task) => ({ id: task.id, title: titleFrom(task.userPrompt), status: task.status, currentStep: task.currentStep, createdAt: task.createdAt, execution: task.executions[0] ?? null })),
    }
  }

  async search(projectId: string, query: string) {
    if (!query.trim()) return []
    const hits = await this.prisma.chatMessage.findMany({
      where: { projectId, content: { contains: query.trim() }, sessionId: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { session: { select: { id: true, title: true, archivedAt: true } } },
    })
    return hits.map((hit) => {
      const index = hit.content.toLowerCase().indexOf(query.trim().toLowerCase())
      const start = Math.max(0, index - 60)
      return { messageId: hit.id, sessionId: hit.sessionId, sessionTitle: hit.session?.title, archived: Boolean(hit.session?.archivedAt), role: hit.role, createdAt: hit.createdAt, excerpt: `${start ? '…' : ''}${hit.content.slice(start, start + 200)}` }
    })
  }

  async export(sessionId: string, format: 'md' | 'json') {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId }, include: { project: { select: { name: true } } } })
    if (!session) throw new NotFoundException('Session not found.')
    const messages = await this.prisma.chatMessage.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } })
    const fileName = `${session.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'session'}.${format}`
    if (format === 'json') {
      return { fileName, mimeType: 'application/json', content: JSON.stringify({ session: { id: session.id, title: session.title, project: session.project.name, createdAt: session.createdAt, status: session.status }, messages: messages.map((message) => ({ role: message.role, content: message.content, createdAt: message.createdAt, metadata: message.metadata })) }, null, 2) }
    }
    const who: Record<string, string> = { user: 'Du', assistant: 'Orchestrator', agent: 'Agenten', system: 'System' }
    const lines = [`# ${session.title}`, '', `Projekt: ${session.project.name} · erstellt ${session.createdAt.toISOString()} · Status: ${session.status}`, '']
    for (const message of messages) lines.push(`## ${who[message.role] ?? message.role} · ${message.createdAt.toISOString()}`, '', message.content, '')
    return { fileName, mimeType: 'text/markdown', content: lines.join('\n') }
  }

  /** Running work across all projects (status bar, background job indicator). */
  async activity() {
    const [executions, plans, asks] = await Promise.all([
      this.prisma.executionRun.findMany({
        where: { status: { in: [...RUNNING_EXECUTION, 'paused'] as ExecutionStatus[] } },
        select: { id: true, status: true, projectId: true, taskId: true, startedAt: true, task: { select: { userPrompt: true, sessionId: true } } },
      }),
      this.jobs.activeFor('execution.plan', () => true),
      this.jobs.activeFor('chat.ask', () => true),
    ])
    const planTasks = await this.prisma.task.findMany({ where: { id: { in: plans.map((job) => String((job.payload as Record<string, unknown>).taskId)) } }, select: { id: true, projectId: true, sessionId: true, userPrompt: true } })
    return {
      executions: executions.map((run) => ({ id: run.id, status: run.status, projectId: run.projectId, taskId: run.taskId, sessionId: run.task.sessionId, title: titleFrom(run.task.userPrompt), startedAt: run.startedAt })),
      plans: planTasks.map((task) => ({ taskId: task.id, projectId: task.projectId, sessionId: task.sessionId, title: titleFrom(task.userPrompt) })),
      asks: asks.map((job) => ({ jobId: job.id, sessionId: String((job.payload as Record<string, unknown>).sessionId) })),
    }
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  async create(projectId: string, title?: string) {
    await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    const session = await this.prisma.chatSession.create({ data: { projectId, title: title?.trim() ? titleFrom(title) : DEFAULT_TITLE, status: 'active' } })
    this.publish(session)
    return this.summary(session)
  }

  /** Session of a task, or the project's question session (questions asked without a task). */
  async sessionForMessage(projectId: string, taskId?: string): Promise<string> {
    if (taskId) {
      const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { sessionId: true } })
      if (task?.sessionId) return task.sessionId
    }
    const existing = await this.prisma.chatSession.findFirst({ where: { projectId, title: 'Fragen', archivedAt: null }, orderBy: { lastActivityAt: 'desc' } })
    return existing?.id ?? (await this.create(projectId, 'Fragen')).id
  }

  async update(sessionId: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) {
    const session = await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 120) || DEFAULT_TITLE } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        ...(patch.archived !== undefined ? { archivedAt: patch.archived ? new Date() : null } : {}),
      },
    })
    const refreshed = await this.refresh(session.id)
    return this.summary(refreshed ?? session)
  }

  async remove(sessionId: string) {
    const status = (await this.refresh(sessionId))?.status
    if (status === 'running' || status === 'paused') throw new BadRequestException('Die Sitzung hat laufende Arbeit. Brich sie zuerst ab oder archiviere die Sitzung.')
    const session = await this.prisma.chatSession.delete({ where: { id: sessionId } })
    this.events.publish('project', 'session_deleted', { sessionId, projectId: session.projectId }, session.projectId)
    return { ok: true }
  }

  /**
   * Persists a user message and starts the work it asks for. The message is committed before this
   * resolves, so the UI only shows it as sent once it is durable. A repeated clientId returns the
   * original result instead of starting the work twice (double click, retry after reload).
   */
  async send(sessionId: string, input: SendInput) {
    const content = input.content?.trim()
    if (!content) throw new BadRequestException('Message content is required.')
    if (content.length > 50_000) throw new BadRequestException('Message is too long.')
    if (input.clientId !== undefined && !/^[\w-]{8,80}$/.test(input.clientId)) throw new BadRequestException('Invalid clientId.')
    return this.sendLocks.run(sessionId, async () => {
      if (input.clientId) {
        const existing = await this.prisma.chatMessage.findUnique({ where: { clientId: input.clientId } })
        if (existing) return { session: await this.get(sessionId, { limit: 1 }), message: existing, duplicate: true }
      }
      const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId } })
      if (!session) throw new NotFoundException('Session not found.')
      if (session.archivedAt) await this.prisma.chatSession.update({ where: { id: sessionId }, data: { archivedAt: null } })
      const message = input.mode === 'ask' ? await this.sendQuestion(session, content, input.clientId) : await this.sendTask(session, content, Boolean(input.autoRun), input.clientId)
      await this.touch(session, content)
      return { session: this.summary((await this.refresh(sessionId))!), message, duplicate: false }
    })
  }

  private async touch(session: ChatSession, content: string) {
    await this.prisma.chatSession.update({
      where: { id: session.id },
      data: { lastActivityAt: new Date(), ...(session.title === DEFAULT_TITLE ? { title: titleFrom(content) } : {}) },
    })
  }

  private async sendTask(session: ChatSession, content: string, autoRun: boolean, clientId?: string): Promise<ChatMessage> {
    const active = session.activeTaskId ? await this.prisma.task.findUnique({ where: { id: session.activeTaskId }, include: { executions: { orderBy: { createdAt: 'desc' }, take: 1 }, subtasks: { select: { id: true }, take: 1 } } }) : null
    const execution = active?.executions[0]

    // "ja/start" while a plan waits for approval starts the run.
    if (active && active.subtasks.length && !execution && RUN_CONFIRMATION.test(content) && ['awaiting_plan_approval', 'planned'].includes(active.currentStep)) {
      const message = await this.prisma.chatMessage.create({ data: { projectId: session.projectId, sessionId: session.id, taskId: active.id, clientId, role: 'user', content, metadata: asJson({ source: 'session_chat', kind: 'run_confirmation' }) } })
      this.published(message)
      try {
        const run = await this.executions.start(active.id)
        await this.systemMessage(session, active.id, 'agent', 'Ausführung gestartet. Agenten arbeiten jetzt in isolierten Worktrees; der Fortschritt erscheint in der Agentenansicht.', { kind: 'execution_started', executionId: run.id })
      } catch (error) {
        // The message is already durable; the failure is reported in the conversation instead of failing the send.
        await this.systemMessage(session, active.id, 'system', `Die Ausführung konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}`, { kind: 'execution_error' })
      }
      return message
    }

    // A task that has not been executed yet is refined; otherwise a new task starts in this session.
    // An answer to the planner's questions refines the same task, even if an older execution exists.
    const clarifying = active?.currentStep === 'plan_clarification'
    const continueTask = active && (!execution || clarifying) && !['completed', 'cancelled'].includes(active.status) && active.currentStep !== 'planning'
    const followUp = continueTask ? ((clarifying ? await this.executions.clarificationAnswer(active.id, content) : undefined) ?? `Follow-up: ${content}`) : ''
    const { task, message } = await this.prisma.$transaction(async (tx) => {
      const task = continueTask
        ? await tx.task.update({ where: { id: active.id }, data: { userPrompt: `${active.userPrompt}\n\n${followUp}`, status: 'created', currentStep: 'draft' } })
        : await tx.task.create({
            data: {
              projectId: session.projectId,
              sessionId: session.id,
              userPrompt: content,
              mode: (await this.settings.get()).costMode,
              premiumAllowed: (await this.settings.get()).premiumExecutionAllowed,
              currentStep: 'draft',
            },
          })
      const message = await tx.chatMessage.create({ data: { projectId: session.projectId, sessionId: session.id, taskId: task.id, clientId, role: 'user', content, metadata: asJson({ source: 'session_chat', autoRun }) } })
      await tx.chatSession.update({ where: { id: session.id }, data: { activeTaskId: task.id, recovery: asJson({ ...jsonObject(session.recovery), interruptedAsk: undefined }) } })
      return { task, message }
    })
    this.sessionByTask.set(task.id, session.id)
    this.published(message)
    await this.executions.requestPlan(task.id, undefined, autoRun)
    await this.systemMessage(session, task.id, 'system', 'Analysiere das Repository und erstelle einen Plan …', { kind: 'planning' })
    return message
  }

  private async sendQuestion(session: ChatSession, content: string, clientId?: string): Promise<ChatMessage> {
    const message = await this.prisma.chatMessage.create({
      data: { projectId: session.projectId, sessionId: session.id, taskId: session.activeTaskId, clientId, role: 'user', content, metadata: asJson({ kind: 'question' }) },
    })
    this.published(message)
    const job = await this.jobs.enqueue('chat.ask', { sessionId: session.id, messageId: message.id })
    await this.prisma.chatSession.update({ where: { id: session.id }, data: { recovery: asJson({ ...jsonObject(session.recovery), pendingAsk: { jobId: job.id, messageId: message.id }, interruptedAsk: undefined }) } })
    return message
  }

  /** Re-plans a task whose planning was interrupted (explicit user action; no automatic premium call). */
  async retryPlan(sessionId: string, taskId?: string) {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId } })
    if (!session) throw new NotFoundException('Session not found.')
    const target = taskId ?? session.activeTaskId
    if (!target) throw new BadRequestException('This session has no task to plan.')
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: target } })
    if (task.sessionId !== sessionId) throw new BadRequestException('Task does not belong to this session.')
    await this.executions.requestPlan(target)
    await this.systemMessage(session, target, 'system', 'Plan wird erneut erstellt …', { kind: 'planning' })
    return this.summary((await this.refresh(sessionId))!)
  }

  private async answerJob(sessionId: string, messageId: string) {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId }, include: { project: true } })
    const question = await this.prisma.chatMessage.findUnique({ where: { id: messageId } })
    if (!session || !question) return
    try {
      const adapter = await this.orchestrators.active()
      if (!adapter) {
        await this.systemMessage(session, question.taskId, 'system', 'Kein Orchestrator verbunden. Bitte Claude Code oder Codex in den Einstellungen verbinden.', { kind: 'answer_error' })
        return
      }
      const { digest: repoDigest } = await this.repoContext.digest(session.projectId, session.project.repoPath, question.content, 4000)
      const skills = await this.agentResources?.promptContext('chat', session.projectId, question.content).catch(() => undefined)
      const digest = skills?.text ? { ...repoDigest, summary: `${repoDigest.summary}\n\n${skills.text}` } : repoDigest
      const history = (await this.prisma.chatMessage.findMany({ where: { sessionId, createdAt: { lt: question.createdAt }, role: { in: ['user', 'assistant'] } }, orderBy: { createdAt: 'desc' }, take: 8 }))
        .reverse()
        .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content.slice(0, 2000) }))
      const started = Date.now()
      try {
        // A follow-up resumes the orchestrator's own session (context + history are already there).
        const resumeSessionId = session.provider === adapter.id && session.externalSessionId ? session.externalSessionId : undefined
        const { result, meta } = await adapter.chat({ question: question.content, context: digest, history, resumeSessionId }, { runId: `chat-${sessionId}-${messageId}`, cwd: session.project.repoPath, timeoutMs: 5 * 60_000, effort: 'low' })
        await this.prisma.modelCall.create({
          data: {
            kind: 'orchestrator', provider: adapter.id, model: meta.model ?? adapter.id, purpose: 'chat', status: 'ok', sessionId: meta.sessionId, durationMs: meta.durationMs,
            inputTokens: meta.usage.inputTokens, outputTokens: meta.usage.outputTokens, cachedInputTokens: meta.usage.cachedInputTokens, tokensMeasured: meta.usage.measured,
            apiEquivalentUsd: meta.usage.apiEquivalentUsd === undefined ? undefined : new Prisma.Decimal(meta.usage.apiEquivalentUsd), billing: meta.usage.billing,
          },
        })
        await this.prisma.chatSession.update({ where: { id: sessionId }, data: { provider: adapter.id, ...(meta.sessionId ? { externalSessionId: meta.sessionId } : {}) } })
        await this.systemMessage(session, question.taskId, 'assistant', result.answer, { kind: 'answer', orchestrator: adapter.id, questionId: messageId, resumedSession: Boolean(resumeSessionId && meta.sessionId === resumeSessionId) })
      } catch (error) {
        await this.prisma.modelCall.create({ data: { kind: 'orchestrator', provider: adapter.id, purpose: 'chat', status: 'error', errorClass: (error as { kind?: string }).kind, durationMs: Date.now() - started, ...failedCallFields(error, adapter.id) } })
        await this.systemMessage(session, question.taskId, 'system', `Fehler bei der Antwort: ${error instanceof Error ? error.message : String(error)}`, { kind: 'answer_error', questionId: messageId })
      }
    } finally {
      // Shares the session's send-lock with sendQuestion()'s pendingAsk write: without it, a fast
      // answer (e.g. a scripted/local model) can finish and clear pendingAsk here before sendQuestion
      // has even persisted it, leaving a stale pendingAsk that never gets cleaned up.
      await this.sendLocks.run(sessionId, async () => {
        const current = await this.prisma.chatSession.findUnique({ where: { id: sessionId } })
        if (current) {
          const recovery = jsonObject(current.recovery)
          if ((recovery.pendingAsk as { messageId?: string } | undefined)?.messageId === messageId) delete recovery.pendingAsk
          await this.prisma.chatSession.update({ where: { id: sessionId }, data: { recovery: asJson(recovery), lastActivityAt: new Date() } })
        }
      })
      this.scheduleRefresh(sessionId, 0)
    }
  }

  private async systemMessage(session: Pick<ChatSession, 'id' | 'projectId'>, taskId: string | null, role: 'assistant' | 'agent' | 'system', content: string, metadata: Record<string, unknown>) {
    const message = await this.prisma.chatMessage.create({ data: { projectId: session.projectId, sessionId: session.id, taskId, role, content, metadata: asJson(metadata) } })
    this.published(message)
    return message
  }

  private published(message: ChatMessage) {
    this.events.publish('project', 'chat_message', { taskId: message.taskId, sessionId: message.sessionId, messageId: message.id, role: message.role, projectId: message.projectId }, message.projectId)
  }

  // ---------------------------------------------------------------------------
  // Status & recovery
  // ---------------------------------------------------------------------------

  /** Recomputes and stores the status of one session; publishes a change event. */
  async refresh(sessionId: string): Promise<ChatSession | undefined> {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId } })
    if (!session) return undefined
    const tasks = await this.prisma.task.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, status: true, currentStep: true, executions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
    })
    const taskIds = new Set(tasks.map((task) => task.id))
    const [planJobs, askJobs] = await Promise.all([
      this.jobs.activeFor('execution.plan', (payload) => taskIds.has(String(payload.taskId))),
      this.jobs.activeFor('chat.ask', (payload) => payload.sessionId === sessionId),
    ])
    const status = deriveSessionStatus({
      session,
      tasks,
      activePlanTaskIds: new Set(planJobs.map((job) => String((job.payload as Record<string, unknown>).taskId))),
      askRunning: askJobs.length > 0,
      now: Date.now(),
    })
    if (status === session.status) return session
    const updated = await this.prisma.chatSession.update({ where: { id: sessionId }, data: { status } })
    this.publish(updated)
    return updated
  }

  private publish(session: ChatSession) {
    this.events.publish('project', 'session_updated', { sessionId: session.id, projectId: session.projectId, status: session.status, title: session.title, lastActivityAt: session.lastActivityAt, pinned: session.pinned, archived: Boolean(session.archivedAt) }, session.projectId)
  }

  private scheduleRefresh(sessionId: string, delayMs = 250) {
    const existing = this.pendingRefresh.get(sessionId)
    if (existing) clearTimeout(existing)
    this.pendingRefresh.set(
      sessionId,
      setTimeout(() => {
        this.pendingRefresh.delete(sessionId)
        void this.refresh(sessionId).catch((error: unknown) => this.logger.warn(`Session refresh failed: ${error instanceof Error ? error.message : String(error)}`))
      }, delayMs),
    )
  }

  private static readonly STATE_EVENTS = new Set([
    'planning_started', 'planned', 'execution_created', 'execution_finished', 'run_updated', 'applied', 'discarded', 'undone', 'run_paused', 'run_resumed', 'run_cancelled', 'run_error',
  ])

  private onEvent(event: AppEvent) {
    const data = event.data as Record<string, unknown>
    if (event.channel === 'project' && event.type === 'chat_message' && typeof data.sessionId === 'string') return this.scheduleRefresh(data.sessionId)
    if (event.channel === 'jobs' && ['finished', 'failed', 'started'].includes(event.type) && ['execution.plan', 'chat.ask'].includes(String(data.type))) {
      void this.prisma.job.findUnique({ where: { id: String(data.jobId) } }).then((job) => {
        const payload = (job?.payload ?? {}) as Record<string, unknown>
        if (typeof payload.sessionId === 'string') this.scheduleRefresh(payload.sessionId)
        else if (typeof payload.taskId === 'string') void this.sessionForTask(payload.taskId).then((id) => id && this.scheduleRefresh(id))
      })
      return
    }
    if (event.channel !== 'run' || !SessionsService.STATE_EVENTS.has(event.type)) return
    if (event.type === 'run_updated' && !data.status) return
    if (typeof data.sessionId === 'string') return this.scheduleRefresh(data.sessionId)
    if (typeof data.taskId === 'string') void this.sessionForTask(data.taskId).then((id) => id && this.scheduleRefresh(id))
    else if (typeof data.executionId === 'string') void this.sessionForExecution(data.executionId).then((id) => id && this.scheduleRefresh(id))
  }

  private async sessionForTask(taskId: string) {
    if (!this.sessionByTask.has(taskId)) this.sessionByTask.set(taskId, (await this.prisma.task.findUnique({ where: { id: taskId }, select: { sessionId: true } }))?.sessionId ?? null)
    return this.sessionByTask.get(taskId) ?? null
  }

  private async sessionForExecution(executionId: string) {
    if (!this.sessionByExecution.has(executionId)) {
      const run = await this.prisma.executionRun.findUnique({ where: { id: executionId }, select: { task: { select: { sessionId: true } } } })
      this.sessionByExecution.set(executionId, run?.task.sessionId ?? null)
    }
    return this.sessionByExecution.get(executionId) ?? null
  }

  /** A job that was running when the app stopped: record what happened instead of pretending it still runs. */
  private async onJobRecovered(job: Job, outcome: 'requeued' | 'interrupted') {
    if (outcome !== 'interrupted') return
    const payload = (job.payload ?? {}) as Record<string, unknown>
    if (job.type === 'chat.ask' && typeof payload.sessionId === 'string') {
      const session = await this.prisma.chatSession.findUnique({ where: { id: payload.sessionId } })
      if (!session) return
      const recovery = jsonObject(session.recovery)
      delete recovery.pendingAsk
      recovery.interruptedAsk = { messageId: payload.messageId, at: new Date().toISOString() }
      await this.prisma.chatSession.update({ where: { id: session.id }, data: { recovery: asJson(recovery) } })
      await this.systemMessage(session, null, 'system', 'Die Antwort auf deine Frage wurde unterbrochen, weil die App beendet wurde. Sende die Frage erneut, um sie noch einmal zu stellen (es wird nichts automatisch wiederholt).', { kind: 'answer_interrupted', questionId: payload.messageId })
    }
    if (job.type === 'execution.plan' && typeof payload.taskId === 'string') await this.markPlanInterrupted(payload.taskId)
  }

  private async markPlanInterrupted(taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } })
    if (!task || task.currentStep !== 'planning') return
    await this.prisma.task.update({ where: { id: taskId }, data: { currentStep: 'plan_interrupted', status: 'failed' } })
    const sessionId = task.sessionId
    if (sessionId) await this.systemMessage({ id: sessionId, projectId: task.projectId }, taskId, 'system', 'Die Planung wurde unterbrochen, weil die App beendet wurde. „Erneut planen“ startet sie neu (es wird nichts automatisch wiederholt).', { kind: 'plan_interrupted' })
  }

  /**
   * Startup recovery (after ExecutionService.recover and the job queue recovery):
   * tasks still marked "planning" without a plan job, asks without a job, then every status is
   * recomputed from the actual runtime state.
   */
  async recover() {
    const planning = await this.prisma.task.findMany({ where: { currentStep: 'planning' }, select: { id: true } })
    for (const task of planning) {
      const jobs = await this.jobs.activeFor('execution.plan', (payload) => payload.taskId === task.id)
      if (!jobs.length) await this.markPlanInterrupted(task.id)
    }
    const sessions = await this.prisma.chatSession.findMany({ select: { id: true, recovery: true, projectId: true } })
    for (const session of sessions) {
      const recovery = jsonObject(session.recovery)
      const pending = recovery.pendingAsk as { jobId?: string; messageId?: string } | undefined
      if (pending?.jobId) {
        const job = await this.prisma.job.findUnique({ where: { id: pending.jobId } })
        if (!job || !['queued', 'running'].includes(job.status)) {
          delete recovery.pendingAsk
          await this.prisma.chatSession.update({ where: { id: session.id }, data: { recovery: asJson(recovery) } })
        }
      }
      await this.refresh(session.id)
    }
    this.logger.log(`Recovered ${sessions.length} session(s); ${planning.length} task(s) were in planning.`)
  }
}
