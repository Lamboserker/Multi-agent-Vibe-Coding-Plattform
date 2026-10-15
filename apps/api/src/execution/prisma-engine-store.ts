import { Prisma, type ModelClass } from '@prisma/client'
import type { AttemptFinish, AttemptStart, EngineEvent, EngineStore, ModelCallRecord, RunPersistPatch, TaskPersistPatch } from '@multi-ai-coder/engine'
import { asJson } from '../common/json.js'
import type { PrismaService } from '../common/prisma.service.js'
import type { EventBusService } from '../runtime/event-bus.service.js'

/** Event types that are only streamed live (too chatty to persist). */
const EPHEMERAL_EVENTS = new Set(['check_output'])

/** EngineStore implementation on Prisma/SQLite; every write is also published on the event bus. */
export class PrismaEngineStore implements EngineStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBusService,
    private readonly executionId: string,
    private readonly taskId: string,
  ) {}

  async updateRun(_runId: string, patch: RunPersistPatch) {
    const data: Prisma.ExecutionRunUpdateInput = {}
    if (patch.status) data.status = patch.status
    if (patch.baseCommit !== undefined) data.baseCommit = patch.baseCommit
    if (patch.baseBranch !== undefined) data.baseBranch = patch.baseBranch
    if (patch.integrationBranch !== undefined) data.integrationBranch = patch.integrationBranch || null
    if (patch.integrationWorktree !== undefined) data.integrationWorktree = patch.integrationWorktree || null
    if (patch.integrationCommit !== undefined) data.integrationCommit = patch.integrationCommit
    if (patch.finalDiff !== undefined) data.finalDiff = patch.finalDiff
    if (patch.finalValidation !== undefined) data.finalValidation = asJson(patch.finalValidation)
    if (patch.review !== undefined) data.review = asJson(patch.review)
    if (patch.summary !== undefined) data.summary = patch.summary
    if (patch.errorMessage !== undefined) data.errorMessage = patch.errorMessage
    if (patch.finishedAt !== undefined) data.finishedAt = patch.finishedAt
    await this.prisma.executionRun.update({ where: { id: this.executionId }, data })
    this.bus.publish('run', 'run_updated', { executionId: this.executionId, status: patch.status }, this.executionId)
  }

  async updateTask(taskId: string, patch: TaskPersistPatch) {
    if (!taskId) return // synthetic tasks (review fix) are not persisted as subtasks
    const data: Prisma.SubtaskUpdateInput = {}
    if (patch.status) data.status = patch.status
    if (patch.dependsOn) data.dependsOn = asJson(patch.dependsOn)
    if (patch.selectedModelClass) data.selectedModelClass = patch.selectedModelClass as ModelClass
    if (patch.selectedModelName !== undefined) data.selectedModelName = patch.selectedModelName
    if (patch.modelReason !== undefined) data.modelReason = patch.modelReason
    if (patch.attempts !== undefined) data.attempts = patch.attempts
    if (patch.worktreePath !== undefined) data.worktreePath = patch.worktreePath
    if (patch.branchName !== undefined) data.branchName = patch.branchName
    if (patch.commitSha !== undefined) data.commitSha = patch.commitSha
    if (patch.patchText !== undefined) data.patchText = patch.patchText
    if (patch.patchStats !== undefined) data.patchStats = asJson(patch.patchStats)
    if (patch.validation !== undefined) data.validation = asJson(patch.validation)
    if (patch.errorMessage !== undefined) data.errorMessage = patch.errorMessage
    if (patch.startedAt !== undefined) data.startedAt = patch.startedAt
    if (patch.finishedAt !== undefined) data.finishedAt = patch.finishedAt
    await this.prisma.subtask.update({ where: { id: taskId }, data })
    this.bus.publish('run', 'task_updated', { executionId: this.executionId, subtaskId: taskId, status: patch.status }, this.executionId)
  }

  async startAttempt(input: AttemptStart) {
    const run = await this.prisma.agentRun.create({
      data: {
        taskId: this.taskId,
        subtaskId: input.taskId || null,
        executionId: this.executionId,
        agentName: input.executor === 'premium' ? 'PremiumAgent' : input.executor === 'deterministic' ? 'DeterministicTool' : 'LocalCoderAgent',
        selectedModelClass: input.executor === 'premium' ? 'premium_llm' : input.executor === 'deterministic' ? 'no_llm' : 'local_llm',
        selectedModelName: input.model,
        runtime: input.executor === 'local' ? 'ollama' : input.model,
        category: input.category,
        repairRound: input.repairRound,
        status: 'running',
        startedAt: new Date(),
        currentStep: input.repairRound ? `repair_${input.repairRound}` : 'executing',
        promptSummary: input.promptSummary,
      },
    })
    this.bus.publish('run', 'attempt_started', { executionId: this.executionId, attemptId: run.id, subtaskId: input.taskId, model: input.model, executor: input.executor, repairRound: input.repairRound }, this.executionId)
    return run.id
  }

  async finishAttempt(attemptId: string, input: AttemptFinish) {
    const validationStatus = input.validation ? (input.validation.ok ? 'passed' : 'failed') : input.outcome === 'invalid_patch' ? 'failed' : 'not_run'
    await this.prisma.agentRun.update({
      where: { id: attemptId },
      data: {
        outcome: input.outcome,
        status: input.status,
        escalated: input.escalated,
        finishedAt: new Date(),
        durationMs: input.durationMs,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        inputTokenEstimate: input.inputTokens ?? 0,
        outputTokenEstimate: input.outputTokens ?? 0,
        tokensMeasured: input.tokensMeasured,
        patchText: input.patchText,
        patchStatus: input.patchStatus,
        diffSummary: input.diffSummary,
        validationStatus,
        validationResults: asJson(input.validation?.results ?? []),
        logs: asJson(input.logs.slice(-400)),
        errorMessage: input.errorMessage?.slice(0, 8000),
        currentStep: input.outcome,
        score: input.outcome === 'success' ? 100 : 0,
        actualCostEuro: new Prisma.Decimal(0),
      },
    })
    this.bus.publish('run', 'attempt_finished', { executionId: this.executionId, attemptId, outcome: input.outcome }, this.executionId)
  }

  async recordModelCall(call: ModelCallRecord) {
    await this.prisma.modelCall.create({
      data: {
        executionId: this.executionId,
        subtaskId: call.taskId || null,
        kind: call.kind,
        provider: call.provider,
        model: call.model,
        purpose: call.purpose,
        status: call.status,
        errorClass: call.errorClass,
        sessionId: call.sessionId,
        durationMs: call.durationMs,
        inputTokens: call.usage.inputTokens,
        outputTokens: call.usage.outputTokens,
        cachedInputTokens: call.usage.cachedInputTokens,
        tokensMeasured: call.usage.measured,
        apiEquivalentUsd: call.usage.apiEquivalentUsd === undefined ? undefined : new Prisma.Decimal(call.usage.apiEquivalentUsd),
        actualApiCostUsd: call.usage.billing === 'api_key' && call.usage.apiEquivalentUsd !== undefined ? new Prisma.Decimal(call.usage.apiEquivalentUsd) : undefined,
        billing: call.usage.billing,
        peakMemoryMb: call.peakMemoryMb,
      },
    })
    this.bus.publish('run', 'model_call', { executionId: this.executionId, kind: call.kind, model: call.model, purpose: call.purpose, inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens }, this.executionId)
  }

  emit(event: EngineEvent) {
    this.bus.publish('run', event.type, { executionId: this.executionId, subtaskId: event.taskId, level: event.level, message: event.message, ...(event.data ?? {}) }, this.executionId)
    if (EPHEMERAL_EVENTS.has(event.type)) return
    void this.prisma.runEvent
      .create({
        data: {
          executionId: this.executionId,
          subtaskId: event.taskId || null,
          level: event.level,
          type: event.type,
          message: event.message.slice(0, 8000),
          data: asJson(event.data ?? {}),
        },
      })
      .catch(() => undefined)
  }
}
