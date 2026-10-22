import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common'
import { Prisma, type AgentProfile, type ExecutionRun, type Subtask } from '@prisma/client'
import {
  againstBaseline,
  aggregateSuitability,
  applyChangeSet,
  catchUpIntegration,
  failureDigest,
  diffBetween,
  git,
  isSensitivePath,
  runValidationChecks,
  type ApplyOutcome,
  type ConflictHunk,
  type HunkResolver,
  deterministicPlan,
  ExecutionRunner,
  headCommit,
  isGitRepository,
  OrchestratorError,
  revertChangeSet,
  routeTask,
  summarizeUsage,
  WorktreeManager,
  isSecurityCriticalPath,
  type AgentOffer,
  type ApplyMode,
  type AttemptRecord,
  type EngineTask,
  type ExecutionPlan,
  type OrchestratorAdapter,
  type SkillOffer,
  type SuitabilityStats,
  type UsageCall,
  type ValidationReport,
  classifyFastPath,
  planningContextOptions,
  shouldDesign,
  type DesignMode,
  type FastPathTool,
  type CallMeta,
  isDuo,
} from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { acceptMerge, cleanMergeAnswer, mergePrompt } from './conflict-merge.js'
import { asJson, stringList } from '../common/json.js'
import { KeyedMutex } from '../common/locks.js'
import { LocalModelsService } from '../local-models/local-models.service.js'
import { OrchestratorService } from '../orchestration/orchestrator.service.js'
import { failedCallRows, modelCallRows } from '../orchestration/model-call.js'
import { duoReconciledMessage, orchestratorLabel, orchestratorLabelName, overrideFromLabel, taskOverride } from '../orchestration/orchestrator-choice.js'
import { EventBusService } from '../runtime/event-bus.service.js'
import { JobQueueService } from '../runtime/job-queue.service.js'
import { runtimeConfig } from '../runtime/runtime-config.js'
import { SettingsService } from '../runtime/settings.service.js'
import { PrismaEngineStore } from './prisma-engine-store.js'
import { RepoContextService } from './repo-context.service.js'
import { PluginsService } from '../plugins/plugins.service.js'
import { AgentResourcesService } from '../agents/agent-resources.service.js'
import { AgentProfilesService, assignAgents } from '../agents/agent-profiles.service.js'
import { ensureRepository } from '../workspace-fs/workspace-fs.service.js'
import { DESIGN_MODES, DESIGN_UNAVAILABLE_TEXT, DesignService } from '../design/design.service.js'
import { DESIGN_TASK_ID, designFilesTool, designPlanTask, requestDesignSkill, withDesignGuidance, withDesignTask } from '../design/design-files.js'

const ACTIVE_STATUSES = ['pending', 'planning', 'running', 'paused', 'integrating'] as const
/** Task steps of the design phase before planning. */
const DESIGN_STEPS = ['designing', 'awaiting_design_approval', 'design_failed']

/** Chat text for a planner that returned open questions instead of tasks. */
function questionsMessage(questions: string[]) {
  return `Der Orchestrator hat Rückfragen, bevor er planen kann:\n\n${questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}\n\nBeantworte sie über „Antworten & neu planen“ – deine Antworten gehen als Hinweis in die nächste Planung.`
}

/**
 * A plan that may start without a plan confirmation: at most two subtasks, low complexity and risk,
 * nothing security-relevant, no open questions/warnings, executed only by local agents (no premium
 * cost) or a deterministic fast-path tool, and a real plan (not the fallback after a planner error).
 */
export function isSmallSafePlan(
  plan: ExecutionPlan,
  subtasks: Array<{ riskScore: number | null }>,
  assignments: Array<{ executor: string; requiresApproval?: boolean }>,
  source: string,
) {
  if (source === 'deterministic-fallback') return false
  if (plan.tasks.length === 0 || plan.tasks.length > 2) return false
  if (plan.analysis.complexity > 2 || plan.analysis.risk > 2 || plan.analysis.securitySensitive) return false
  if (plan.analysis.openQuestions.length || plan.warnings.length) return false
  if (plan.tasks.some((task) => task.complexity > 2 || task.risk > 2)) return false
  if (subtasks.some((subtask) => (subtask.riskScore ?? 0) > 2)) return false
  return assignments.length === plan.tasks.length && assignments.every((entry) => (entry.executor === 'local' || source === 'fast-path') && !entry.requiresApproval)
}

/** Premium calls and tokens per provider (the duo books every call with its own provider). */
export function premiumByProvider(calls: Array<Pick<UsageCall, 'kind' | 'provider' | 'status' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens'>>) {
  const out: Record<string, { calls: number; failedCalls: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }> = {}
  for (const call of calls) {
    if (call.kind !== 'orchestrator') continue
    const entry = (out[call.provider] ??= { calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 })
    entry.calls += 1
    if (call.status !== 'ok') entry.failedCalls += 1
    entry.inputTokens += call.inputTokens
    entry.outputTokens += call.outputTokens
    entry.cachedInputTokens += call.cachedInputTokens
  }
  return out
}

@Injectable()
export class ExecutionService implements OnModuleInit {
  private readonly logger = new Logger('Execution')
  private readonly runners = new Map<string, ExecutionRunner>()
  private shuttingDown = false
  /** Serializes start per task and state transitions per run: a double click or a request repeated
   *  after a window reload must never create a second run or apply a change set twice. */
  private readonly taskLocks = new KeyedMutex()
  private readonly runLocks = new KeyedMutex()

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly orchestrators: OrchestratorService,
    private readonly localModels: LocalModelsService,
    private readonly repoContext: RepoContextService,
    private readonly jobs: JobQueueService,
    private readonly events: EventBusService,
    @Optional() private readonly plugins?: PluginsService,
    @Optional() private readonly agentResources?: AgentResourcesService,
    @Optional() private readonly agentProfiles?: AgentProfilesService,
    @Optional() private readonly design?: DesignService,
  ) {}

  onModuleInit() {
    this.jobs.register('execution.run', (payload, ctx) => this.runJob(String(payload.executionId), ctx.signal), { concurrency: 2, onRecover: 'interrupt' })
    this.jobs.register('execution.plan', (payload) => this.planJob(String(payload.taskId), payload.feedback ? String(payload.feedback) : undefined, payload.autoStart === true, typeof payload.requestedAt === 'string' ? payload.requestedAt : undefined), { concurrency: 2, onRecover: 'interrupt' })
    // the design phase continues with planning (approve/skip go through the controller); the gate is skipped,
    // otherwise a designer that is available again would get the task back into the running design job
    this.design?.setPlanner((taskId, autoStart) => this.requestPlan(taskId, undefined, autoStart, { skipDesign: true }))
  }

  worktrees() {
    // Task worktrees are pooled per project (reuse rewrites only differing files; see WorktreeManager).
    return new WorktreeManager({ root: runtimeConfig().worktreesDir, poolSize: 3 })
  }

  /** Marks runs that were active when the app stopped as interrupted (resumable). */
  async recover() {
    const stale = await this.prisma.executionRun.findMany({ where: { status: { in: [...ACTIVE_STATUSES] } } })
    for (const run of stale) {
      await this.prisma.executionRun.update({ where: { id: run.id }, data: { status: 'interrupted', errorMessage: 'The application stopped while this run was active. Resume to continue with the remaining tasks.' } })
      await this.prisma.subtask.updateMany({ where: { taskId: run.taskId, status: { in: ['running', 'validating', 'repairing', 'queued'] } }, data: { status: 'queued', worktreePath: null, branchName: null } })
      await this.prisma.agentRun.updateMany({ where: { executionId: run.id, status: 'running' }, data: { status: 'interrupted', finishedAt: new Date(), outcome: 'error', errorMessage: 'Interrupted by application shutdown.' } })
      this.logger.warn(`Execution ${run.id} marked as interrupted.`)
    }
    // Remove orphaned task worktrees (integration worktrees are kept for resume/approval).
    const projects = await this.prisma.project.findMany()
    for (const project of projects) {
      if (!(await isGitRepository(project.repoPath).catch(() => false))) continue
      for (const entry of await this.worktrees().listManaged(project.repoPath).catch(() => [])) {
        if (entry.branch && !entry.branch.endsWith('/integration')) await this.worktrees().remove(project.repoPath, entry.path, entry.branch).catch(() => undefined)
      }
    }
  }

  markShuttingDown() {
    this.shuttingDown = true
  }

  // ---------------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------------

  /** The planner's last open questions together with the user's answer (undefined when the task has no pending questions). */
  async clarificationAnswer(taskId: string, answer: string): Promise<string | undefined> {
    const messages = await this.prisma.chatMessage.findMany({ where: { taskId, role: 'assistant' }, orderBy: { createdAt: 'desc' }, take: 20 })
    for (const message of messages) {
      const metadata = message.metadata as { kind?: string; questions?: unknown } | null
      if (metadata?.kind !== 'plan_questions') continue
      const questions = Array.isArray(metadata.questions) ? metadata.questions.map(String) : []
      return `Clarification – the planner asked:\n${questions.map((question, i) => `${i + 1}. ${question}`).join('\n')}\nThe user answered:\n${answer}`
    }
    return undefined
  }

  async requestPlan(taskId: string, feedback?: string, autoStart = false, options: { skipDesign?: boolean } = {}): Promise<{ jobId: string; design?: true }> {
    const requestedAt = new Date().toISOString()
    const current = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { currentStep: true, userPrompt: true, designMode: true, plans: { select: { id: true }, take: 1 } } })
    // UI tasks get a design draft first: only before their first plan or within the design phase (re-planning a
    // planned task or answering the planner's questions never starts a design call)
    if (!options.skipDesign && this.design && current.currentStep !== 'plan_clarification' && (!current.plans.length || DESIGN_STEPS.includes(current.currentStep))) {
      const design = await this.designGate(taskId, current, feedback, autoStart)
      if (design) return design
    }
    // Answers to the planner's questions become part of the request: later re-plans keep them, no duplicate feedback.
    const block = current.currentStep === 'plan_clarification' && feedback?.trim() ? await this.clarificationAnswer(taskId, feedback.trim()) : undefined
    await this.prisma.task.update({ where: { id: taskId }, data: { currentStep: 'planning', status: 'running', ...(block ? { userPrompt: `${current.userPrompt}\n\n${block}` } : {}) } })
    const job = await this.jobs.enqueue('execution.plan', { taskId, feedback: block ? undefined : feedback, autoStart, requestedAt }, { dedupeKey: `plan:${taskId}` })
    this.events.publish('run', 'plan_requested', { taskId, jobId: job.id, requestedAt: (job.payload as Record<string, unknown>).requestedAt ?? job.createdAt.toISOString() })
    // No model warm-up here: the plan may not need a local model at all (or the user rejects it), and a
    // speculatively loaded model would sit in VRAM for keepAliveMinutes. Models load after the plan.
    // The worktrees for the integration and the first task are checked out (pool slots)
    // (best effort: never allowed to fail the request, not even synchronously)
    void Promise.resolve()
      .then(() => this.prisma.task.findUnique({ where: { id: taskId }, select: { project: { select: { id: true, repoPath: true } } } }))
      .then((task) => (task ? this.worktrees().prewarm(task.project.repoPath, task.project.id, 2) : 0))
      .catch(() => undefined)
    return { jobId: job.id }
  }

  /**
   * Design phase gate: a UI request (or designMode "force") without an approved draft starts the design
   * job instead of planning. Without a usable designer the request is planned as before (with a note).
   */
  private async designGate(taskId: string, task: { userPrompt: string; designMode?: string | null }, feedback: string | undefined, autoStart: boolean) {
    if (!this.design) return undefined
    const mode: DesignMode = DESIGN_MODES.includes(task.designMode as DesignMode) ? (task.designMode as DesignMode) : 'auto'
    if (!shouldDesign(task.userPrompt, mode)) return undefined
    if (await this.design.approved(taskId)) return undefined
    if (!(await this.design.designer(await taskOverride(this.prisma, taskId)))) {
      await this.noteOnce(taskId, 'design_unavailable', DESIGN_UNAVAILABLE_TEXT)
      return undefined
    }
    const started = await this.design.start(taskId, { autoStart, feedback })
    return { jobId: started.jobId, design: true as const }
  }

  /** A system note that is posted only once per task (repeated re-plans do not repeat it). */
  private async noteOnce(taskId: string, kind: string, content: string) {
    const recent = await this.prisma.chatMessage.findMany({ where: { taskId, role: 'system' }, orderBy: { createdAt: 'desc' }, take: 50, select: { metadata: true } })
    if (recent.some((message) => (message.metadata as { kind?: string } | null)?.kind === kind)) return
    await this.chat(taskId, 'system', content, { kind })
  }

  private async planJob(taskId: string, feedback?: string, autoStart = false, requestedAt?: string) {
    try {
      await this.plan(taskId, feedback, autoStart, requestedAt)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.prisma.task.update({ where: { id: taskId }, data: { currentStep: 'plan_failed', status: 'failed' } })
      await this.chat(taskId, 'system', `Planung fehlgeschlagen: ${message}`, { kind: 'plan_error' })
      throw error
    }
  }

  /** Restores the clock for a planning request even if the renderer missed its live events. */
  async planningStatus(taskId: string) {
    const [job] = await this.jobs.activeFor('execution.plan', (payload) => payload.taskId === taskId)
    if (!job) return undefined
    return { startedAt: String((job.payload as Record<string, unknown>).requestedAt ?? job.createdAt.toISOString()), phase: job.status === 'queued' ? 'queued' as const : 'preparing' as const }
  }

  /**
   * Plans a task with the premium orchestrator (one structured call over a compact, deterministic
   * repository digest). Without an orchestrator the deterministic single-task fallback is used and
   * labelled as such.
   */
  async plan(taskId: string, feedback?: string, autoStart = false, requestedAt = new Date().toISOString()) {
    this.events.publish('run', 'planning_started', { taskId, requestedAt })
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: { project: true } })
    const projectRef = { id: task.projectId, name: task.project.name, repoPath: task.project.repoPath }
    // an approved design draft is the base of the plan: design-001 writes its files, every task builds on it
    // ("Ohne Design planen" after an approval: designMode skip wins over the draft)
    const design = task.designMode === 'skip' ? undefined : await this.design?.approved(taskId).catch(() => undefined)
    // independent preparation steps run concurrently (each can cost seconds on a cold start);
    // plugin/skill context is only awaited when the premium planner is actually called
    const pluginContextPromise = (this.plugins?.collectContext(task.userPrompt, projectRef).catch(() => []) ?? Promise.resolve([]))
    // catalogs the planner assigns from: enabled coder agents and active skills (user-named ones flagged)
    const agentProfilesPromise: Promise<AgentProfile[]> = (this.agentProfiles?.list(task.projectId) ?? Promise.resolve([])).catch(() => [])
    const agentCatalogPromise: Promise<AgentOffer[]> = agentProfilesPromise
      .then((list) => list.filter((profile) => profile.enabled && profile.role === 'coder').map((profile) => ({ name: profile.name, description: profile.description, categories: profile.categories as string[], skills: profile.skills as string[] })))
    // all active skills: the planner sees the first 40 (requested first), the plan's skills are checked against all
    // with a design, the matching type recipe (design-<type>) is requested, so the planner attaches it to the UI tasks
    const activeSkillsPromise: Promise<SkillOffer[]> = (this.agentResources?.catalog(task.projectId, task.userPrompt, Infinity).catch(() => []) ?? Promise.resolve([]))
      .then((catalog) => (design ? requestDesignSkill(catalog, design.brief.designType) : catalog))
    const skillCatalogPromise = activeSkillsPromise.then((catalog) => catalog.slice(0, 40))
    // requested skills are for the executing agents: the planner only sees them in the catalog, never as
    // instructions to follow (it would apply or wait for them instead of planning)
    const skillContextPromise = skillCatalogPromise
      .then((catalog) => this.agentResources?.promptContext('planner', task.projectId, task.userPrompt, catalog.filter((skill) => skill.requested).map((skill) => skill.name)))
      .catch(() => undefined)
    const contextOptions = planningContextOptions(task.userPrompt)
    const [settings, { index, checks, digest }, profiles, resolved] = await Promise.all([
      this.settings.get(),
      // precise per-file instructions need the file contents; every planner read costs a slow turn
      this.repoContext.digest(task.projectId, task.project.repoPath, task.userPrompt, contextOptions.budgetTokens, contextOptions),
      this.localModels.engineProfiles(),
      taskOverride(this.prisma, taskId).then((override) => this.orchestrators.activeWithNotice(override)),
    ])
    const orchestrator = resolved.adapter
    // duo requested but not possible (or a chosen CLI is not signed in): say so once per task
    if (resolved.notice) await this.noteOnce(taskId, 'orchestrator_notice', resolved.notice)
    this.events.publish('run', 'plan_context_ready', { taskId, orchestrator: orchestrator ? orchestratorLabel(orchestrator) : null, contextTokens: digest.tokenEstimate })

    let plan: ExecutionPlan
    let source: string
    const warnings: string[] = []
    // Fast path: unambiguous small requests skip premium planning (rules in engine fastpath/fast-path.ts).
    // design-001 precedes the planned tasks
    const maxTasks = design ? Math.max(1, settings.maxTasks - 1) : settings.maxTasks
    const fast = settings.fastPath && !feedback && !design ? classifyFastPath(task.userPrompt, index) : ({ mode: 'none', reason: 'disabled' } as const)
    let fastTool: FastPathTool | undefined
    if (fast.mode === 'tool' || (fast.mode === 'local-single' && settings.costMode !== 'quality' && profiles.some((profile) => profile.available))) {
      const files = fast.mode === 'tool' ? fast.tool.files : [fast.file]
      fastTool = fast.mode === 'tool' ? fast.tool : undefined
      plan = {
        summary: fast.mode === 'tool' ? `Fast Path: ${fast.title} (deterministisches Werkzeug, kein Modellaufruf).` : 'Fast Path: kleine, eindeutige Aufgabe – ein lokaler Agent ohne Premium-Planung.',
        analysis: { summary: fast.reason, taskType: 'fast-path', complexity: 1, risk: 1, securitySensitive: false, affectedAreas: files, needsDecomposition: false, openQuestions: [] },
        tasks: [{
          id: 'task-001', title: fast.mode === 'tool' ? fast.title : task.userPrompt.replace(/\s+/g, ' ').slice(0, 90), description: task.userPrompt, category: fast.mode === 'tool' ? 'fast-path' : 'general', complexity: 1, risk: 1,
          relevantFiles: files, newFiles: [], dependsOn: [], capabilities: [], expectedInputTokens: 2000, testStrategy: 'Project validation commands in the task worktree.',
          acceptanceCriteria: ['The requested change is implemented.', 'Existing validation commands pass.'], suggestedExecutor: 'local', rationale: `Fast path: ${fast.reason}.`, agent: '', skills: [],
        }],
        warnings: [],
      }
      source = 'fast-path'
    } else if (orchestrator) {
      this.events.publish('run', 'plan_progress', { taskId, kind: 'phase', phase: 'context' })
      // context providers of enabled plugins (e.g. the text of an issue referenced as #123); short timeout, failures skipped
      const pluginContext = await pluginContextPromise
      // skills assigned to the planner whose triggers match the goal (full text, bounded)
      const skillContext = (await skillContextPromise) ?? { text: '', inlined: [] as string[] }
      const [agents, skills] = await Promise.all([agentCatalogPromise, skillCatalogPromise])
      const extra = [
        ...(skillContext.text ? [skillContext.text] : []),
        ...(pluginContext.length ? [`Context from plugins:\n${pluginContext.map((entry) => `### ${entry.plugin}/${entry.provider}\n${entry.text}`).join('\n\n')}`] : []),
      ]
      const context = extra.length ? { ...digest, summary: `${digest.summary}\n\n${extra.join('\n\n')}` } : digest
      if (pluginContext.length || skillContext.inlined.length) this.events.publish('run', 'plan_context', { taskId, providers: pluginContext.map((entry) => `${entry.plugin}/${entry.provider}`), skills: skillContext.inlined })
      const started = Date.now()
      this.events.publish('run', 'plan_progress', { taskId, kind: 'phase', phase: 'planning' })
      try {
        const { result, meta } = await orchestrator.createPlan(
          {
            goal: task.userPrompt,
            context,
            costMode: settings.costMode,
            localModels: profiles.map((profile) => ({ role: profile.roles.join('/'), model: profile.model, toolCalling: profile.toolCalling, strengths: [] })),
            maxTasks,
            feedback,
            agents,
            skills,
            ...(design ? { design: design.brief } : {}),
          },
          {
            runId: `plan-${taskId}`,
            cwd: task.project.repoPath,
            // turn-capped planning normally answers in well under a minute; 5 min is a hard safety net
            timeoutMs: 5 * 60_000,
            // planning works from a prepared digest with the file contents. Measured on a 13-file repo:
            // "high" and "medium" spent 80-110 s thinking per turn and hit the 5 min timeout, so every
            // cost mode plans with "low" (quality is decided by precise tasks and the review)
            effort: 'low',
            // live progress for the chat (which file the planner reads, which model answers)
            onEvent: (event) => {
              if (event.type === 'tool') this.events.publish('run', 'plan_progress', { taskId, kind: 'tool', name: event.name, detail: event.detail.slice(0, 200) })
              else if (event.type === 'command') this.events.publish('run', 'plan_progress', { taskId, kind: 'tool', name: '$', detail: event.command.slice(0, 200) })
              else if (event.type === 'session' && event.model) this.events.publish('run', 'plan_progress', { taskId, kind: 'model', model: event.model })
            },
          },
        )
        plan = result
        // duo: 'duo:<lead>+<partner>' (the plan message and the Leitstand name both orchestrators)
        source = orchestratorLabel(orchestrator)
        await this.recordPlanCall(orchestrator, 'ok', Date.now() - started, meta)
        if (meta.duo) {
          const duo = duoReconciledMessage(meta.duo)
          await this.chat(taskId, 'assistant', duo.content, duo.metadata)
        }
      } catch (error) {
        const kind = error instanceof OrchestratorError ? error.kind : 'process_failed'
        // a rejected plan (needs_clarification, invalid_output) still used the quota: book its tokens
        await this.recordPlanCall(orchestrator, 'error', Date.now() - started, error instanceof OrchestratorError ? error.details.meta : undefined, kind)
        if (kind === 'not_authenticated' || kind === 'session_expired') this.orchestrators.invalidate()
        if (kind === 'cancelled') throw error
        if (kind === 'needs_clarification') {
          // no fallback plan and no second premium call: show the questions, keep any existing plan untouched
          const questions = error instanceof OrchestratorError ? error.details.questions ?? [] : []
          await this.prisma.task.update({ where: { id: taskId }, data: { status: 'planned', currentStep: 'plan_clarification' } })
          await this.chat(taskId, 'assistant', questionsMessage(questions), { kind: 'plan_questions', questions })
          this.events.publish('run', 'planned', { taskId, tasks: 0, source: 'clarification', autoStarted: false })
          return { taskPlan: undefined, subtasks: [] as Subtask[], routing: undefined, warnings, source: 'clarification', questions }
        }
        warnings.push(`${orchestrator.displayName} planning failed (${kind}): ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`)
        plan = deterministicPlan(task.userPrompt, index, { maxTasks })
        source = 'deterministic-fallback'
      }
    } else {
      warnings.push(resolved.notice ? `${resolved.notice} Using the deterministic fallback planner.` : settings.orchestrator ? `${settings.orchestrator} is not connected; using the deterministic fallback planner.` : 'No orchestrator selected; using the deterministic fallback planner.')
      plan = deterministicPlan(task.userPrompt, index, { maxTasks })
      source = 'deterministic-fallback'
    }

    // Replace previous (not yet executed) plan.
    this.events.publish('run', 'plan_progress', { taskId, kind: 'phase', phase: 'saving' })
    // agent manager: each subtask gets an agent profile (the user can change it): the planner's choice, else the
    // agent named in the request (one-task plans only), else the best keyword match
    let agents: Array<AgentProfile | undefined> = assignAgents(await agentProfilesPromise, plan.tasks, task.userPrompt)
    // pinned skills per subtask: only active skills (the planner may invent names); a one-task plan also gets the
    // skills named in the request, like the named agent
    const activeSkills = await activeSkillsPromise
    const known = new Set(activeSkills.map((skill) => skill.name))
    const requestedSkills = plan.tasks.length === 1 ? activeSkills.filter((skill) => skill.requested).map((skill) => skill.name) : []
    plan = { ...plan, tasks: plan.tasks.map((planned) => ({ ...planned, skills: [...new Set([...planned.skills.filter((name) => known.has(name)), ...requestedSkills])] })) }
    // deterministic design-001 (writes design/tokens.css, DESIGN.md, mockup.html) first; set here because
    // normalizePlan drops dependencies on ids the planner did not create
    const designTool = design ? designFilesTool(design.brief, design.mockupHtml) : undefined
    if (designTool) {
      plan = withDesignTask(plan, designPlanTask(designTool))
      agents = [undefined, ...agents]
    }
    const created: Subtask[] = await this.prisma.$transaction([
      this.prisma.subtask.deleteMany({ where: { taskId } }),
      ...plan.tasks.map((planned, position) => {
      const securityCritical = [...planned.relevantFiles, ...planned.newFiles].some(isSecurityCriticalPath)
      return this.prisma.subtask.create({
          data: {
            agentId: agents[position]?.id,
            skills: asJson(planned.skills),
            taskId,
            key: planned.id,
            title: planned.title,
            goal: planned.description,
            status: 'planned',
            assignedAgentType: planned.suggestedExecutor === 'premium' ? 'PremiumAgent' : 'LocalCoderAgent',
            selectedModelClass: planned.suggestedExecutor === 'premium' ? 'premium_llm' : 'local_llm',
            expectedChange: planned.acceptanceCriteria.join('\n') || planned.title,
            allowedFiles: asJson(planned.relevantFiles),
            newFiles: asJson(planned.newFiles),
            deniedFiles: asJson([]),
            validationCommands: asJson(checks.map((check) => check.command)),
            dependsOn: asJson(planned.dependsOn),
            category: planned.category,
            complexityScore: planned.complexity,
            riskScore: securityCritical ? Math.max(planned.risk, 4) : planned.risk,
            capabilities: asJson(planned.capabilities),
            acceptanceCriteria: asJson(planned.acceptanceCriteria),
            testStrategy: planned.testStrategy,
            expectedInputTokens: planned.expectedInputTokens,
            suggestedExecutor: planned.suggestedExecutor,
            priority: plan.tasks.length - position,
            fastPath: designTool && planned.id === DESIGN_TASK_ID ? asJson(designTool) : position === 0 && fastTool ? asJson(fastTool) : undefined,
            modelReason: planned.rationale,
          },
        })
      }),
    ]).then(([, ...subtasks]) => subtasks as Subtask[])
    const routing = await this.previewRouting(taskId)
    // Small, low-risk plans skip the plan confirmation; applying the result to the project still
    // needs the user's approval (approvalMode), the run itself is isolated in a worktree.
    const autoStartSmall = settings.planApproval && !autoStart && settings.autoStartSmallPlans && isSmallSafePlan(plan, created, routing.assignments, source)
    const needsApproval = settings.planApproval && !autoStart && !autoStartSmall
    // The plan names the local models; loading them overlaps with the user's plan review.
    this.trackWarmup(taskId, this.localModels.warmup(routing.assignments.filter((entry) => entry.executor === 'local').map((entry) => entry.model), 'plan'))
    const taskPlan = await this.prisma.taskPlan.create({
      data: {
        taskId,
        summary: plan.summary,
        classification: asJson(plan.analysis),
        modelAssignments: asJson(routing.assignments),
        requiresApproval: needsApproval,
        nextAction: needsApproval ? 'await_plan_approval' : 'auto_execute',
        source,
        dag: asJson({ tasks: plan.tasks.map((planned) => ({ id: planned.id, dependsOn: planned.dependsOn })), warnings: [...warnings, ...plan.warnings], contextTokens: digest.tokenEstimate, consideredFiles: digest.consideredFiles }),
      },
    })
    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'planned',
        currentStep: needsApproval ? 'awaiting_plan_approval' : 'planned',
        normalizedGoal: plan.summary || task.userPrompt.slice(0, 500),
        complexity: (['trivial', 'small', 'medium', 'complex', 'critical'] as const)[plan.analysis.complexity - 1],
        riskLevel: (['low', 'low', 'medium', 'high', 'critical'] as const)[plan.analysis.risk - 1],
        securitySensitive: plan.analysis.securitySensitive,
      },
    })
    await this.chat(taskId, 'assistant', this.planMessage(plan, source, routing.assignments, warnings, needsApproval, autoStartSmall, agents.map((profile) => profile?.name)), { kind: 'task_plan', taskPlanId: taskPlan.id, source })
    this.events.publish('run', 'planned', { taskId, tasks: created.length, source, autoStarted: autoStartSmall })

    if (!needsApproval) await this.start(taskId)
    return { taskPlan, subtasks: created, routing, warnings, source }
  }

  /** Books a plan request: one row, or one per call in duo mode (both plans and the reconciliation). */
  private async recordPlanCall(orchestrator: OrchestratorAdapter, status: 'ok' | 'error', durationMs: number, meta?: CallMeta, errorClass?: string) {
    for (const data of modelCallRows(orchestrator.id, meta, { kind: 'orchestrator', purpose: 'plan', status, errorClass, durationMs, billing: 'unknown' })) {
      await this.prisma.modelCall.create({ data })
    }
  }

  private planMessage(plan: ExecutionPlan, source: string, assignments: Array<{ key: string; executor: string; model?: string }>, warnings: string[], needsApproval: boolean, smallPlan: boolean, agentNames: Array<string | undefined>) {
    const lines = plan.tasks.map((task, position) => {
      const agent = agentNames[position]
      const assignment = assignments.find((entry) => entry.key === task.id)
      const target = assignment?.executor === 'premium' ? 'Premium' : assignment?.model ?? 'nicht zugewiesen'
      return `- **${task.id}** ${task.title} — Komplexität ${task.complexity}/5, Risiko ${task.risk}/5 → ${target}${agent ? ` · ${agent}` : ''}${task.skills.length ? ` · Skills: ${task.skills.join(', ')}` : ''}${task.dependsOn.length ? ` (nach ${task.dependsOn.join(', ')})` : ''}`
    })
    return [
      source === 'fast-path' ? '**Fast Path (ohne Premium-Planung)**' : source === 'deterministic-fallback' ? '**Fallback-Plan (ohne Orchestrator)**' : `**Plan von ${orchestratorLabelName(source)}**`,
      plan.summary,
      '',
      ...lines,
      ...(warnings.length || plan.warnings.length ? ['', ...[...warnings, ...plan.warnings].map((warning) => `⚠ ${warning}`)] : []),
      '',
      needsApproval
        ? 'Prüfe Zuordnungen und starte die Ausführung, wenn der Plan passt.'
        : smallPlan
          ? 'Kleiner, risikoarmer Plan – die Ausführung startet automatisch. Die Übernahme ins Projekt gibst du wie gewohnt frei.'
          : 'Die Ausführung startet automatisch.',
    ].join('\n')
  }

  private async engineTasks(taskId: string): Promise<EngineTask[]> {
    // subtasks of one plan are created in one transaction (equal timestamps): priority keeps the plan order
    const subtasks = await this.prisma.subtask.findMany({ where: { taskId }, orderBy: [{ createdAt: 'asc' }, { priority: 'desc' }] })
    const agentIds = [...new Set(subtasks.map((subtask) => subtask.agentId).filter((id): id is string => Boolean(id)))]
    const profiles = new Map((agentIds.length ? await this.prisma.agentProfile.findMany({ where: { id: { in: agentIds }, enabled: true } }) : []).map((profile) => [profile.id, profile]))
    return subtasks.map((subtask) => {
      const profile = subtask.agentId ? profiles.get(subtask.agentId) : undefined
      return {
      id: subtask.id,
      key: subtask.key || subtask.id,
      title: subtask.title,
      description: subtask.goal,
      category: subtask.category,
      complexity: subtask.complexityScore,
      risk: subtask.riskScore,
      relevantFiles: stringList(subtask.allowedFiles),
      newFiles: stringList(subtask.newFiles),
      dependsOn: stringList(subtask.dependsOn),
      acceptanceCriteria: stringList(subtask.acceptanceCriteria),
      testStrategy: subtask.testStrategy ?? undefined,
      expectedInputTokens: subtask.expectedInputTokens,
      suggestedExecutor: subtask.suggestedExecutor === 'premium' ? 'premium' : 'local',
      priority: subtask.priority,
      // a model chosen for this subtask wins over the agent's model
      manualModel: subtask.manualModel ?? profile?.model ?? undefined,
      status: subtask.status === 'completed' ? 'completed' : 'planned',
      commitSha: subtask.commitSha ?? undefined,
      tool: (subtask.fastPath ?? undefined) as FastPathTool | undefined,
      agent: profile && this.agentProfiles ? this.agentProfiles.toAssignment(profile) : undefined,
      skills: stringList(subtask.skills),
    } satisfies EngineTask
    })
  }

  /** Agent manager: assign an agent profile to a planned subtask (null = automatic routing only). */
  async setAgent(subtaskId: string, agentId: string | null) {
    if (agentId && !(await this.prisma.agentProfile.findUnique({ where: { id: agentId } }))) throw new NotFoundException('Agent not found.')
    const subtask = await this.prisma.subtask.update({ where: { id: subtaskId }, data: { agentId } })
    if (!(await this.activeRunnerForTask(subtask.taskId))) await this.previewRouting(subtask.taskId)
    return subtask
  }

  /** Routing preview ("Modellzuordnungen prüfen"); persisted on the subtasks. */
  async previewRouting(taskId: string) {
    const [tasks, profiles, stats, orchestrator, settings] = await Promise.all([this.engineTasks(taskId), this.localModels.engineProfiles(), this.suitability(), taskOverride(this.prisma, taskId).then((override) => this.orchestrators.active(override)), this.settings.get()])
    const assignments = []
    const updates = []
    for (const task of tasks) {
      const decision = routeTask(
        { id: task.key, category: task.category, complexity: task.complexity, risk: task.risk, expectedInputTokens: task.expectedInputTokens, suggestedExecutor: task.suggestedExecutor, securityCritical: [...task.relevantFiles, ...task.newFiles].some(isSecurityCriticalPath), manualModel: task.manualModel },
        profiles,
        { costMode: settings.costMode, premiumAvailable: Boolean(orchestrator), premiumExecutionAllowed: settings.premiumExecutionAllowed },
        stats,
      )
      updates.push(this.prisma.subtask.update({
        where: { id: task.id },
        data: {
          selectedModelClass: decision.executor === 'premium' ? 'premium_llm' : decision.executor === 'local' ? 'local_llm' : 'no_llm',
          selectedModelName: decision.executor === 'premium' ? orchestrator?.displayName ?? 'premium' : decision.model ?? null,
          modelReason: decision.reasons.join('\n'),
          skippedModels: asJson(decision.escalation.map((step) => (step.executor === 'premium' ? 'premium' : step.model))),
        },
      }))
      assignments.push({ key: task.key, subtaskId: task.id, executor: decision.executor, model: decision.model, tier: decision.tier, reasons: decision.reasons, escalation: decision.escalation, requiresApproval: decision.requiresApproval })
    }
    // one SQLite transaction instead of one commit per subtask
    if (updates.length) await this.prisma.$transaction(updates)
    return { assignments, localModels: profiles, premium: orchestrator ? orchestrator.displayName : null }
  }

  async setManualModel(subtaskId: string, model: string | null) {
    const subtask = await this.prisma.subtask.update({ where: { id: subtaskId }, data: { manualModel: model } })
    const runner = await this.activeRunnerForTask(subtask.taskId)
    if (!runner) await this.previewRouting(subtask.taskId)
    return subtask
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  async start(taskId: string) {
    return this.taskLocks.run(taskId, () => this.startLocked(taskId))
  }

  private async startLocked(taskId: string) {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: { project: true, subtasks: true } })
    if (task.currentStep === 'plan_clarification') throw new BadRequestException('Der Orchestrator hat Rückfragen – bitte beantworten und neu planen.')
    if (task.currentStep === 'designing') throw new BadRequestException('Der Design-Entwurf wird noch erstellt – die Planung folgt nach der Freigabe.')
    if (task.currentStep === 'awaiting_design_approval') throw new BadRequestException('Der Design-Entwurf wartet auf deine Freigabe – freigeben, überarbeiten oder ohne Design planen.')
    // subtasks of an older plan must not run while the design phase that replaces it has failed
    if (task.currentStep === 'design_failed') throw new BadRequestException('Der Design-Entwurf ist fehlgeschlagen – neu entwerfen oder ohne Design planen.')
    if (!task.subtasks.length) throw new BadRequestException('The task has no plan yet.')
    // git is set up here at the latest (no repository or no commit yet): the user never has to do it.
    // Checked before a run exists: otherwise the run is created and fails right away.
    if (!(await isGitRepository(task.project.repoPath)) || !(await headCommit(task.project.repoPath))) {
      const repository = await ensureRepository(task.project.repoPath, { allowLarge: true })
      if (!repository.hasCommit) throw new BadRequestException(`Git could not be set up automatically in this folder: ${repository.skipped ?? 'no commit could be created'}`)
      await this.chat(taskId, 'system', `Git wurde für dieses Projekt automatisch eingerichtet (erster Commit). Ergebnisse landen nach jedem Lauf direkt auf dem Hauptbranch.${repository.excluded?.length ? ` Nicht übernommen: ${repository.excluded.join(', ')}.` : ''}`, { kind: 'repository_initialized' })
    }
    const active = await this.prisma.executionRun.findFirst({ where: { taskId, status: { in: [...ACTIVE_STATUSES] } } })
    if (active) return active
    const settings = await this.settings.get()
    const orchestrator = await this.orchestrators.active(await taskOverride(this.prisma, taskId))
    // A fresh run gets a fresh integration branch, so every task runs again (resume keeps completed ones).
    await this.prisma.subtask.updateMany({ where: { taskId }, data: { status: 'queued', errorMessage: null, attempts: 0, commitSha: null } })
    const execution = await this.prisma.executionRun.create({
      data: {
        taskId,
        projectId: task.projectId,
        status: 'pending',
        orchestrator: orchestrator ? orchestratorLabel(orchestrator) : null,
        costMode: settings.costMode,
        approvalMode: settings.approvalMode,
        premiumAllowed: settings.premiumExecutionAllowed,
        startedAt: new Date(),
      },
    })
    await this.prisma.task.update({ where: { id: taskId }, data: { status: 'running', currentStep: 'running_agents', lastRunId: execution.id } })
    await this.jobs.enqueue('execution.run', { executionId: execution.id }, { dedupeKey: `exec:${execution.id}` })
    this.events.publish('run', 'execution_created', { executionId: execution.id, taskId, projectId: task.projectId, sessionId: task.sessionId }, execution.id)
    return execution
  }

  /** Resumes an interrupted or failed run: completed tasks stay integrated, the rest runs again. */
  async resume(executionId: string) {
    return this.runLocks.run(executionId, () => this.resumeLocked(executionId))
  }

  private async resumeLocked(executionId: string) {
    const execution = await this.prisma.executionRun.findUniqueOrThrow({ where: { id: executionId } })
    if (!['interrupted', 'failed'].includes(execution.status)) throw new BadRequestException(`A ${execution.status} run cannot be resumed.`)
    if (!execution.integrationBranch) throw new BadRequestException('This run has no integration branch to resume from; start a new run.')
    await this.prisma.subtask.updateMany({ where: { taskId: execution.taskId, status: { notIn: ['completed'] } }, data: { status: 'queued', errorMessage: null } })
    await this.prisma.executionRun.update({ where: { id: executionId }, data: { status: 'pending', errorMessage: null, finishedAt: null } })
    await this.jobs.enqueue('execution.run', { executionId }, { dedupeKey: `exec:${executionId}` })
    this.events.publish('run', 'execution_created', { executionId, taskId: execution.taskId, projectId: execution.projectId, resumed: true }, executionId)
    return { ok: true }
  }

  async retryTask(subtaskId: string) {
    const subtask = await this.prisma.subtask.update({ where: { id: subtaskId }, data: { status: 'queued', errorMessage: null } })
    const execution = await this.prisma.executionRun.findFirst({ where: { taskId: subtask.taskId }, orderBy: { createdAt: 'desc' } })
    if (execution && ['failed', 'interrupted'].includes(execution.status) && execution.integrationBranch) return this.resume(execution.id)
    return { ok: true, note: 'The task will run with the next execution.' }
  }

  private async runJob(executionId: string, signal: AbortSignal) {
    const execution = await this.prisma.executionRun.findUniqueOrThrow({ where: { id: executionId }, include: { task: { include: { project: true } } } })
    const project = execution.task.project
    const settings = await this.settings.get()
    this.trackWarmup(
      execution.taskId,
      this.prisma.subtask
        .findMany({ where: { taskId: execution.taskId, selectedModelClass: 'local_llm' }, select: { selectedModelName: true } })
        .then((rows) => this.localModels.warmup(rows.map((row) => row.selectedModelName), 'run')),
    )
    // the run only needs the index and the checks (the planning digest is not rebuilt here)
    const [tasks, profiles, stats, resolved, localSlots, ollama, { index, checks }, design] = await Promise.all([
      this.engineTasks(execution.taskId),
      this.localModels.engineProfiles(),
      this.suitability(),
      // a duo run stays a duo (also when resumed); otherwise the task's own choice, else the settings as before
      (async () => this.orchestrators.activeWithNotice(overrideFromLabel(execution.orchestrator) === 'duo' ? 'duo' : await taskOverride(this.prisma, execution.taskId)))(),
      this.localModels.localSlots(),
      this.localModels.client(),
      this.repoContext.runContext(project.id, project.repoPath, execution.task.userPrompt),
      // loaded once per run: UI tasks get the approved design as instructions (also local models without tools)
      execution.task.designMode === 'skip' ? undefined : this.design?.approved(execution.taskId).catch(() => undefined),
    ])
    const orchestrator = resolved.adapter
    const store = new PrismaEngineStore(this.prisma, this.events, executionId, execution.taskId)
    if (resolved.notice) store.emit({ runId: executionId, level: 'warn', type: 'orchestrator_notice', message: resolved.notice })
    if (!profiles.some((profile) => profile.available)) {
      store.emit({ runId: executionId, level: 'warn', type: 'no_local_models', message: 'No local model roles are assigned/installed; tasks will be routed to the premium orchestrator or blocked.' })
    }
    if (!orchestrator && settings.orchestrator) store.emit({ runId: executionId, level: 'warn', type: 'orchestrator_unavailable', message: `${settings.orchestrator} is not connected; premium execution and review are unavailable.` })

    const runner = new ExecutionRunner(
      {
        id: executionId,
        projectKey: project.id,
        repoPath: project.repoPath,
        goal: execution.task.userPrompt,
        baseCommit: execution.baseCommit ?? undefined,
        integrationBranch: execution.integrationBranch ?? undefined,
        integrationWorktree: execution.integrationWorktree ?? undefined,
      },
      tasks,
      {
        store,
        worktrees: this.worktrees(),
        ollama,
        localClientFor: (model) => this.localModels.clientFor(model, ollama),
        localModels: profiles,
        orchestrator,
        checks,
        index,
        stats,
        settings: {
          costMode: settings.costMode,
          premiumExecutionAllowed: settings.premiumExecutionAllowed,
          premiumReviewPolicy: settings.premiumReviewPolicy,
          maxLocalRepairs: settings.maxLocalRepairs,
          maxEscalationSteps: settings.maxEscalationSteps,
          localSlots,
          premiumSlots: settings.premiumParallelism,
          allowProjectCode: settings.allowProjectCode,
          approvedCommands: settings.approvedCommands,
          numCtx: settings.numCtx,
          taskTimeoutMs: settings.taskTimeoutMinutes * 60_000,
          strictScope: settings.strictScope,
          reviewFixRounds: settings.reviewFixRounds,
          premiumHints: settings.premiumHints,
          keepAlive: `${settings.keepAliveMinutes}m`,
        },
        // skills, MCP and plugin tools assigned to the "coder" role
        agentResources: this.agentResources || design
          ? async ({ task, worktreePath, supportsTools }) => {
              const profile = task.agent && this.agentResources ? await this.prisma.agentProfile.findUnique({ where: { id: task.agent.id } }) : null
              const resources = this.agentResources
                ? await this.agentResources.forAgent('coder', {
                    projectId: project.id,
                    goal: `${task.title}\n${task.description}`,
                    cwd: worktreePath,
                    supportsTools,
                    pinned: task.skills ?? [],
                    profile: profile ? { skills: profile.skills as string[], mcpServers: profile.mcpServers as string[], pluginTools: profile.pluginTools } : undefined,
                  })
                : { tools: [], sources: [] }
              return design ? withDesignGuidance(resources, design.brief, task) : resources
            }
          : undefined,
      },
    )
    this.runners.set(executionId, runner)
    const onAbort = () => {
      if (!this.shuttingDown) runner.cancel()
    }
    signal.addEventListener('abort', onAbort)
    try {
      const outcome = await runner.execute()
      if (this.shuttingDown && outcome.status === 'cancelled') {
        await this.prisma.executionRun.update({ where: { id: executionId }, data: { status: 'interrupted', errorMessage: 'Interrupted by application shutdown.' } })
        return
      }
      await this.prisma.task.update({
        where: { id: execution.taskId },
        data: {
          status: outcome.status === 'awaiting_approval' ? 'needs_review' : outcome.status === 'cancelled' ? 'cancelled' : 'failed',
          currentStep: outcome.status === 'awaiting_approval' ? 'waiting_for_user' : outcome.status,
        },
      })
      const run = await this.prisma.executionRun.findUniqueOrThrow({ where: { id: executionId } })
      await this.chat(execution.taskId, 'agent', this.runMessage(run, outcome.integratedTasks, outcome.failedTasks), { kind: 'run_summary', executionId })
      if (outcome.status === 'awaiting_approval') await this.maybeAutoApply(run)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.prisma.executionRun.update({ where: { id: executionId }, data: { status: this.shuttingDown ? 'interrupted' : 'failed', errorMessage: message.slice(0, 4000), finishedAt: new Date() } })
      await this.prisma.task.update({ where: { id: execution.taskId }, data: { status: 'failed', currentStep: 'failed' } })
      store.emit({ runId: executionId, level: 'error', type: 'run_error', message })
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.runners.delete(executionId)
      const final = await this.prisma.executionRun.findUnique({ where: { id: executionId }, select: { status: true } }).catch(() => null)
      this.events.publish('run', 'execution_finished', { executionId, taskId: execution.taskId, projectId: execution.projectId, sessionId: execution.task.sessionId, status: final?.status }, executionId)
      // the models of the run leave the VRAM right away instead of after keepAliveMinutes (on shutdown the
      // run is resumed later, its models stay)
      if (!this.shuttingDown) void this.unloadRunModels(executionId, execution.taskId)
    }
  }

  /** Models warmed for a task (plan and run warm-ups): the end of its run unloads them as well. */
  private readonly warmed = new Map<string, { at: number; models: Set<string> }>()

  /** Warm-up requests per task that have not reported their models yet (unloadRunModels waits for them). */
  private readonly pendingWarmups = new Map<string, Set<Promise<void>>>()

  private trackWarmup(taskId: string, warmup: Promise<string[] | undefined>) {
    const pending = this.pendingWarmups.get(taskId) ?? new Set<Promise<void>>()
    const tracked: Promise<void> = warmup
      .then((started) => this.rememberWarmed(taskId, started))
      .catch(() => undefined)
      .finally(() => {
        pending.delete(tracked)
        if (!pending.size && this.pendingWarmups.get(taskId) === pending) this.pendingWarmups.delete(taskId)
      })
    pending.add(tracked)
    this.pendingWarmups.set(taskId, pending)
  }

  private rememberWarmed(taskId: string, models: string[] | undefined) {
    if (!Array.isArray(models) || !models.length) return
    const entry = this.warmed.get(taskId) ?? { at: 0, models: new Set<string>() }
    entry.at = Date.now()
    for (const model of models) entry.models.add(model)
    this.warmed.set(taskId, entry)
  }

  /**
   * Unloads the local models of a finished run (models of its subtasks and agent attempts, models warmed
   * for its task) from the app's Ollama instance, unless another active run or a freshly planned task
   * still needs them. Best effort: never throws; returns the unloaded models.
   */
  async unloadRunModels(executionId: string, taskId: string): Promise<string[]> {
    try {
      const settings = await this.settings.get()
      if (!settings.unloadAfterRun) {
        this.warmed.delete(taskId)
        return []
      }
      // a warm-up of this task still being prepared would load its models after the unload: wait for it first
      await Promise.allSettled([...(this.pendingWarmups.get(taskId) ?? [])])
      const warmed = this.warmed.get(taskId)
      this.warmed.delete(taskId)
      const localNames = (rows: Array<{ selectedModelClass?: string | null; selectedModelName: string | null; manualModel?: string | null }>) =>
        rows.flatMap((row) => [row.selectedModelClass === 'local_llm' ? row.selectedModelName : null, row.manualModel && row.manualModel !== 'premium' ? row.manualModel : null]).filter((name): name is string => Boolean(name))
      const [subtasks, attempts] = await Promise.all([
        this.prisma.subtask.findMany({ where: { taskId }, select: { selectedModelClass: true, selectedModelName: true, manualModel: true } }),
        this.prisma.agentRun.findMany({ where: { executionId, selectedModelClass: 'local_llm' }, select: { selectedModelClass: true, selectedModelName: true } }),
      ])
      const used = new Set([...localNames(subtasks), ...localNames(attempts), ...(warmed?.models ?? [])])
      if (!used.size) return []
      // models still loading in the background (warm-up) appear in `running` only once loaded
      await this.localModels.loadsSettled([...used])
      // read after the waits: a run started meanwhile (also a resumed run of this task) keeps its models
      const otherRuns = await this.prisma.executionRun.findMany({ where: { id: { not: executionId }, status: { in: [...ACTIVE_STATUSES] } }, select: { id: true, taskId: true } })
      if (otherRuns.some((run) => run.taskId === taskId)) return []
      const otherTasks = [...new Set(otherRuns.map((run) => run.taskId))]
      const [otherSubtasks, otherAttempts] = otherRuns.length
        ? await Promise.all([
            this.prisma.subtask.findMany({ where: { taskId: { in: otherTasks } }, select: { selectedModelClass: true, selectedModelName: true, manualModel: true } }),
            // escalations of other runs use models their subtasks do not name
            this.prisma.agentRun.findMany({ where: { executionId: { in: otherRuns.map((run) => run.id) }, selectedModelClass: 'local_llm' }, select: { selectedModelClass: true, selectedModelName: true } }),
          ])
        : [[], []]
      const needed = new Set([...localNames(otherSubtasks), ...localNames(otherAttempts)])
      // models warmed for other tasks (a plan waiting for approval, another run) stay while Ollama would keep them anyway
      for (const [otherTask, entry] of this.warmed) {
        if (otherTask !== taskId && (otherTasks.includes(otherTask) || Date.now() - entry.at < settings.keepAliveMinutes * 60_000)) for (const model of entry.models) needed.add(model)
      }
      const loaded = new Set((await this.localModels.running()).map((entry) => entry.name))
      const unloaded: string[] = []
      for (const model of used) {
        if (needed.has(model) || !loaded.has(model)) continue
        try {
          await this.localModels.unload(model)
          unloaded.push(model)
        } catch (error) {
          this.logger.warn(`Model ${model} could not be unloaded after run ${executionId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return unloaded
    } catch (error) {
      this.logger.warn(`Unloading the models of run ${executionId} failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  private runMessage(run: ExecutionRun, integrated: string[], failed: string[]) {
    const review = run.review as { kind?: string; result?: { verdict?: string; score?: number; summary?: string }; reason?: string }
    const validation = run.finalValidation as { summary?: string }
    return [
      run.status === 'awaiting_approval' ? '**Ausführung abgeschlossen – Freigabe erforderlich.**' : `**Ausführung ${run.status}.**`,
      `Integriert: ${integrated.join(', ') || '–'}${failed.length ? ` · Nicht integriert: ${failed.join(', ')}` : ''}`,
      validation?.summary ? `Validierung: ${validation.summary}` : '',
      review?.result ? `Premium-Review: ${review.result.verdict} (${review.result.score}/100) – ${review.result.summary}` : review?.reason ? `Review: ${review.reason}` : '',
      run.errorMessage ? `⚠ ${run.errorMessage}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  private async maybeAutoApply(run: ExecutionRun) {
    const settings = await this.settings.get()
    if (settings.approvalMode === 'manual') return
    const review = run.review as { kind?: string; result?: { verdict?: string } }
    const validation = run.finalValidation as { ok?: boolean }
    const diffFiles = (run.finalDiff ?? '').match(/^diff --git a\/(\S+)/gm)?.map((line) => line.replace('diff --git a/', '')) ?? []
    const safe = validation?.ok === true && (review?.kind === 'deterministic' || review?.result?.verdict === 'approve') && !diffFiles.some(isSecurityCriticalPath)
    const why = safe ? '' : validation?.ok !== true ? 'die Prüfungen (Typecheck/Tests) sind nicht bestanden' : diffFiles.some(isSecurityCriticalPath) ? 'sicherheitskritische Dateien sind betroffen' : 'der Review hat das Ergebnis nicht freigegeben'
    // auto_commit: the result always goes into the main code; concerns are only reported (undo stays possible)
    if (!safe && settings.approvalMode !== 'auto_commit') {
      this.events.publish('run', 'auto_apply_skipped', { executionId: run.id, reason: 'Validation, review or security checks require manual approval.' }, run.id)
      await this.chat(run.taskId, 'system', `Nicht automatisch übernommen, weil ${why}. Prüfe das Ergebnis unter „Freigabe“.`, { kind: 'auto_apply_skipped', executionId: run.id })
      return
    }
    const mode: ApplyMode = settings.approvalMode === 'auto_commit' ? 'commit' : settings.approvalMode === 'auto_working_tree' ? 'working_tree' : 'branch'
    const result = await this.approve(run.id, mode)
    this.events.publish('run', result.ok ? 'auto_applied' : 'auto_apply_skipped', { executionId: run.id, message: result.message }, run.id)
    if (result.ok && !safe) await this.chat(run.taskId, 'system', `Automatisch committet, obwohl ${why}. Unter „Freigabe“ kannst du den Commit prüfen oder rückgängig machen.`, { kind: 'auto_applied_with_concerns', executionId: run.id })
    // a refusal (own uncommitted changes in the same files, a conflict) waits under "Freigabe" with the reason
    if (!result.ok) await this.chat(run.taskId, 'system', 'Nicht automatisch übernommen: deine Arbeitskopie oder dein Branch kollidiert mit dem Ergebnis. Nichts wurde verändert – Details und Optionen unter „Freigabe“.', { kind: 'auto_apply_skipped', executionId: run.id })
  }

  private async activeRunnerForTask(taskId: string) {
    const execution = await this.prisma.executionRun.findFirst({ where: { taskId, status: { in: [...ACTIVE_STATUSES] } } })
    return execution ? this.runners.get(execution.id) : undefined
  }

  private runner(executionId: string) {
    const runner = this.runners.get(executionId)
    if (!runner) throw new NotFoundException('This run is not active.')
    return runner
  }

  pause(executionId: string) {
    this.runner(executionId).pause()
    return { ok: true }
  }

  resumePaused(executionId: string) {
    this.runner(executionId).resume()
    return { ok: true }
  }

  async cancel(executionId: string) {
    const runner = this.runners.get(executionId)
    if (runner) runner.cancel()
    else await this.prisma.executionRun.updateMany({ where: { id: executionId, status: { in: ['pending', 'interrupted'] } }, data: { status: 'cancelled', finishedAt: new Date() } })
    return { ok: true }
  }

  async cancelTask(subtaskId: string) {
    const subtask = await this.prisma.subtask.findUniqueOrThrow({ where: { id: subtaskId } })
    const runner = await this.activeRunnerForTask(subtask.taskId)
    runner?.cancelTask(subtask.key)
    return { ok: Boolean(runner) }
  }

  // ---------------------------------------------------------------------------
  // Approval / integration
  // ---------------------------------------------------------------------------

  async approve(executionId: string, mode: ApplyMode) {
    return this.runLocks.run(executionId, () => this.approveLocked(executionId, mode))
  }

  private async approveLocked(executionId: string, mode: ApplyMode) {
    if (!['branch', 'working_tree', 'fast_forward', 'commit'].includes(mode)) throw new BadRequestException('Unknown apply mode.')
    const run = await this.prisma.executionRun.findUniqueOrThrow({ where: { id: executionId }, include: { project: true, task: { select: { userPrompt: true, session: { select: { title: true } } } } } })
    if (run.status !== 'awaiting_approval') throw new BadRequestException(`Run is ${run.status}, not awaiting approval.`)
    if (!run.integrationWorktree || !run.integrationBranch || !run.baseCommit) throw new BadRequestException('Run has no integration result.')
    const title = (run.task.session?.title || run.task.userPrompt.split('\n')[0] || 'Änderungen').slice(0, 72)
    const commitMessage = `Multi-AI Coder: ${title}`
    let outcome = await applyChangeSet({ repoPath: run.project.repoPath, integrationWorktree: run.integrationWorktree, integrationBranch: run.integrationBranch, baseCommit: run.baseCommit, mode, commitMessage })
    // the project moved on (newer commits, conflicting lines, own edits in the same files): the result is
    // brought up to date in the integration worktree, validated again and applied once more
    if (!outcome.ok && (mode === 'commit' || mode === 'working_tree')) {
      outcome = (await this.catchUp({ ...run, integrationWorktree: run.integrationWorktree, integrationBranch: run.integrationBranch }, mode, outcome, commitMessage).catch((error: unknown) => {
        this.logger.warn(`Catching up run ${executionId} failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })) ?? outcome
    }
    const record = await this.prisma.applyRecord.create({
      data: {
        executionId,
        mode,
        patch: outcome.patch ?? '',
        files: asJson(outcome.files),
        targetBranch: outcome.targetBranch,
        beforeHead: outcome.beforeHead,
        afterHead: outcome.afterHead,
        status: outcome.ok ? 'applied' : 'rejected',
        message: outcome.message,
      },
    })
    if (outcome.ok) {
      await this.prisma.executionRun.update({ where: { id: executionId }, data: { status: 'applied', finishedAt: new Date() } })
      await this.prisma.task.update({ where: { id: run.taskId }, data: { status: 'completed', currentStep: 'applied' } })
      if (mode !== 'branch') await this.worktrees().remove(run.project.repoPath, run.integrationWorktree, run.integrationBranch).catch(() => undefined)
      else await this.worktrees().remove(run.project.repoPath, run.integrationWorktree, run.integrationBranch, { deleteBranch: false }).catch(() => undefined)
      await this.chat(run.taskId, 'system', `✓ ${outcome.message}`, { kind: 'applied', applyRecordId: record.id })
    }
    this.events.publish('run', outcome.ok ? 'applied' : 'apply_rejected', { executionId, mode, message: outcome.message, blockedBy: outcome.blockedBy }, executionId)
    return { ...outcome, patch: undefined, applyRecordId: record.id }
  }

  /**
   * A refused apply because the project moved on: the current state of the branch is merged into the
   * result in the integration worktree (the user's checkout is not touched), conflicting regions are
   * merged by a model, the checks run again and the result is applied once more. When committing, own
   * uncommitted edits in the same files are saved as a commit first instead of blocking.
   * Undefined when that is not possible (the refusal stays, with the reason in the chat).
   */
  private async catchUp(
    run: ExecutionRun & { project: { id: string; repoPath: string }; task: { userPrompt: string }; integrationWorktree: string; integrationBranch: string },
    mode: ApplyMode,
    refused: ApplyOutcome,
    commitMessage: string,
  ): Promise<ApplyOutcome | undefined> {
    const repoPath = run.project.repoPath
    if (refused.reason === 'dirty') {
      const files = refused.blockedBy ?? []
      if (mode !== 'commit' || !files.length || files.some(isSensitivePath)) return undefined
      await git(repoPath, ['add', '-A', '--', ...files])
      const message = 'Eigene Änderungen vor der Übernahme gesichert'
      let saved = await git(repoPath, ['commit', '-q', '-m', message, '--', ...files], { allowFailure: true })
      // no git identity configured: the app's identity
      if (saved.exitCode !== 0) saved = await git(repoPath, ['commit', '-q', '-m', message, '--', ...files], { allowFailure: true, internal: true })
      if (saved.exitCode !== 0) return undefined
      await this.chat(run.taskId, 'system', `Deine nicht committeten Änderungen in ${files.join(', ')} wurden vor der Übernahme als Commit gesichert und werden mit dem Ergebnis zusammengeführt.`, { kind: 'own_changes_saved', executionId: run.id })
    } else if (refused.reason !== 'conflict' && refused.reason !== 'base_moved') return undefined

    const target = await headCommit(repoPath)
    if (!target) return undefined
    const before = await headCommit(run.integrationWorktree)
    const settings = await this.settings.get()
    let checks: Awaited<ReturnType<RepoContextService['runContext']>>['checks'] | undefined
    let feedback: string | undefined
    let caughtUp: Awaited<ReturnType<typeof catchUpIntegration>> | undefined
    let resolver: Awaited<ReturnType<ExecutionService['conflictResolver']>>
    // up to three attempts: a merge that fails the checks goes back to the model with the error
    for (let attempt = 0; attempt < 3; attempt += 1) {
      resolver = await this.conflictResolver(run.id, run.integrationWorktree, feedback)
      const merge = await catchUpIntegration({ integrationWorktree: run.integrationWorktree, target, message: 'Multi-AI Coder: aktuellen Projektstand zusammengeführt', resolve: resolver?.resolve, renames: attempt === 0 })
      if (!merge.ok) {
        const why = merge.unresolved.length
          ? `${merge.unresolved.join(', ')} ${resolver ? `konnte(n) auch mit ${resolver.label} nicht sicher zusammengeführt werden` : 'konnte(n) nicht zusammengeführt werden (kein lokales Modell oder Orchestrator verfügbar)'}`
          : merge.message
        await this.chat(run.taskId, 'system', `Das Ergebnis konnte nicht automatisch an den neueren Projektstand angepasst werden: ${why}. Nichts wurde verändert.`, { kind: 'catch_up_failed', executionId: run.id })
        return undefined
      }
      if (!merge.resolved.length) {
        caughtUp = merge
        break
      }
      // merged text is new code: the project's checks decide whether it is kept
      checks ??= (await this.repoContext.runContext(run.project.id, repoPath, run.task.userPrompt)).checks
      // compared with the run's own final validation: failures it already accepted (red before the change) do not count
      const raw = await runValidationChecks(run.integrationWorktree, checks, { allowProjectCode: settings.allowProjectCode, approvedCommands: settings.approvedCommands })
      const validated = run.finalValidation as Partial<ValidationReport> | null
      const report = !raw.ok && Array.isArray(validated?.results) ? againstBaseline(raw, validated as ValidationReport) : raw
      if (report.ok) {
        caughtUp = merge
        break
      }
      await git(run.integrationWorktree, ['reset', '-q', '--hard', before!], { allowFailure: true })
      feedback = failureDigest(report).slice(0, 2000)
      if (attempt === 2 || !resolver) {
        await this.chat(run.taskId, 'system', `Die Konflikte in ${merge.resolved.join(', ')} wurden zusammengeführt, aber die Prüfungen schlagen danach fehl (${report.summary}). Nichts wurde verändert.`, { kind: 'catch_up_failed', executionId: run.id })
        return undefined
      }
    }
    if (!caughtUp) return undefined
    const finalDiff = await diffBetween(run.integrationWorktree, target, caughtUp.head!)
    await this.prisma.executionRun.update({ where: { id: run.id }, data: { baseCommit: target, finalDiff } })
    const outcome = await applyChangeSet({ repoPath, integrationWorktree: run.integrationWorktree, integrationBranch: run.integrationBranch, baseCommit: target, mode, commitMessage })
    if (outcome.ok && caughtUp.resolved.length) {
      await this.chat(run.taskId, 'system', `Konflikte mit dem neueren Projektstand in ${caughtUp.resolved.join(', ')} automatisch zusammengeführt (${resolver?.used() ? resolver.label : 'ohne Modell'}); Prüfungen danach bestanden.`, { kind: 'conflicts_resolved', executionId: run.id, files: caughtUp.resolved })
    }
    return outcome
  }

  /** Merges conflicting regions: a local model first (no cost), else the connected orchestrator. */
  private async conflictResolver(executionId: string, cwd: string, feedback?: string): Promise<{ label: string; resolve: HunkResolver; used: () => boolean } | undefined> {
    const settings = await this.settings.get()
    const profiles = await this.localModels.engineProfiles().catch(() => [])
    const local = (['advanced', 'balanced', 'fast'] as const).map((role) => settings.modelRoles[role]).find((model) => model && profiles.some((profile) => profile.model === model && profile.available))
    const accepted = (hunk: ConflictHunk, answer: string) => {
      const merged = cleanMergeAnswer(answer, hunk)
      return merged !== undefined && acceptMerge(hunk, merged) ? merged : undefined
    }
    let calls = 0
    const used = () => calls > 0
    if (local) {
      const client = this.localModels.clientFor(local, await this.localModels.client())
      return {
        label: local,
        used,
        resolve: async (hunk) => {
          calls += 1
          // two attempts: a small model occasionally drops one side
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const result = await client.chat({ model: local, messages: mergePrompt(hunk, feedback), options: { temperature: attempt ? 0.3 : 0, num_ctx: 8192 } }, { timeoutMs: 3 * 60_000, idleTimeoutMs: 60_000 })
            const merged = accepted(hunk, result.message.content)
            if (merged !== undefined) return merged
          }
          return undefined
        },
      }
    }
    const active = await this.orchestrators.active()
    const orchestrator = isDuo(active) ? active.leadAdapter : active
    if (!orchestrator) return undefined
    return {
      label: orchestrator.displayName,
      used,
      resolve: async (hunk) => {
        calls += 1
        const started = Date.now()
        const [system, user] = mergePrompt(hunk, feedback)
        try {
          const { result, meta } = await orchestrator.chat({ question: `${system!.content}\n\n${user!.content}`, context: { summary: '', relevantFiles: [], validationCommands: [] } }, { runId: `merge-${executionId}-${started}`, cwd, timeoutMs: 5 * 60_000, effort: 'low' })
          for (const data of modelCallRows(orchestrator.id, meta, { kind: 'orchestrator', purpose: 'merge', status: 'ok', durationMs: meta.durationMs, executionId })) {
            await this.prisma.modelCall.create({ data })
          }
          return accepted(hunk, result.answer)
        } catch (error) {
          for (const data of failedCallRows(orchestrator.id, error, { kind: 'orchestrator', purpose: 'merge', durationMs: Date.now() - started, executionId })) {
            await this.prisma.modelCall.create({ data })
          }
          return undefined
        }
      },
    }
  }

  async discard(executionId: string) {
    return this.runLocks.run(executionId, () => this.discardLocked(executionId))
  }

  private async discardLocked(executionId: string) {
    const run = await this.prisma.executionRun.findUniqueOrThrow({ where: { id: executionId }, include: { project: true } })
    if (['applied', 'cancelled'].includes(run.status)) return { ok: true, alreadyFinal: run.status }
    this.runners.get(executionId)?.cancel()
    if (run.integrationWorktree) await this.worktrees().remove(run.project.repoPath, run.integrationWorktree, run.integrationBranch ?? undefined).catch(() => undefined)
    await this.prisma.executionRun.update({ where: { id: executionId }, data: { status: 'cancelled', finishedAt: new Date(), integrationWorktree: null } })
    await this.prisma.task.update({ where: { id: run.taskId }, data: { status: 'cancelled', currentStep: 'discarded' } })
    this.events.publish('run', 'discarded', { executionId }, executionId)
    return { ok: true }
  }

  async undo(applyRecordId: string) {
    const owner = await this.prisma.applyRecord.findUniqueOrThrow({ where: { id: applyRecordId }, select: { executionId: true } })
    return this.runLocks.run(owner.executionId, () => this.undoLocked(applyRecordId))
  }

  private async undoLocked(applyRecordId: string) {
    const record = await this.prisma.applyRecord.findUniqueOrThrow({ where: { id: applyRecordId }, include: { execution: { include: { project: true } } } })
    if (record.status !== 'applied') throw new BadRequestException('Only applied change sets can be undone.')
    const result = await revertChangeSet({
      repoPath: record.execution.project.repoPath,
      mode: record.mode as ApplyMode,
      patch: record.patch,
      files: stringList(record.files),
      beforeHead: record.beforeHead ?? undefined,
      afterHead: record.afterHead ?? undefined,
    })
    if (result.ok) {
      await this.prisma.applyRecord.update({ where: { id: applyRecordId }, data: { status: 'reverted', revertedAt: new Date() } })
      await this.prisma.executionRun.update({ where: { id: record.executionId }, data: { status: 'completed' } })
    }
    this.events.publish('run', result.ok ? 'undone' : 'undo_failed', { executionId: record.executionId, message: result.message }, record.executionId)
    return result
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async detail(executionId: string) {
    const run = await this.prisma.executionRun.findUniqueOrThrow({
      where: { id: executionId },
      include: {
        task: { include: { subtasks: { orderBy: [{ createdAt: 'asc' }, { priority: 'desc' }] }, plans: { orderBy: { createdAt: 'desc' }, take: 1 } } },
        agentRuns: { orderBy: { createdAt: 'asc' } },
        modelCalls: { orderBy: { createdAt: 'asc' } },
        applyRecords: { orderBy: { createdAt: 'desc' } },
      },
    })
    return { ...run, active: this.runners.has(executionId), paused: run.status === 'paused', usage: this.usageSummary(run.modelCalls, await this.settings.get()) }
  }

  /** Run events in order, page by page: `after` + `afterId` continue exactly behind the last event seen. */
  async events_(executionId: string, after?: string, limit = 500, afterId?: string) {
    const cursor = after ? (afterId ? { OR: [{ createdAt: { gt: new Date(after) } }, { createdAt: new Date(after), id: { gt: afterId } }] } : { createdAt: { gt: new Date(after) } }) : {}
    return this.prisma.runEvent.findMany({ where: { executionId, ...cursor }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: Math.min(Math.max(limit, 1), 2000) })
  }

  async listForProject(projectId: string) {
    return this.prisma.executionRun.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 50, include: { task: { select: { id: true, userPrompt: true } } } })
  }

  /**
   * Model suitability from past attempts (up to 5000 rows). Planning and the run start both need it
   * within seconds, so the aggregate is shared for a short time.
   */
  async suitability(): Promise<SuitabilityStats[]> {
    const cached = this.suitabilityCache
    if (cached && Date.now() - cached.at < 30_000) return cached.value
    const value = this.loadSuitability()
    this.suitabilityCache = { at: Date.now(), value }
    value.catch(() => {
      if (this.suitabilityCache?.value === value) this.suitabilityCache = undefined
    })
    return value
  }

  private suitabilityCache?: { at: number; value: Promise<SuitabilityStats[]> }

  private async loadSuitability(): Promise<SuitabilityStats[]> {
    const runs = await this.prisma.agentRun.findMany({
      where: { outcome: { not: null }, selectedModelClass: 'local_llm', NOT: { outcome: 'cancelled' } },
      select: { selectedModelName: true, category: true, outcome: true, repairRound: true, durationMs: true, escalated: true },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    })
    const records: AttemptRecord[] = runs
      .filter((run) => run.selectedModelName && run.category)
      .map((run) => ({
        model: run.selectedModelName!,
        category: run.category!,
        outcome: (['success', 'validation_failed', 'invalid_patch', 'no_changes', 'error', 'timeout'].includes(run.outcome!) ? run.outcome : 'error') as AttemptRecord['outcome'],
        repairRound: run.repairRound,
        durationMs: run.durationMs ?? 0,
        escalated: run.escalated,
      }))
    return aggregateSuitability(records)
  }

  async usage(filter: { executionId?: string; since?: Date } = {}) {
    const calls = await this.prisma.modelCall.findMany({ where: { ...(filter.executionId ? { executionId: filter.executionId } : {}), ...(filter.since ? { createdAt: { gte: filter.since } } : {}) } })
    const settings = await this.settings.get()
    const statuses = await this.orchestrators.overview().catch(() => undefined)
    return { ...this.usageSummary(calls, settings), subscription: statuses?.orchestrators.map((entry) => ({ id: entry.id, rateLimit: entry.status.rateLimit, authMethod: entry.status.authMethod })) }
  }

  private usageSummary(calls: Array<{ kind: string; provider: string; model: string; purpose: string; status: string; durationMs: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; tokensMeasured: boolean; actualApiCostUsd: Prisma.Decimal | null; apiEquivalentUsd: Prisma.Decimal | null; billing: string; peakMemoryMb: number | null }>, settings: Awaited<ReturnType<SettingsService['get']>>) {
    const usage: UsageCall[] = calls.map((call) => ({
      kind: call.kind === 'local' ? 'local' : 'orchestrator',
      provider: call.provider,
      model: call.model,
      purpose: call.purpose,
      status: call.status,
      durationMs: call.durationMs,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cachedInputTokens: call.cachedInputTokens,
      tokensMeasured: call.tokensMeasured,
      actualApiCostUsd: call.actualApiCostUsd === null ? null : Number(call.actualApiCostUsd),
      apiEquivalentUsd: call.apiEquivalentUsd === null ? null : Number(call.apiEquivalentUsd),
      billing: call.billing,
      peakMemoryMb: call.peakMemoryMb,
    }))
    const summary = summarizeUsage(usage, { priceOverride: settings.premiumPriceOverride ?? undefined, gpuWatts: settings.gpuWatts ?? undefined })
    return { ...summary, premium: { ...summary.premium, byProvider: premiumByProvider(usage) } }
  }

  private async chat(taskId: string, role: 'assistant' | 'agent' | 'system', content: string, metadata: Record<string, unknown>) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } })
    if (!task) return
    const message = await this.prisma.chatMessage.create({ data: { taskId, projectId: task.projectId, sessionId: task.sessionId, role, content, metadata: asJson(metadata) } })
    this.events.publish('project', 'chat_message', { taskId, sessionId: task.sessionId, messageId: message.id, role, projectId: task.projectId }, task.projectId)
  }
}
