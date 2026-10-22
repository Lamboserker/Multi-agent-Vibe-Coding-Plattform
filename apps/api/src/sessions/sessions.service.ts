import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { AgentResourcesService } from '../agents/agent-resources.service.js'
import type { ChatMessage, ChatSession, ExecutionStatus, Job } from '@prisma/client'
import type { Subscription } from 'rxjs'
import { PrismaService } from '../common/prisma.service.js'
import { asJson, jsonObject } from '../common/json.js'
import { ExecutionService } from '../execution/execution.service.js'
import { RepoContextService } from '../execution/repo-context.service.js'
import { OrchestratorService } from '../orchestration/orchestrator.service.js'
import { failedCallRows, modelCallRows } from '../orchestration/model-call.js'
import { isOrchestratorOverride, type OrchestratorOverride } from '../orchestration/orchestrator-choice.js'
import { isDuo, type CallMeta, type ChatResult, type OrchestratorAdapter } from '@multi-ai-coder/engine'
import { EventBusService, type AppEvent } from '../runtime/event-bus.service.js'
import { KeyedMutex } from '../common/locks.js'
import { JobQueueService } from '../runtime/job-queue.service.js'
import { SettingsService } from '../runtime/settings.service.js'
import { DESIGN_APPROVED_TEXT, DESIGN_REVISION_TEXT, DesignService } from '../design/design.service.js'
import { DEFAULT_TITLE, deriveSessionStatus, designAnswer, RUN_CONFIRMATION, RUNNING_EXECUTION, titleFrom, type SessionStatus } from './session-model.js'

export { deriveSessionStatus, SESSION_STATUSES, titleFrom, type SessionStatus } from './session-model.js'

/**
 * Metadata of an orchestrator answer. Duo: the lead's answer is the content, the partner's answer and its CLI
 * session (for the next resume) are in `duo`; when only one side answered, `orchestrator` names it and
 * `duo.fallback` says why.
 */
export function answerMetadata(adapter: OrchestratorAdapter, result: ChatResult, meta: CallMeta, extra: { questionId?: string; resumedSession?: boolean; partnerResumeSessionId?: string } = {}): Record<string, unknown> {
  const { partnerResumeSessionId, ...rest } = extra
  if (!isDuo(adapter)) return { kind: 'answer', orchestrator: adapter.id, ...rest }
  const { lead, partner } = adapter.duo
  const winner = meta.duo?.winner
  const partnerPart = meta.parts?.find((part) => part.role === 'partner' && part.status === 'ok')
  return {
    kind: 'answer',
    orchestrator: winner && winner !== 'merged' ? winner : lead,
    ...rest,
    duo: {
      lead,
      partner,
      ...(result.duo ? { partnerAnswer: result.duo.partnerAnswer } : {}),
      // the partner's thread continues only when it answered (a failed partner keeps the previous one)
      ...(partnerPart?.sessionId ? { partnerSessionId: partnerPart.sessionId } : partnerResumeSessionId ? { partnerSessionId: partnerResumeSessionId } : {}),
      ...(partnerResumeSessionId && partnerPart?.sessionId === partnerResumeSessionId ? { partnerResumed: true } : {}),
      ...(meta.duo?.fallback ? { fallback: meta.duo.fallback } : {}),
    },
  }
}

/** Chat notes for the start of planning or of the design phase that precedes it. */
export const PLANNING_TEXT = 'Analysiere das Repository und erstelle einen Plan …'
export const DESIGN_START_TEXT = 'Erstelle zuerst einen Design-Entwurf (Tokens, Komponenten, Vorschau) – der Plan folgt nach deiner Freigabe …'
/** Answer to a short reply that is neither an approval nor a change request (no paid redesign on a guess). */
export const DESIGN_UNCLEAR_TEXT = 'Soll ich das Design freigeben? Antworte mit „passt“ – oder beschreibe, was sich ändern soll.'
export const DESIGN_PENDING_TEXT = 'Der Design-Entwurf wird gerade erstellt … Sobald er fertig ist, kannst du ihn freigeben („passt“) oder mit deinem Feedback überarbeiten lassen.'

export interface SendInput {
  content: string
  mode: 'task' | 'ask'
  autoRun?: boolean
  /** Client-generated idempotency key. */
  clientId?: string
  /** Design phase before planning (auto = only for UI requests); kept on the task. */
  designMode?: 'auto' | 'force' | 'skip'
  /** Composer choice "Claude | Codex | Beide"; stored in the user message metadata (the task's choice, see taskOverride). */
  orchestrator?: OrchestratorOverride
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
    @Optional() private readonly design?: DesignService,
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
    const [executions, planJobs, designJobs, asks] = await Promise.all([
      this.prisma.executionRun.findMany({
        where: { status: { in: [...RUNNING_EXECUTION, 'paused'] as ExecutionStatus[] } },
        select: { id: true, status: true, projectId: true, taskId: true, startedAt: true, task: { select: { userPrompt: true, sessionId: true } } },
      }),
      this.jobs.activeFor('execution.plan', () => true),
      // the design phase is part of planning (background work before the plan)
      this.jobs.activeFor('design.create', () => true),
      this.jobs.activeFor('chat.ask', () => true),
    ])
    const plans = [...planJobs, ...designJobs]
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
      const choice = input.orchestrator ? { orchestrator: input.orchestrator } : {}
      const message = input.mode === 'ask' ? await this.sendQuestion(session, content, input.clientId, choice) : await this.sendTask(session, content, Boolean(input.autoRun), input.clientId, input.designMode, choice)
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

  private async sendTask(session: ChatSession, content: string, autoRun: boolean, clientId?: string, designMode?: SendInput['designMode'], choice: { orchestrator?: OrchestratorOverride } = {}): Promise<ChatMessage> {
    const active = session.activeTaskId ? await this.prisma.task.findUnique({ where: { id: session.activeTaskId }, include: { executions: { orderBy: { createdAt: 'desc' }, take: 1 }, subtasks: { select: { id: true }, take: 1 } } }) : null
    const execution = active?.executions[0]

    // "ja/start" while a plan waits for approval starts the run.
    if (active && active.subtasks.length && !execution && RUN_CONFIRMATION.test(content) && ['awaiting_plan_approval', 'planned'].includes(active.currentStep)) {
      const message = await this.prisma.chatMessage.create({ data: { projectId: session.projectId, sessionId: session.id, taskId: active.id, clientId, role: 'user', content, metadata: asJson({ source: 'session_chat', kind: 'run_confirmation', ...choice }) } })
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

    // The design phase is answered in the chat: approval, feedback for the next draft, or a note while it is drafted.
    if (active && this.design && ['designing', 'awaiting_design_approval'].includes(active.currentStep)) return this.answerDesign(session, active, content, autoRun, clientId, choice)

    // A task that has not been executed yet is refined; otherwise a new task starts in this session.
    // An answer to the planner's questions refines the same task, even if an older execution exists.
    // After a failed design draft the message is a follow-up (like after a failed plan) and the feedback of the new draft.
    const clarifying = active?.currentStep === 'plan_clarification'
    const retryDesign = active?.currentStep === 'design_failed'
    const continueTask = active && (!execution || clarifying) && !['completed', 'cancelled'].includes(active.status) && active.currentStep !== 'planning'
    const followUp = continueTask ? ((clarifying ? await this.executions.clarificationAnswer(active.id, content) : undefined) ?? `Follow-up: ${content}`) : ''
    const { task, message } = await this.prisma.$transaction(async (tx) => {
      const task = continueTask
        ? await tx.task.update({ where: { id: active.id }, data: { userPrompt: `${active.userPrompt}\n\n${followUp}`, status: 'created', currentStep: 'draft', ...(designMode ? { designMode } : {}) } })
        : await tx.task.create({
            data: {
              projectId: session.projectId,
              sessionId: session.id,
              userPrompt: content,
              mode: (await this.settings.get()).costMode,
              premiumAllowed: (await this.settings.get()).premiumExecutionAllowed,
              currentStep: 'draft',
              ...(designMode ? { designMode } : {}),
            },
          })
      const message = await tx.chatMessage.create({ data: { projectId: session.projectId, sessionId: session.id, taskId: task.id, clientId, role: 'user', content, metadata: asJson({ source: 'session_chat', autoRun, ...choice }) } })
      await tx.chatSession.update({ where: { id: session.id }, data: { activeTaskId: task.id, recovery: asJson({ ...jsonObject(session.recovery), interruptedAsk: undefined }) } })
      return { task, message }
    })
    this.sessionByTask.set(task.id, session.id)
    this.published(message)
    const requested = await this.executions.requestPlan(task.id, continueTask && retryDesign ? content : undefined, autoRun)
    await this.planningMessage(session, task.id, requested, PLANNING_TEXT)
    return message
  }

  /** "Planning started" or, when the design gate took over, "design draft started". */
  private async planningMessage(session: Pick<ChatSession, 'id' | 'projectId'>, taskId: string, requested: { design?: true } | undefined, planningText: string) {
    if (requested?.design) await this.systemMessage(session, taskId, 'system', DESIGN_START_TEXT, { kind: 'design_requested' })
    else await this.systemMessage(session, taskId, 'system', planningText, { kind: 'planning' })
  }

  /**
   * A chat message while the task is in the design phase. "passt"/"ok" approves the draft and starts planning,
   * a change request is feedback for the next version; a short reply without either is answered with a
   * question (a guessed redesign would cost a premium call). While a draft is being generated nothing is started:
   * the message only gets a note (queueing it as feedback would trigger a second premium call on its own).
   */
  private async answerDesign(session: ChatSession, task: { id: string; currentStep: string }, content: string, autoRun: boolean, clientId?: string, choice: { orchestrator?: OrchestratorOverride } = {}): Promise<ChatMessage> {
    const design = this.design!
    const generating = task.currentStep === 'designing'
    const answer = generating ? undefined : designAnswer(content)
    const approval = answer === 'approval'
    const kind = !answer ? 'design_pending' : answer === 'approval' ? 'design_approval' : answer === 'unclear' ? 'design_unclear' : 'design_feedback'
    const message = await this.prisma.chatMessage.create({ data: { projectId: session.projectId, sessionId: session.id, taskId: task.id, clientId, role: 'user', content, metadata: asJson({ source: 'session_chat', kind, autoRun, ...choice }) } })
    this.published(message)
    if (generating) {
      await this.systemMessage(session, task.id, 'system', DESIGN_PENDING_TEXT, { kind: 'design_pending' })
      return message
    }
    if (answer === 'unclear') {
      await this.systemMessage(session, task.id, 'assistant', DESIGN_UNCLEAR_TEXT, { kind: 'design_unclear' })
      return message
    }
    try {
      if (approval) {
        await design.approve(task.id)
        const requested = await this.executions.requestPlan(task.id, undefined, autoRun)
        await this.planningMessage(session, task.id, requested, DESIGN_APPROVED_TEXT)
      } else {
        await design.reject(task.id, content, autoRun)
        await this.systemMessage(session, task.id, 'system', DESIGN_REVISION_TEXT, { kind: 'design_requested' })
      }
    } catch (error) {
      // the message is already durable; the failure is reported in the conversation instead of failing the send
      await this.systemMessage(session, task.id, 'system', `Der Design-Entwurf konnte nicht ${approval ? 'freigegeben' : 'überarbeitet'} werden: ${error instanceof Error ? error.message : String(error)}`, { kind: 'design_error' })
    }
    return message
  }

  /**
   * A plain question is answered by the composer's choice, but does not change the task's orchestrator: the
   * choice is stored as `askOrchestrator`, not `orchestrator` (see taskOverride).
   */
  private async sendQuestion(session: ChatSession, content: string, clientId?: string, choice: { orchestrator?: OrchestratorOverride } = {}): Promise<ChatMessage> {
    const message = await this.prisma.chatMessage.create({
      data: { projectId: session.projectId, sessionId: session.id, taskId: session.activeTaskId, clientId, role: 'user', content, metadata: asJson({ kind: 'question', ...(choice.orchestrator ? { askOrchestrator: choice.orchestrator } : {}) }) },
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
    const requested = await this.executions.requestPlan(target)
    await this.planningMessage(session, target, requested, 'Plan wird erneut erstellt …')
    return this.summary((await this.refresh(sessionId))!)
  }

  private async answerJob(sessionId: string, messageId: string) {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId }, include: { project: true } })
    const question = await this.prisma.chatMessage.findUnique({ where: { id: messageId } })
    if (!session || !question) return
    try {
      // askOrchestrator: the choice for this question only (older questions stored it as orchestrator)
      const metadata = question.metadata as { askOrchestrator?: unknown; orchestrator?: unknown } | null
      const override = metadata?.askOrchestrator ?? metadata?.orchestrator
      const resolved = await this.orchestrators.activeWithNotice(isOrchestratorOverride(override) ? override : undefined)
      const adapter = resolved.adapter
      // the hint once per conversation streak: not again while it is still among the latest messages
      const recent = resolved.notice ? await this.prisma.chatMessage.findMany({ where: { sessionId, role: 'system' }, orderBy: { createdAt: 'desc' }, take: 5, select: { content: true } }) : []
      if (resolved.notice && !recent.some((message) => message.content === resolved.notice)) await this.systemMessage(session, question.taskId, 'system', resolved.notice, { kind: 'orchestrator_notice', questionId: messageId })
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
        // Duo: the id is the lead's, so the lead resumes as before; the partner resumes its own session.
        const resumeSessionId = session.provider === adapter.id && session.externalSessionId ? session.externalSessionId : undefined
        const partnerResumeSessionId = isDuo(adapter) ? await this.partnerSession(sessionId, adapter.duo.partner) : undefined
        const { result, meta } = await adapter.chat({ question: question.content, context: digest, history, resumeSessionId, ...(partnerResumeSessionId ? { partnerResumeSessionId } : {}) }, { runId: `chat-${sessionId}-${messageId}`, cwd: session.project.repoPath, timeoutMs: 5 * 60_000, effort: 'low' })
        for (const data of modelCallRows(adapter.id, meta, { kind: 'orchestrator', purpose: 'chat', status: 'ok', durationMs: meta.durationMs })) {
          await this.prisma.modelCall.create({ data })
        }
        await this.prisma.chatSession.update({ where: { id: sessionId }, data: { provider: adapter.id, ...(meta.sessionId ? { externalSessionId: meta.sessionId } : {}) } })
        await this.systemMessage(session, question.taskId, 'assistant', result.answer, answerMetadata(adapter, result, meta, { questionId: messageId, resumedSession: Boolean(resumeSessionId && meta.sessionId === resumeSessionId), partnerResumeSessionId }))
      } catch (error) {
        for (const data of failedCallRows(adapter.id, error, { kind: 'orchestrator', purpose: 'chat', durationMs: Date.now() - started })) {
          await this.prisma.modelCall.create({ data })
        }
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

  /**
   * The partner's CLI session of a duo conversation: kept in the metadata of the last duo answer (ChatSession
   * only has room for the lead's session). Undefined after a partner switch or before the first duo answer.
   */
  private async partnerSession(sessionId: string, partner: string): Promise<string | undefined> {
    const answers = await this.prisma.chatMessage.findMany({ where: { sessionId, role: 'assistant' }, orderBy: { createdAt: 'desc' }, take: 30, select: { metadata: true } })
    for (const answer of answers) {
      const metadata = answer.metadata as { kind?: string; duo?: { partner?: unknown; partnerSessionId?: unknown } } | null
      if (metadata?.kind !== 'answer') continue
      // the latest answer decides: a single-mode answer in between ends the partner's thread
      if (metadata.duo?.partner !== partner) return undefined
      return typeof metadata.duo.partnerSessionId === 'string' ? metadata.duo.partnerSessionId : undefined
    }
    return undefined
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
    const [planJobs, designJobs, askJobs] = await Promise.all([
      this.jobs.activeFor('execution.plan', (payload) => taskIds.has(String(payload.taskId))),
      this.jobs.activeFor('design.create', (payload) => taskIds.has(String(payload.taskId))),
      this.jobs.activeFor('chat.ask', (payload) => payload.sessionId === sessionId),
    ])
    const status = deriveSessionStatus({
      session,
      tasks,
      activePlanTaskIds: new Set([...planJobs, ...designJobs].map((job) => String((job.payload as Record<string, unknown>).taskId))),
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
    'planning_started', 'planned', 'design_requested', 'design_ready', 'design_approved', 'execution_created', 'execution_finished', 'run_updated', 'applied', 'discarded', 'undone', 'run_paused', 'run_resumed', 'run_cancelled', 'run_error',
  ])

  private onEvent(event: AppEvent) {
    const data = event.data as Record<string, unknown>
    if (event.channel === 'project' && event.type === 'chat_message' && typeof data.sessionId === 'string') return this.scheduleRefresh(data.sessionId)
    if (event.channel === 'jobs' && ['finished', 'failed', 'started'].includes(event.type) && ['execution.plan', 'design.create', 'chat.ask'].includes(String(data.type))) {
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
    // an interrupted design draft ends in design_failed (DesignService posts the note, like the plan variant below)
    if (task?.currentStep === 'designing') return this.design?.markInterrupted(taskId)
    if (!task || task.currentStep !== 'planning') return
    await this.prisma.task.update({ where: { id: taskId }, data: { currentStep: 'plan_interrupted', status: 'failed' } })
    const sessionId = task.sessionId
    if (sessionId) await this.systemMessage({ id: sessionId, projectId: task.projectId }, taskId, 'system', 'Die Planung wurde unterbrochen, weil die App beendet wurde. „Erneut planen“ startet sie neu (es wird nichts automatisch wiederholt).', { kind: 'plan_interrupted' })
  }

  /**
   * Startup recovery (after ExecutionService.recover and the job queue recovery):
   * tasks still marked "planning" or "designing" without their job, asks without a job, then every status is
   * recomputed from the actual runtime state.
   */
  async recover() {
    const planning = await this.prisma.task.findMany({ where: { currentStep: { in: ['planning', 'designing'] } }, select: { id: true, currentStep: true } })
    for (const task of planning) {
      const jobs = await this.jobs.activeFor(task.currentStep === 'designing' ? 'design.create' : 'execution.plan', (payload) => payload.taskId === task.id)
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
    this.logger.log(`Recovered ${sessions.length} session(s); ${planning.length} task(s) were in planning or design.`)
  }
}
