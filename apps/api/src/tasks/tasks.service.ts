import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { CostMode, ModelClass } from '@multi-ai-coder/shared'
import { PrismaService } from '../common/prisma.service.js'
import { RepoScannerService } from '../orchestrator/repo-scanner.service.js'
import { TaskAnalyzerService } from '../orchestrator/task-analyzer.service.js'
import { ContextBuilderService } from '../orchestrator/context-builder.service.js'
import { CostRouterService } from '../orchestrator/cost-router.service.js'
import { ValidationService } from '../validation/validation.service.js'
import { ExecutionService } from '../execution/execution.service.js'
import { SettingsService } from '../runtime/settings.service.js'
import { titleFrom } from '../sessions/session-model.js'

interface TaskOptions {
  costMode?: CostMode
  allowedModelClasses?: ModelClass[]
  premiumAllowed?: boolean
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repoScanner: RepoScannerService,
    private readonly taskAnalyzer: TaskAnalyzerService,
    private readonly contextBuilder: ContextBuilderService,
    private readonly costRouter: CostRouterService,
    private readonly validation: ValidationService,
    private readonly executions: ExecutionService,
    private readonly settings: SettingsService,
  ) {}

  async create(body: { projectId: string; userPrompt: string; maxCostEuro?: number; mode?: CostMode; premiumAllowed?: boolean; designMode?: 'auto' | 'force' | 'skip' }) {
    if (!body?.projectId || !body.userPrompt?.trim()) throw new BadRequestException('projectId and userPrompt are required.')
    if (body.designMode !== undefined && !['auto', 'force', 'skip'].includes(body.designMode)) throw new BadRequestException('designMode must be one of auto, force, skip.')
    const settings = await this.settings.get()
    // Every task belongs to a session, so it shows up in the session list of the desktop app.
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.chatSession.create({ data: { projectId: body.projectId, title: titleFrom(body.userPrompt), status: 'active' } })
      const task = await tx.task.create({
        data: {
          projectId: body.projectId,
          sessionId: session.id,
          userPrompt: body.userPrompt.trim(),
          maxCostEuro: body.maxCostEuro === undefined ? undefined : new Prisma.Decimal(body.maxCostEuro),
          mode: body.mode ?? settings.costMode,
          premiumAllowed: body.premiumAllowed ?? settings.premiumExecutionAllowed,
          currentStep: 'draft',
          designMode: body.designMode ?? 'auto',
        },
      })
      await tx.chatSession.update({ where: { id: session.id }, data: { activeTaskId: task.id } })
      return task
    })
  }

  async findAll(projectId?: string) {
    return this.prisma.task.findMany({
      where: projectId ? { projectId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        project: true,
        subtasks: { orderBy: [{ createdAt: 'asc' }, { priority: 'desc' }] },
        executions: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
  }

  async findOne(id: string) {
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id },
      include: {
        project: true,
        contexts: { orderBy: { createdAt: 'desc' }, take: 3 },
        subtasks: { orderBy: [{ createdAt: 'asc' }, { priority: 'desc' }] },
        runs: { orderBy: { createdAt: 'desc' }, take: 100, include: { provider: true, reviews: true } },
        feedback: { orderBy: { createdAt: 'desc' }, take: 10 },
        chatMessages: { orderBy: { createdAt: 'asc' }, take: 200 },
        plans: { orderBy: { createdAt: 'desc' }, take: 5 },
        executions: { orderBy: { createdAt: 'desc' }, take: 5, include: { applyRecords: { orderBy: { createdAt: 'desc' } } } },
      },
    })
    return task.currentStep === 'planning' ? { ...task, planning: await this.executions.planningStatus(id) } : task
  }

  /** Deterministic pre-analysis (no model call): classification, legacy routing hint and context snapshot. */
  async analyze(id: string, options: TaskOptions = {}) {
    await this.prisma.task.update({ where: { id }, data: { currentStep: 'analyzing', mode: options.costMode, premiumAllowed: options.premiumAllowed } })
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id }, include: { project: true } })
    const scan = await this.repoScanner.scan(task.project.repoPath)
    await this.prisma.project.update({
      where: { id: task.projectId },
      data: { techStack: scan as unknown as Prisma.InputJsonValue, packageManager: scan.packageManager, defaultBranch: scan.defaultBranch ?? task.project.defaultBranch },
    })
    const classification = this.taskAnalyzer.analyze(task.userPrompt, scan)
    const validationPlan = this.validation.planFromScan(scan)
    const routing = await this.costRouter.route(id, classification, {
      costMode: options.costMode,
      allowedModelClasses: options.allowedModelClasses,
      premiumAllowed: options.premiumAllowed,
      maxCostEuro: task.maxCostEuro ? Number(task.maxCostEuro) : undefined,
      validationAvailable: validationPlan.commands.length > 0,
    })
    const context = await this.contextBuilder.build({ taskId: id, projectId: task.projectId, repoPath: task.project.repoPath, userPrompt: task.userPrompt, scan })
    const updatedTask = await this.prisma.task.update({
      where: { id },
      data: {
        normalizedGoal: classification.normalizedGoal,
        status: 'analyzed',
        currentStep: 'analyzed',
        mode: options.costMode ?? task.mode,
        premiumAllowed: options.premiumAllowed ?? task.premiumAllowed,
        complexity: classification.complexity,
        taskType: classification.taskType,
        riskLevel: classification.riskLevel,
        contextNeed: classification.contextNeed,
        securitySensitive: classification.securitySensitive,
        estimatedCostTier: classification.estimatedCostTier,
      },
    })
    return { task: updatedTask, classification, routing, context, validation: validationPlan }
  }

  /** Plans with the premium orchestrator (or the labelled deterministic fallback). */
  async plan(id: string, options: TaskOptions = {}) {
    if (options.costMode) await this.settings.update({ costMode: options.costMode })
    return this.executions.plan(id)
  }

  async assignModels(id: string, options: TaskOptions = {}) {
    if (options.costMode) await this.settings.update({ costMode: options.costMode })
    const subtasks = await this.prisma.subtask.count({ where: { taskId: id } })
    if (!subtasks) await this.executions.plan(id)
    const routing = await this.executions.previewRouting(id)
    return { taskId: id, ...routing, subtasks: await this.subtasks(id) }
  }

  /** Real execution in isolated worktrees (the former dry-run mode has been removed). */
  async run(id: string) {
    const subtasks = await this.prisma.subtask.count({ where: { taskId: id } })
    if (subtasks === 0) {
      const planned = await this.executions.plan(id)
      // the planner asked questions instead of planning: nothing to run yet
      if (planned.source === 'clarification') throw new BadRequestException('Der Orchestrator hat Rückfragen – bitte beantworten und neu planen.')
    }
    return this.executions.start(id)
  }

  async stop(id: string) {
    const execution = await this.latestExecution(id)
    if (execution) await this.executions.cancel(execution.id)
    return this.prisma.task.update({ where: { id }, data: { currentStep: 'stopped' } })
  }

  async retry(id: string) {
    const execution = await this.latestExecution(id)
    if (execution && ['failed', 'interrupted'].includes(execution.status) && execution.integrationBranch) return this.executions.resume(execution.id)
    return this.executions.start(id)
  }

  /** Without a mode the result goes where the approval mode says (default: committed onto the main branch). */
  async apply(id: string, mode?: 'working_tree' | 'branch' | 'fast_forward' | 'commit') {
    const execution = await this.latestExecution(id)
    if (!execution || execution.status !== 'awaiting_approval') return { ok: false, status: 'nothing_to_apply', message: 'No validated change set is waiting for approval.' }
    const approvalMode = (await this.settings.get()).approvalMode
    return this.executions.approve(execution.id, mode ?? (approvalMode === 'auto_commit' ? 'commit' : approvalMode === 'auto_branch' ? 'branch' : 'working_tree'))
  }

  async discard(id: string) {
    const execution = await this.latestExecution(id)
    if (!execution) return { ok: true, discardedRuns: 0 }
    await this.executions.discard(execution.id)
    return { ok: true, discardedRuns: 1 }
  }

  async feedback(id: string, body: { runId?: string; userFeedback: string; requestedAction?: string }) {
    const feedback = await this.prisma.runFeedback.create({ data: { taskId: id, runId: body.runId, userFeedback: body.userFeedback, requestedAction: body.requestedAction } })
    await this.prisma.task.update({ where: { id }, data: { currentStep: 'waiting_for_user' } })
    if (body.requestedAction === 'replan') await this.executions.requestPlan(id, body.userFeedback)
    return feedback
  }

  async review(id: string) {
    const execution = await this.latestExecution(id)
    return execution ? { executionId: execution.id, review: execution.review, finalValidation: execution.finalValidation } : { review: null }
  }

  async runs(id: string) {
    return this.prisma.agentRun.findMany({ where: { taskId: id }, orderBy: { createdAt: 'desc' }, include: { provider: true, reviews: true, subtask: true } })
  }

  async subtasks(id: string) {
    return this.prisma.subtask.findMany({ where: { taskId: id }, orderBy: [{ createdAt: 'asc' }, { priority: 'desc' }] })
  }

  private latestExecution(taskId: string) {
    return this.prisma.executionRun.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' } })
  }
}
