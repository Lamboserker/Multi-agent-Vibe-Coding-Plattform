import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common'
import { OrchestratorError, type CallMeta, type DesignBrief, type DesignMode } from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { asJson } from '../common/json.js'
import { AgentResourcesService } from '../agents/agent-resources.service.js'
import { RepoContextService } from '../execution/repo-context.service.js'
import { OrchestratorService, type DesignerAdapter } from '../orchestration/orchestrator.service.js'
import { failedCallRows, modelCallRows } from '../orchestration/model-call.js'
import { duoReconciledMessage, taskOverride, type OrchestratorOverride } from '../orchestration/orchestrator-choice.js'
import { EventBusService } from '../runtime/event-bus.service.js'
import { JobQueueService } from '../runtime/job-queue.service.js'
import { briefOf, specOf } from './design-files.js'

export const DESIGN_MODES: readonly DesignMode[] = ['auto', 'force', 'skip']
/** The design call reads a compact digest; the skills and the mockup make up most of the prompt and output. */
const DESIGN_CONTEXT_TOKENS = 3000
const DESIGN_TIMEOUT_MS = 10 * 60_000

export const DESIGN_UNAVAILABLE_TEXT = 'Kein Premium-Designer verfügbar – Planung ohne Design-Entwurf.'
/** Chat notes when the user decides on a draft (chat answer or Leitstand button). */
export const DESIGN_APPROVED_TEXT = 'Design freigegeben. Analysiere das Repository und erstelle den Plan auf Basis des Entwurfs …'
export const DESIGN_SKIPPED_TEXT = 'Design-Phase übersprungen. Analysiere das Repository und erstelle einen Plan ohne Design-Entwurf …'
export const DESIGN_REVISION_TEXT = 'Überarbeite den Design-Entwurf mit deinem Feedback …'
export const DESIGN_REGENERATE_TEXT = 'Erstelle den Design-Entwurf neu …'
export const DESIGN_INTERRUPTED_TEXT = 'Der Design-Entwurf wurde unterbrochen, weil die App beendet wurde. „Neu entwerfen“ startet ihn erneut (es wird nichts automatisch wiederholt).'

/** Chat text for a new draft (the Leitstand shows the preview and the actions). */
export function draftMessage(draft: { version: number; designType: string; summary: string; questions: string[] }, designer: string) {
  return [
    `**Design-Entwurf ${draft.version} von ${designer}** (${draft.designType})`,
    draft.summary,
    ...(draft.questions.length ? ['', 'Offene Fragen des Designers:', ...draft.questions.map((question, index) => `${index + 1}. ${question}`)] : []),
    '',
    'Prüfe die Vorschau im Leitstand: „Design freigeben“ startet die Planung auf Basis des Entwurfs, „Überarbeiten…“ erzeugt mit deinem Feedback einen neuen Entwurf, „Ohne Design planen“ überspringt die Design-Phase.',
  ].join('\n')
}

/**
 * Design phase before planning: a premium designer (Claude Code, else Codex) drafts tokens, component
 * specs and an HTML mockup read-only; the user approves, revises or skips the draft. Planning itself is
 * started by ExecutionService (it registers itself via setPlanner, so there is no DI cycle).
 */
@Injectable()
export class DesignService implements OnModuleInit {
  private readonly logger = new Logger('Design')
  private planner?: (taskId: string, autoStart: boolean) => Promise<unknown>

  /**
   * The decisions on a draft are only valid in the matching design step (a stale button or a second
   * click must not restart a phase that is already over): 409 with a note otherwise.
   */
  private async requireStep(taskId: string, steps: string[], message: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { currentStep: true } })
    if (!task) throw new NotFoundException('Task not found.')
    if (!steps.includes(task.currentStep)) throw new ConflictException(message)
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrators: OrchestratorService,
    private readonly repoContext: RepoContextService,
    private readonly jobs: JobQueueService,
    private readonly events: EventBusService,
    @Optional() private readonly agentResources?: AgentResourcesService,
  ) {}

  onModuleInit() {
    this.jobs.register('design.create', (payload, ctx) => this.createJob(String(payload.taskId), String(payload.draftId), payload.autoStart === true, ctx.signal), { concurrency: 2, onRecover: 'interrupt' })
    this.jobs.onRecovered(async (job, outcome) => {
      const payload = (job.payload ?? {}) as Record<string, unknown>
      if (job.type !== 'design.create' || outcome !== 'interrupted' || typeof payload.taskId !== 'string') return
      await this.markFailed(payload.taskId, typeof payload.draftId === 'string' ? payload.draftId : undefined, DESIGN_INTERRUPTED_TEXT, { interrupted: true })
    })
  }

  /**
   * Startup recovery for a task still marked "designing" without a design job (e.g. the job row was already
   * closed): design_failed with the interruption note, nothing is retried automatically.
   */
  async markInterrupted(taskId: string) {
    const generating = await this.prisma.designDraft.findFirst({ where: { taskId, status: 'generating' }, orderBy: { version: 'desc' }, select: { id: true } })
    await this.markFailed(taskId, generating?.id, DESIGN_INTERRUPTED_TEXT, { interrupted: true })
  }

  /** Called by ExecutionService: how planning continues after the design phase (without the design gate). */
  setPlanner(planner: (taskId: string, autoStart: boolean) => Promise<unknown>) {
    this.planner = planner
  }

  /** The designer for a request: the task's orchestrator choice (Claude, Codex or both) or the settings. */
  async designer(override?: OrchestratorOverride): Promise<DesignerAdapter | undefined> {
    return this.orchestrators.designer(override).catch(() => undefined)
  }

  /** The approved draft of a task (the base of its plan), if any. */
  async approved(taskId: string): Promise<{ id: string; brief: DesignBrief; mockupHtml: string } | undefined> {
    const row = await this.prisma.designDraft.findFirst({ where: { taskId, status: 'approved' }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }] })
    return row ? { id: row.id, brief: briefOf(row), mockupHtml: row.mockupHtml } : undefined
  }

  async latest(taskId: string) {
    return this.prisma.designDraft.findFirst({ where: { taskId }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }] })
  }

  /** All versions without the mockup (history). */
  async list(taskId: string) {
    return this.prisma.designDraft.findMany({
      where: { taskId },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, taskId: true, version: true, status: true, provider: true, designType: true, summary: true, feedback: true, createdAt: true, updatedAt: true },
    })
  }

  /**
   * Starts (or restarts) a draft: a new version in status "generating" and the design job. An open draft
   * is replaced (rejected with the feedback); a running generation is reused.
   */
  async start(taskId: string, options: { autoStart?: boolean; feedback?: string } = {}) {
    await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { id: true } })
    const [active] = await this.jobs.activeFor('design.create', (payload) => payload.taskId === taskId)
    if (active) return { jobId: active.id, draftId: String((active.payload as Record<string, unknown>).draftId ?? '') }
    const feedback = options.feedback?.trim() || undefined
    const last = await this.latest(taskId)
    if (last && (last.status === 'draft' || last.status === 'generating')) {
      await this.prisma.designDraft.update({ where: { id: last.id }, data: { status: last.status === 'draft' ? 'rejected' : 'failed', feedback: feedback ?? last.feedback } })
    }
    const draft = await this.prisma.designDraft.create({ data: { taskId, version: (last?.version ?? 0) + 1, status: 'generating', feedback: feedback ?? null } })
    await this.prisma.task.update({ where: { id: taskId }, data: { currentStep: 'designing', status: 'running' } })
    const requestedAt = new Date().toISOString()
    const job = await this.jobs.enqueue('design.create', { taskId, draftId: draft.id, autoStart: options.autoStart === true, requestedAt }, { dedupeKey: `design:${taskId}` })
    this.events.publish('run', 'design_requested', { taskId, jobId: job.id, draftId: draft.id, version: draft.version, requestedAt })
    return { jobId: job.id, draftId: draft.id }
  }

  /**
   * Approves the open draft; the caller starts planning. An already approved draft is accepted again while the
   * task still waits in the design step (the planning request after the approval failed: "Planung starten").
   */
  async approve(taskId: string) {
    await this.requireStep(taskId, ['awaiting_design_approval'], 'Der Design-Entwurf kann gerade nicht freigegeben werden – er wartet nicht auf eine Freigabe.')
    const last = await this.latest(taskId)
    if (!last) throw new NotFoundException('Für diese Aufgabe gibt es keinen Design-Entwurf.')
    if (last.status === 'approved') return last
    if (last.status !== 'draft') throw new BadRequestException(`Der Design-Entwurf kann nicht freigegeben werden (Status: ${last.status}).`)
    const approved = await this.prisma.designDraft.update({ where: { id: last.id }, data: { status: 'approved' } })
    this.events.publish('run', 'design_approved', { taskId, draftId: approved.id, version: approved.version })
    return approved
  }

  /** Rejects the open draft with the user's feedback and generates the next version. */
  async reject(taskId: string, feedback: string, autoStart = false) {
    const text = feedback.trim()
    if (!text) throw new BadRequestException('Bitte beschreibe, was am Entwurf geändert werden soll.')
    await this.requireStep(taskId, ['awaiting_design_approval'], 'Der Design-Entwurf kann gerade nicht überarbeitet werden – er wartet nicht auf eine Entscheidung.')
    const last = await this.latest(taskId)
    if (!last) throw new NotFoundException('Für diese Aufgabe gibt es keinen Design-Entwurf.')
    if (last.status === 'generating') throw new ConflictException('Der Design-Entwurf wird gerade erstellt – Feedback ist möglich, sobald er fertig ist.')
    if (last.status === 'draft') await this.prisma.designDraft.update({ where: { id: last.id }, data: { status: 'rejected', feedback: text } })
    return this.start(taskId, { feedback: text, autoStart })
  }

  /** A new draft without feedback (after a failed or interrupted draft, or instead of the open one). */
  async regenerate(taskId: string) {
    await this.requireStep(taskId, ['awaiting_design_approval', 'design_failed'], 'Ein neuer Design-Entwurf ist gerade nicht möglich – die Design-Phase ist nicht offen.')
    return this.start(taskId)
  }

  /** Plans without a design from now on; the caller starts planning. */
  async skip(taskId: string) {
    await this.requireStep(taskId, ['designing', 'awaiting_design_approval', 'design_failed'], 'Die Design-Phase kann gerade nicht übersprungen werden – sie ist nicht offen.')
    const last = await this.latest(taskId)
    if (last && (last.status === 'draft' || last.status === 'generating')) {
      // the draft is closed first, so the cancelled job does not report a failure
      await this.prisma.designDraft.update({ where: { id: last.id }, data: { status: last.status === 'draft' ? 'rejected' : 'failed' } })
      const [active] = await this.jobs.activeFor('design.create', (payload) => payload.taskId === taskId)
      if (active) await this.jobs.cancel(active.id)
    }
    return this.prisma.task.update({ where: { id: taskId }, data: { designMode: 'skip' } })
  }

  private async createJob(taskId: string, draftId: string, autoStart: boolean, signal?: AbortSignal) {
    try {
      await this.create(taskId, draftId, autoStart, signal)
    } catch (error) {
      // a draft replaced or skipped meanwhile (cancelled job) is not reported as a failure
      const draft = await this.prisma.designDraft.findUnique({ where: { id: draftId }, select: { status: true } })
      if (draft?.status !== 'generating') return
      const message = error instanceof Error ? error.message : String(error)
      await this.markFailed(taskId, draftId, `Design-Entwurf fehlgeschlagen: ${message.slice(0, 500)}`)
      throw error
    }
  }

  /** One read-only premium call: digest + design skills (+ previous brief and feedback) → draft. */
  async create(taskId: string, draftId: string, autoStart = false, signal?: AbortSignal) {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: { project: true } })
    const draft = await this.prisma.designDraft.findUniqueOrThrow({ where: { id: draftId } })
    const resolved = await this.orchestrators.designerWithNotice(await taskOverride(this.prisma, taskId)).catch(() => ({ adapter: undefined, notice: undefined }))
    const designer = resolved.adapter
    if (resolved.notice) await this.noteOnce(taskId, 'orchestrator_notice', resolved.notice)
    if (!designer) {
      // the designer disappeared since the request (logout): plan without a design (requestPlan posts the note)
      if (!this.planner) throw new Error('No premium designer is available.')
      await this.prisma.designDraft.update({ where: { id: draftId }, data: { status: 'failed' } })
      await this.planner(taskId, autoStart)
      return undefined
    }
    this.events.publish('run', 'design_progress', { taskId, kind: 'phase', phase: 'context' })
    const feedback = draft.feedback ?? undefined
    // a revision builds on the previous content (only with feedback; a plain regeneration starts fresh)
    const previousRow = feedback
      ? await this.prisma.designDraft.findFirst({ where: { taskId, version: { lt: draft.version }, status: { in: ['rejected', 'approved', 'draft'] } }, orderBy: { version: 'desc' } })
      : null
    const [{ digest }, skills] = await Promise.all([
      this.repoContext.digest(task.projectId, task.project.repoPath, task.userPrompt, DESIGN_CONTEXT_TOKENS),
      this.agentResources?.designerContext(task.projectId, task.userPrompt).catch(() => undefined) ?? Promise.resolve(undefined),
    ])
    if (skills?.inlined.length) this.events.publish('run', 'design_context', { taskId, skills: skills.inlined })
    this.events.publish('run', 'design_progress', { taskId, kind: 'phase', phase: 'designing', designer: designer.id })
    const started = Date.now()
    try {
      const { result, meta } = await designer.createDesign(
        {
          goal: task.userPrompt,
          context: digest,
          skills: skills?.text || undefined,
          skillCatalog: skills?.catalog.length ? skills.catalog : undefined,
          feedback,
          previous: previousRow ? briefOf(previousRow) : undefined,
          provider: designer.id,
        },
        {
          runId: `design-${taskId}`,
          cwd: task.project.repoPath,
          signal,
          // a mockup is 8-12k output tokens
          timeoutMs: DESIGN_TIMEOUT_MS,
          effort: 'medium',
          onEvent: (event) => {
            if (event.type === 'tool') this.events.publish('run', 'design_progress', { taskId, kind: 'tool', name: event.name, detail: event.detail.slice(0, 200) })
            else if (event.type === 'command') this.events.publish('run', 'design_progress', { taskId, kind: 'tool', name: '$', detail: event.command.slice(0, 200) })
            else if (event.type === 'session' && event.model) this.events.publish('run', 'design_progress', { taskId, kind: 'model', model: event.model })
          },
        },
      )
      await this.recordCall(designer, 'ok', Date.now() - started, meta)
      if (meta.duo) {
        const duo = duoReconciledMessage(meta.duo)
        await this.chat(taskId, 'assistant', duo.content, duo.metadata)
      }
      // only a draft that is still awaited is filled (skipped or replaced meanwhile: the result is dropped)
      const filled = await this.prisma.designDraft.updateMany({
        where: { id: draftId, status: 'generating' },
        data: { status: 'draft', provider: designer.id, designType: result.designType, summary: result.summary, spec: asJson(specOf(result)), mockupHtml: result.mockupHtml },
      })
      if (filled.count !== 1) return undefined
      const saved = await this.prisma.designDraft.findUniqueOrThrow({ where: { id: draftId } })
      await this.prisma.task.update({ where: { id: taskId }, data: { currentStep: 'awaiting_design_approval', status: 'planned' } })
      await this.chat(taskId, 'assistant', draftMessage({ version: saved.version, designType: result.designType, summary: result.summary, questions: result.questions }, designer.displayName), {
        kind: 'design_draft',
        draftId: saved.id,
        version: saved.version,
        designType: result.designType,
        summary: result.summary,
        questions: result.questions,
      })
      this.events.publish('run', 'design_ready', { taskId, draftId: saved.id, version: saved.version })
      return saved
    } catch (error) {
      const kind = error instanceof OrchestratorError ? error.kind : 'process_failed'
      // a rejected draft (invalid output, max turns) still used the quota: book its tokens
      for (const data of failedCallRows(designer.id, error, { kind: 'orchestrator', purpose: 'design', errorClass: kind, durationMs: Date.now() - started })) {
        await this.prisma.modelCall.create({ data })
      }
      if (kind === 'not_authenticated' || kind === 'session_expired') this.orchestrators.invalidate()
      throw error
    }
  }

  private async recordCall(designer: DesignerAdapter, status: 'ok', durationMs: number, meta: CallMeta) {
    // duo mode: one row per call (both drafts and the reconciliation)
    for (const data of modelCallRows(designer.id, meta, { kind: 'orchestrator', purpose: 'design', status, durationMs })) {
      await this.prisma.modelCall.create({ data })
    }
  }

  /** A system note in the task's conversation (the Leitstand buttons get the same notes as the chat answers). */
  async note(taskId: string, content: string, kind: string) {
    await this.chat(taskId, 'system', content, { kind })
  }

  /** A system note that is posted only once per task (a repeated draft does not repeat it). */
  private async noteOnce(taskId: string, kind: string, content: string) {
    const recent = await this.prisma.chatMessage.findMany({ where: { taskId, role: 'system' }, orderBy: { createdAt: 'desc' }, take: 50, select: { metadata: true } })
    if (recent.some((message) => (message.metadata as { kind?: string } | null)?.kind === kind)) return
    await this.chat(taskId, 'system', content, { kind })
  }

  private async markFailed(taskId: string, draftId: string | undefined, message: string, extra: Record<string, unknown> = {}) {
    if (draftId) await this.prisma.designDraft.updateMany({ where: { id: draftId, status: 'generating' }, data: { status: 'failed' } })
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { currentStep: true } })
    if (!task || task.currentStep !== 'designing') return
    await this.prisma.task.update({ where: { id: taskId }, data: { currentStep: 'design_failed', status: 'failed' } })
    await this.chat(taskId, 'system', message, { kind: 'design_error', ...extra })
  }

  private async chat(taskId: string, role: 'assistant' | 'system', content: string, metadata: Record<string, unknown>) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } })
    if (!task) return
    const message = await this.prisma.chatMessage.create({ data: { taskId, projectId: task.projectId, sessionId: task.sessionId, role, content, metadata: asJson(metadata) } })
    this.events.publish('project', 'chat_message', { taskId, sessionId: task.sessionId, messageId: message.id, role, projectId: task.projectId }, task.projectId)
  }
}
