import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common'
import { Prisma, type ExecutionRun, type Subtask } from '@prisma/client'
import {
  aggregateSuitability,
  applyChangeSet,
  deterministicPlan,
  ExecutionRunner,
  isGitRepository,
  OrchestratorError,
  revertChangeSet,
  routeTask,
  summarizeUsage,
  WorktreeManager,
  isSecurityCriticalPath,
  type ApplyMode,
  type AttemptRecord,
  type EngineTask,
  type ExecutionPlan,
  type OrchestratorAdapter,
  type SuitabilityStats,
  type UsageCall,
} from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { asJson, stringList } from '../common/json.js'
import { KeyedMutex } from '../common/locks.js'
import { LocalModelsService } from '../local-models/local-models.service.js'
import { OrchestratorService } from '../orchestration/orchestrator.service.js'
import { EventBusService } from '../runtime/event-bus.service.js'
import { JobQueueService } from '../runtime/job-queue.service.js'
import { runtimeConfig } from '../runtime/runtime-config.js'
import { SettingsService } from '../runtime/settings.service.js'
import { PrismaEngineStore } from './prisma-engine-store.js'
import { RepoContextService } from './repo-context.service.js'

const ACTIVE_STATUSES = ['pending', 'planning', 'running', 'paused', 'integrating'] as const

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
  ) {}

  onModuleInit() {
    this.jobs.register('execution.run', (payload, ctx) => this.runJob(String(payload.executionId), ctx.signal), { concurrency: 2, onRecover: 'interrupt' })
    this.jobs.register('execution.plan', (payload) => this.planJob(String(payload.taskId), payload.feedback ? String(payload.feedback) : undefined, payload.autoStart === true), { concurrency: 2, onRecover: 'interrupt' })
  }

  worktrees() {
    return new WorktreeManager({ root: runtimeConfig().worktreesDir })
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

  async requestPlan(taskId: string, feedback?: string, autoStart = false) {
    await this.prisma.task.update({ where: { id: taskId }, data: { currentStep: 'planning', status: 'running' } })
    const job = await this.jobs.enqueue('execution.plan', { taskId, feedback, autoStart }, { dedupeKey: `plan:${taskId}` })
    this.events.publish('run', 'plan_requested', { taskId, jobId: job.id })
    return { jobId: job.id }
  }

  private async planJob(taskId: string, feedback?: string, autoStart = false) {
    try {
      await this.plan(taskId, feedback, autoStart)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.prisma.task.update({ where: { id: taskId }, data: { currentStep: 'plan_failed', status: 'failed' } })
      await this.chat(taskId, 'system', `Planung fehlgeschlagen: ${message}`, { kind: 'plan_error' })
      throw error
    }
  }

  /**
   * Plans a task with the premium orchestrator (one structured call over a compact, deterministic
   * repository digest). Without an orchestrator the deterministic single-task fallback is used and
   * labelled as such.
   */
  async plan(taskId: string, feedback?: string, autoStart = false) {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: { project: true } })
    const settings = await this.settings.get()
    const { index, checks, digest } = await this.repoContext.digest(task.projectId, task.project.repoPath, task.userPrompt)
    const profiles = await this.localModels.engineProfiles()
    const orchestrator = await this.orchestrators.active()
    this.events.publish('run', 'planning_started', { taskId, orchestrator: orchestrator?.id ?? null, contextTokens: digest.tokenEstimate })

    let plan: ExecutionPlan
    let source: string
    const warnings: string[] = []
    if (orchestrator) {
      const started = Date.now()
      try {
        const { result, meta } = await orchestrator.createPlan(
          {
            goal: task.userPrompt,
            context: digest,
            costMode: settings.costMode,
            localModels: profiles.map((profile) => ({ role: profile.roles.join('/'), model: profile.model, toolCalling: profile.toolCalling, strengths: [] })),
            maxTasks: settings.maxTasks,
            feedback,
          },
          { runId: `plan-${taskId}`, cwd: task.project.repoPath, timeoutMs: 10 * 60_000, effort: settings.costMode === 'quality' ? 'high' : 'medium' },
        )
        plan = result
        source = orchestrator.id
        await this.recordPlanCall(orchestrator, 'ok', Date.now() - started, meta)
      } catch (error) {
        const kind = error instanceof OrchestratorError ? error.kind : 'process_failed'
        await this.recordPlanCall(orchestrator, 'error', Date.now() - started, undefined, kind)
        if (kind === 'cancelled') throw error
        warnings.push(`${orchestrator.displayName} planning failed (${kind}): ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`)
        plan = deterministicPlan(task.userPrompt, index)
        source = 'deterministic-fallback'
      }
    } else {
      warnings.push(settings.orchestrator ? `${settings.orchestrator} is not connected; using the deterministic fallback planner.` : 'No orchestrator selected; using the deterministic fallback planner.')
      plan = deterministicPlan(task.userPrompt, index)
      source = 'deterministic-fallback'
    }

    // Replace previous (not yet executed) plan.
    await this.prisma.subtask.deleteMany({ where: { taskId } })
    const created: Subtask[] = []
    for (const [position, planned] of plan.tasks.entries()) {
      const securityCritical = [...planned.relevantFiles, ...planned.newFiles].some(isSecurityCriticalPath)
      created.push(
        await this.prisma.subtask.create({
          data: {
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
            modelReason: planned.rationale,
          },
        }),
      )
    }
    const routing = await this.previewRouting(taskId)
    const taskPlan = await this.prisma.taskPlan.create({
      data: {
        taskId,
        summary: plan.summary,
        classification: asJson(plan.analysis),
        modelAssignments: asJson(routing.assignments),
        requiresApproval: settings.planApproval,
        nextAction: settings.planApproval && !autoStart ? 'await_plan_approval' : 'auto_execute',
        source,
        dag: asJson({ tasks: plan.tasks.map((planned) => ({ id: planned.id, dependsOn: planned.dependsOn })), warnings: [...warnings, ...plan.warnings], contextTokens: digest.tokenEstimate, consideredFiles: digest.consideredFiles }),
      },
    })
    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'planned',
        currentStep: settings.planApproval ? 'awaiting_plan_approval' : 'planned',
        normalizedGoal: plan.summary || task.userPrompt.slice(0, 500),
        complexity: (['trivial', 'small', 'medium', 'complex', 'critical'] as const)[plan.analysis.complexity - 1],
        riskLevel: (['low', 'low', 'medium', 'high', 'critical'] as const)[plan.analysis.risk - 1],
        securitySensitive: plan.analysis.securitySensitive,
      },
    })
    await this.chat(taskId, 'assistant', this.planMessage(plan, source, routing.assignments, warnings, settings.planApproval), { kind: 'task_plan', taskPlanId: taskPlan.id, source })
    this.events.publish('run', 'planned', { taskId, tasks: created.length, source })

    if (autoStart || !settings.planApproval) await this.start(taskId)
    return { taskPlan, subtasks: created, routing, warnings, source }
  }

  private async recordPlanCall(orchestrator: OrchestratorAdapter, status: 'ok' | 'error', durationMs: number, meta?: { model?: string; sessionId?: string; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; measured: boolean; apiEquivalentUsd?: number; billing: string } }, errorClass?: string) {
    await this.prisma.modelCall.create({
      data: {
        kind: 'orchestrator',
        provider: orchestrator.id,
        model: meta?.model ?? orchestrator.id,
        purpose: 'plan',
        status,
        errorClass,
        sessionId: meta?.sessionId,
        durationMs,
        inputTokens: meta?.usage.inputTokens ?? 0,
        outputTokens: meta?.usage.outputTokens ?? 0,
        cachedInputTokens: meta?.usage.cachedInputTokens ?? 0,
        tokensMeasured: meta?.usage.measured ?? false,
        apiEquivalentUsd: meta?.usage.apiEquivalentUsd === undefined ? undefined : new Prisma.Decimal(meta.usage.apiEquivalentUsd),
        billing: meta?.usage.billing ?? 'unknown',
      },
    })
  }

  private planMessage(plan: ExecutionPlan, source: string, assignments: Array<{ key: string; executor: string; model?: string }>, warnings: string[], needsApproval: boolean) {
    const lines = plan.tasks.map((task) => {
      const assignment = assignments.find((entry) => entry.key === task.id)
      const target = assignment?.executor === 'premium' ? 'Premium' : assignment?.model ?? 'nicht zugewiesen'
      return `- **${task.id}** ${task.title} — Komplexität ${task.complexity}/5, Risiko ${task.risk}/5 → ${target}${task.dependsOn.length ? ` (nach ${task.dependsOn.join(', ')})` : ''}`
    })
    return [
      source === 'deterministic-fallback' ? '**Fallback-Plan (ohne Orchestrator)**' : `**Plan von ${source === 'claude-code' ? 'Claude Code' : 'Codex'}**`,
      plan.summary,
      '',
      ...lines,
      ...(warnings.length || plan.warnings.length ? ['', ...[...warnings, ...plan.warnings].map((warning) => `⚠ ${warning}`)] : []),
      '',
      needsApproval ? 'Prüfe Zuordnungen und starte die Ausführung, wenn der Plan passt.' : 'Die Ausführung startet automatisch.',
    ].join('\n')
  }

  private async engineTasks(taskId: string): Promise<EngineTask[]> {
    const subtasks = await this.prisma.subtask.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } })
    return subtasks.map((subtask) => ({
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
      manualModel: subtask.manualModel ?? undefined,
      status: subtask.status === 'completed' ? 'completed' : 'planned',
      commitSha: subtask.commitSha ?? undefined,
    }))
  }

  /** Routing preview ("Modellzuordnungen prüfen"); persisted on the subtasks. */
  async previewRouting(taskId: string) {
    const [tasks, profiles, stats, orchestrator, settings] = await Promise.all([this.engineTasks(taskId), this.localModels.engineProfiles(), this.suitability(), this.orchestrators.active(), this.settings.get()])
    const assignments = []
    for (const task of tasks) {
      const decision = routeTask(
        { id: task.key, category: task.category, complexity: task.complexity, risk: task.risk, expectedInputTokens: task.expectedInputTokens, suggestedExecutor: task.suggestedExecutor, securityCritical: [...task.relevantFiles, ...task.newFiles].some(isSecurityCriticalPath), manualModel: task.manualModel },
        profiles,
        { costMode: settings.costMode, premiumAvailable: Boolean(orchestrator), premiumExecutionAllowed: settings.premiumExecutionAllowed },
        stats,
      )
      await this.prisma.subtask.update({
        where: { id: task.id },
        data: {
          selectedModelClass: decision.executor === 'premium' ? 'premium_llm' : decision.executor === 'local' ? 'local_llm' : 'no_llm',
          selectedModelName: decision.executor === 'premium' ? orchestrator?.displayName ?? 'premium' : decision.model ?? null,
          modelReason: decision.reasons.join('\n'),
          skippedModels: asJson(decision.escalation.map((step) => (step.executor === 'premium' ? 'premium' : step.model))),
        },
      })
      assignments.push({ key: task.key, subtaskId: task.id, executor: decision.executor, model: decision.model, tier: decision.tier, reasons: decision.reasons, escalation: decision.escalation, requiresApproval: decision.requiresApproval })
    }
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
    if (!task.subtasks.length) throw new BadRequestException('The task has no plan yet.')
    if (!(await isGitRepository(task.project.repoPath))) throw new BadRequestException('The project is not a git repository. Initialise git and create a first commit to enable isolated execution.')
    const active = await this.prisma.executionRun.findFirst({ where: { taskId, status: { in: [...ACTIVE_STATUSES] } } })
    if (active) return active
    const settings = await this.settings.get()
    const orchestrator = await this.orchestrators.active()
    // A fresh run gets a fresh integration branch, so every task runs again (resume keeps completed ones).
    await this.prisma.subtask.updateMany({ where: { taskId }, data: { status: 'queued', errorMessage: null, attempts: 0, commitSha: null } })
    const execution = await this.prisma.executionRun.create({
      data: {
        taskId,
        projectId: task.projectId,
        status: 'pending',
        orchestrator: orchestrator?.id ?? null,
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
    const [tasks, profiles, stats, orchestrator, localSlots, ollama] = await Promise.all([
      this.engineTasks(execution.taskId),
      this.localModels.engineProfiles(),
      this.suitability(),
      this.orchestrators.active(),
      this.localModels.localSlots(),
      this.localModels.client(),
    ])
    const { index, checks } = await this.repoContext.digest(project.id, project.repoPath, execution.task.userPrompt, 500)
    const store = new PrismaEngineStore(this.prisma, this.events, executionId, execution.taskId)
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
        },
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
    if (!safe) {
      this.events.publish('run', 'auto_apply_skipped', { executionId: run.id, reason: 'Validation, review or security checks require manual approval.' }, run.id)
      return
    }
    const result = await this.approve(run.id, settings.approvalMode === 'auto_working_tree' ? 'working_tree' : 'branch')
    this.events.publish('run', result.ok ? 'auto_applied' : 'auto_apply_skipped', { executionId: run.id, message: result.message }, run.id)
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
    if (!['branch', 'working_tree', 'fast_forward'].includes(mode)) throw new BadRequestException('Unknown apply mode.')
    const run = await this.prisma.executionRun.findUniqueOrThrow({ where: { id: executionId }, include: { project: true } })
    if (run.status !== 'awaiting_approval') throw new BadRequestException(`Run is ${run.status}, not awaiting approval.`)
    if (!run.integrationWorktree || !run.integrationBranch || !run.baseCommit) throw new BadRequestException('Run has no integration result.')
    const outcome = await applyChangeSet({ repoPath: run.project.repoPath, integrationWorktree: run.integrationWorktree, integrationBranch: run.integrationBranch, baseCommit: run.baseCommit, mode })
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
        task: { include: { subtasks: { orderBy: { createdAt: 'asc' } }, plans: { orderBy: { createdAt: 'desc' }, take: 1 } } },
        agentRuns: { orderBy: { createdAt: 'asc' } },
        modelCalls: { orderBy: { createdAt: 'asc' } },
        applyRecords: { orderBy: { createdAt: 'desc' } },
      },
    })
    return { ...run, active: this.runners.has(executionId), paused: run.status === 'paused', usage: this.usageSummary(run.modelCalls, await this.settings.get()) }
  }

  async events_(executionId: string, after?: string, limit = 500) {
    return this.prisma.runEvent.findMany({ where: { executionId, ...(after ? { createdAt: { gt: new Date(after) } } : {}) }, orderBy: { createdAt: 'asc' }, take: limit })
  }

  async listForProject(projectId: string) {
    return this.prisma.executionRun.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 50, include: { task: { select: { id: true, userPrompt: true } } } })
  }

  async suitability(): Promise<SuitabilityStats[]> {
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
    return summarizeUsage(usage, { priceOverride: settings.premiumPriceOverride ?? undefined, gpuWatts: settings.gpuWatts ?? undefined })
  }

  private async chat(taskId: string, role: 'assistant' | 'agent' | 'system', content: string, metadata: Record<string, unknown>) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } })
    if (!task) return
    const message = await this.prisma.chatMessage.create({ data: { taskId, projectId: task.projectId, sessionId: task.sessionId, role, content, metadata: asJson(metadata) } })
    this.events.publish('project', 'chat_message', { taskId, sessionId: task.sessionId, messageId: message.id, role, projectId: task.projectId }, task.projectId)
  }
}
