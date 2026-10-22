import path from 'node:path'
import { requiredToolNames, runLocalAgent, type AgentTool, type LocalAgentResult } from '../agents/local-agent.js'
import { applyPatch, commitStaged, DEPENDENCY_DIR_EXCLUDES, git, hasStagedChanges, headCommit, integratedTaskCommits, squashSince, stageAll } from '../git/git.js'
import { WorktreeManager, type WorktreeHandle } from '../git/worktrees.js'
import { buildContextDigest, searchCode, type RepoIndex } from '../index/repo-index.js'
import { cherryPick } from '../git/git.js'
import { Mutex } from '../integration/integrator.js'
import { OllamaClient } from '../ollama/client.js'
import { chooseExecutionPrompt, renderContext, renderRepairHint } from '../orchestrator/prompts.js'
import { isDuo, type DuoOrchestrator } from '../orchestrator/duo.js'
import { CHOOSE_SCHEMA, normalizeChoice } from '../orchestrator/schemas.js'
import { bookableCalls, normalizeWithMeta, OrchestratorError, type CallContext, type CallMeta, type ExecutionInput, type OrchestratorAdapter, type OrchestratorEvent, type RepairHint, type ReviewResult, type UsageReport } from '../orchestrator/types.js'
import { DEFAULT_DENIED_PATTERNS, validatePatch, type PatchPolicy, type PatchValidationResult } from '../patch/validator.js'
import { WorkspaceFiles } from '../patch/workspace-files.js'
import { analyzeDag } from '../planning/dag.js'
import { FILE_SCOPED_CRITERION } from '../planning/fallback-planner.js'
import { routeTask, type CostMode, type LocalModelProfile, type RouteDecision } from '../routing/router.js'
import type { SuitabilityStats } from '../routing/stats.js'
import { DagScheduler, type SchedulableTask, type TaskState } from '../scheduler/scheduler.js'
import { isSecurityCriticalPath } from '../security/paths.js'
import { againstBaseline, baselineFailures, failureDigest, runValidationChecks, type RunChecksOptions, type ValidationCheck, type ValidationReport } from '../validation/checks.js'
import { runProcess, sanitizedEnv } from '../util/process.js'
import { runFastPathTool, type FastPathTool } from '../fastpath/fast-path.js'
import { normalizeDesign } from '../ui/design-normalize.js'

export type EngineTaskStatus = 'planned' | 'queued' | 'running' | 'validating' | 'repairing' | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'blocked'

export interface EngineTask {
  id: string
  key: string
  title: string
  description: string
  category: string
  complexity: number
  risk: number
  relevantFiles: string[]
  newFiles: string[]
  dependsOn: string[]
  acceptanceCriteria: string[]
  testStrategy?: string
  expectedInputTokens: number
  suggestedExecutor: 'local' | 'premium'
  priority: number
  manualModel?: string
  /** Fast path: a deterministic tool tried before any model (see fastpath/fast-path.ts). */
  tool?: FastPathTool
  /** Agent profile assigned to the task (agent manager): model, limits, escalation, role prompt. */
  agent?: AgentAssignment
  /** Skills pinned by the planner or named in the task; always given to the executing agent. */
  skills?: string[]
  status: EngineTaskStatus
  /** Commit on the integration branch once integrated. */
  commitSha?: string
}

export interface AgentAssignment {
  maxContextTokens?: number
  permissions?: { read?: boolean; write?: boolean; externalTools?: boolean }
  resources?: { timeoutMs?: number; maxFiles?: number; maxWriteBytes?: number; maxOutputTokens?: number }
  mcpServers?: string[]
  id: string
  name: string
  /** premium: normal escalation chain; local: never escalate to the premium orchestrator; none: no escalation at all. */
  escalation: 'premium' | 'local' | 'none'
  maxSteps?: number
  maxRepairs?: number
  /** Role-specific instructions appended to the local agent's system prompt. */
  instructions?: string
}

/** Compact result of a finished task, handed to the tasks that depend on it. */
export interface TaskHandoff {
  key: string
  title: string
  files: string[]
  summary: string
}

export interface EngineRun {
  id: string
  projectKey: string
  repoPath: string
  goal: string
  baseCommit?: string
  baseBranch?: string
  integrationBranch?: string
  integrationWorktree?: string
}

export interface EngineSettings {
  costMode: CostMode
  premiumExecutionAllowed: boolean
  premiumReviewPolicy: 'risk_based' | 'always' | 'never'
  maxLocalRepairs: number
  maxEscalationSteps: number
  localSlots: number
  premiumSlots: number
  allowProjectCode: boolean
  approvedCommands: string[]
  numCtx: number
  taskTimeoutMs: number
  strictScope: boolean
  reviewFixRounds: number
  /** Ollama keep_alive for agent calls, e.g. '15m'. */
  keepAlive?: string
  /** Auto uses one structured edit for small tasks with complete file context. */
  localExecutionMode?: 'auto' | 'tools'
  /**
   * "Premium advises, local executes": before full premium execution the orchestrator returns precise
   * repair edits for the failed local attempt and the strongest local model applies them. Default true.
   */
  premiumHints?: boolean
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  costMode: 'balanced',
  premiumExecutionAllowed: true,
  premiumReviewPolicy: 'risk_based',
  maxLocalRepairs: 2,
  maxEscalationSteps: 2,
  localSlots: 1,
  premiumSlots: 1,
  allowProjectCode: true,
  approvedCommands: [],
  numCtx: 16_384,
  taskTimeoutMs: 20 * 60_000,
  strictScope: false,
  reviewFixRounds: 1,
  premiumHints: true,
}

export type AttemptOutcome = 'success' | 'validation_failed' | 'invalid_patch' | 'no_changes' | 'error' | 'timeout' | 'cancelled' | 'conflict'

export interface AttemptStart {
  runId: string
  taskId: string
  executor: 'local' | 'premium' | 'deterministic'
  model: string
  category: string
  repairRound: number
  promptSummary: string
}

export interface AttemptFinish {
  outcome: AttemptOutcome
  status: 'completed' | 'failed' | 'cancelled'
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  tokensMeasured: boolean
  patchText?: string
  patchStatus: string
  diffSummary?: string
  validation?: ValidationReport
  logs: string[]
  errorMessage?: string
  escalated: boolean
}

export interface ModelCallRecord {
  runId: string
  taskId?: string
  kind: 'orchestrator' | 'local'
  provider: string
  model: string
  /** `duo_choose`: duo mode, the lead picks one of two premium executions whose checks tied. */
  purpose: 'plan' | 'review' | 'execute' | 'repair' | 'analyze' | 'chat' | 'review_fix' | 'repair_hint' | 'duo_choose'
  status: 'ok' | 'error'
  errorClass?: string
  sessionId?: string
  durationMs: number
  usage: UsageReport
  peakMemoryMb?: number
}

export interface EngineEvent {
  runId: string
  taskId?: string
  level: 'debug' | 'info' | 'warn' | 'error'
  type: string
  message: string
  data?: Record<string, unknown>
}

export interface RunPersistPatch {
  status?: 'running' | 'paused' | 'integrating' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'
  baseCommit?: string
  baseBranch?: string
  integrationBranch?: string
  integrationWorktree?: string
  integrationCommit?: string
  finalDiff?: string
  finalValidation?: unknown
  review?: unknown
  summary?: string
  errorMessage?: string | null
  finishedAt?: Date
}

export interface TaskPersistPatch {
  status?: EngineTaskStatus
  dependsOn?: string[]
  selectedModelClass?: 'local_llm' | 'premium_llm' | 'no_llm'
  selectedModelName?: string
  modelReason?: string
  attempts?: number
  worktreePath?: string | null
  branchName?: string | null
  commitSha?: string
  patchText?: string
  patchStats?: unknown
  validation?: unknown
  errorMessage?: string | null
  startedAt?: Date
  finishedAt?: Date
}

/** Persistence and event sink, implemented by the backend (Prisma) or in-memory for tests. */
export interface EngineStore {
  updateRun(runId: string, patch: RunPersistPatch): Promise<void>
  updateTask(taskId: string, patch: TaskPersistPatch): Promise<void>
  startAttempt(input: AttemptStart): Promise<string>
  finishAttempt(attemptId: string, input: AttemptFinish): Promise<void>
  recordModelCall(call: ModelCallRecord): Promise<void>
  emit(event: EngineEvent): void
}

export interface LocalModelRuntime extends LocalModelProfile {
  thinking?: boolean
  /** Explicitly failed structured self-test disables the automatic one-response path. */
  structuredOutput?: boolean
}

export interface EngineDeps {
  store: EngineStore
  worktrees: WorktreeManager
  ollama: OllamaClient
  localClientFor?: (model: string) => Pick<OllamaClient, 'chat'>
  localModels: LocalModelRuntime[]
  orchestrator?: OrchestratorAdapter
  checks: ValidationCheck[]
  index: RepoIndex
  stats: SuitabilityStats[]
  settings: EngineSettings
  /**
   * Skills, MCP and plugin tools assigned to the executing agent (provided by the application).
   * Loading failures fail the attempt rather than dropping required instructions.
   */
  agentResources?: (input: { task: EngineTask; model: string; worktreePath: string; supportsTools: boolean }) => Promise<{ tools: AgentTool[]; instructions?: string; sources?: string[]; requiredTools?: string[] }>
}

export interface RunOutcome {
  status: 'awaiting_approval' | 'failed' | 'cancelled'
  integratedTasks: string[]
  failedTasks: string[]
  finalValidation?: ValidationReport
  review?: ReviewSummary
  diff?: string
}

export interface ReviewSummary {
  kind: 'premium' | 'deterministic' | 'human_required'
  reason: string
  result?: ReviewResult
  deterministicIssues: string[]
  requiresHumanApproval: boolean
}

interface ChainStep {
  executor: 'local' | 'premium'
  model?: string
  /** Local repair round guided by the orchestrator's repair hint (inserted before premium execution). */
  hint?: boolean
}

/** The last behavioural failure of a task: what the orchestrator gets for a repair hint. */
interface FailedAttempt {
  diff: string
  failures: string
}

/** Result of one premium agent step, as executeTask consumes it. */
interface PremiumAgentResult {
  hardFailure: boolean
  timedOut: boolean
  error: string | undefined
  inputTokens: number
  outputTokens: number
  tokensMeasured: boolean
  sessionId: string | undefined
  summary: string | undefined
}

/** One executeComplexTask call, already booked. */
interface PremiumCallOutcome {
  ok: boolean
  summary?: string
  sessionId?: string
  usage: UsageReport
  kind?: string
  message?: string
  /** The CLI cannot be used for the rest of the run (login, quota, installation, model). */
  blocking: boolean
}

const NO_USAGE: UsageReport = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, measured: false, billing: 'unknown' }
const BLOCKING_KINDS = ['not_authenticated', 'session_expired', 'quota_exhausted', 'not_installed', 'model_unavailable']

const short = (id: string) => id.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase()

/**
 * Executes the planned tasks of one run: routing, isolated worktrees, local/premium agents,
 * patch validation, tests, bounded repair/escalation, incremental integration, final validation,
 * risk-based review. Nothing is applied to the user's checkout here (see integrator.applyChangeSet).
 */
export class ExecutionRunner {
  private scheduler?: DagScheduler
  private readonly controller = new AbortController()
  private readonly integrationMutex = new Mutex()
  private readonly unavailableModels = new Set<string>()
  private readonly structuredUnavailableModels = new Set<string>()
  private premiumBlockedReason?: string
  private integrationWorktree?: WorktreeHandle
  private readonly decisions = new Map<string, RouteDecision>()
  private readonly handoffs = new Map<string, TaskHandoff>()
  private baseline?: Promise<ValidationReport | undefined>
  /** Duo mode: the partner's CLI session per task, resumed in its repair round (the lead's travels as `sessionId`). */
  private readonly duoPartnerSessions = new Map<string, string>()
  /** Duo mode: sides that hit a blocking error (usage limit, auth) – not called again in this run. */
  private readonly duoBlockedSides = new Map<string, string>()

  constructor(
    private readonly run: EngineRun,
    private readonly tasks: EngineTask[],
    private readonly deps: EngineDeps,
  ) {}

  get signal() {
    return this.controller.signal
  }

  pause() {
    this.scheduler?.pause()
    void this.deps.store.updateRun(this.run.id, { status: 'paused' })
    this.event('info', 'run_paused', 'Run paused: running tasks finish, no new tasks start.')
  }

  resume() {
    this.scheduler?.resume()
    void this.deps.store.updateRun(this.run.id, { status: 'running' })
    this.event('info', 'run_resumed', 'Run resumed.')
  }

  cancel() {
    this.controller.abort()
    this.scheduler?.cancel()
    void this.deps.orchestrator?.cancelRun(this.run.id)
    for (const task of this.tasks) void this.deps.orchestrator?.cancelRun(`${this.run.id}:${task.key}`)
    this.event('warn', 'run_cancelled', 'Run cancelled by user.')
  }

  cancelTask(taskKey: string) {
    this.scheduler?.cancelTask(taskKey)
    void this.deps.orchestrator?.cancelRun(`${this.run.id}:${taskKey}`)
  }

  private event(level: EngineEvent['level'], type: string, message: string, data?: Record<string, unknown>, taskId?: string) {
    this.deps.store.emit({ runId: this.run.id, taskId, level, type, message, data })
  }

  async execute(): Promise<RunOutcome> {
    const { store, worktrees } = this.deps
    const runKey = short(this.run.id)
    await store.updateRun(this.run.id, { status: 'running', errorMessage: null })

    // 1. Base commit and integration worktree
    const base = this.run.baseCommit ?? (await headCommit(this.run.repoPath))
    if (!base) throw new Error('The repository has no commits yet. Create an initial commit first.')
    this.run.baseCommit = base
    const integrationBranch = this.run.integrationBranch ?? `mac/${runKey}/integration`
    const resuming = Boolean(this.run.integrationBranch)
    this.integrationWorktree = this.run.integrationBranch
      ? await worktrees.attach(this.run.repoPath, { projectKey: this.run.projectKey, name: `${runKey}-integration`, branch: integrationBranch })
      : await worktrees.create(this.run.repoPath, { projectKey: this.run.projectKey, name: `${runKey}-integration`, branch: integrationBranch, baseCommit: base, pooled: false })
    this.run.integrationBranch = integrationBranch
    await store.updateRun(this.run.id, { baseCommit: base, integrationBranch, integrationWorktree: this.integrationWorktree.path })
    this.event('info', 'integration_ready', `Integration worktree on ${integrationBranch} (base ${base.slice(0, 8)}).`)
    if (resuming) await this.reconcileIntegrated(base)

    // 2. Dependency DAG (with file-conflict serialization)
    const byKey = new Map(this.tasks.map((task) => [task.key, task]))
    const dagNodes = this.tasks.map((task) => ({ id: task.key, dependsOn: [...task.dependsOn], writes: [...task.relevantFiles, ...task.newFiles], priority: task.priority }))
    const dag = analyzeDag(dagNodes)
    for (const node of dagNodes) {
      const task = byKey.get(node.id)!
      if (node.dependsOn.join() !== task.dependsOn.join()) {
        task.dependsOn = node.dependsOn
        await store.updateTask(task.id, { dependsOn: node.dependsOn })
      }
    }
    for (const edge of dag.conflictEdges) this.event('info', 'dag_conflict_edge', `${edge.from} waits for ${edge.to} (both modify ${edge.files.join(', ')}).`)
    for (const edge of dag.removedEdges) this.event('warn', 'dag_cycle_broken', `Removed dependency ${edge.from} -> ${edge.to} (${edge.reason}).`)

    // 3. Routing
    for (const task of this.tasks) {
      if (task.status === 'completed' && task.commitSha) continue
      const decision = this.route(task)
      this.decisions.set(task.key, decision)
      await store.updateTask(task.id, {
        status: decision.executor === 'blocked' && !task.tool ? 'blocked' : 'queued',
        selectedModelClass: decision.executor === 'premium' ? 'premium_llm' : decision.executor === 'local' ? 'local_llm' : 'no_llm',
        selectedModelName: decision.executor === 'premium' ? this.deps.orchestrator?.displayName ?? 'premium' : decision.model,
        modelReason: decision.reasons.join('\n'),
        errorMessage: decision.executor === 'blocked' && !task.tool ? decision.reasons.at(-1) : null,
      })
      if (decision.executor === 'blocked' && !task.tool) task.status = 'blocked'
      this.event('info', 'task_routed', `${task.key} → ${decision.executor === 'premium' ? 'premium' : decision.model ?? 'blocked'} (${decision.tier}).`, { reasons: decision.reasons }, task.id)
    }

    // 4. Scheduling
    const schedulable: SchedulableTask[] = this.tasks.map((task) => {
      const decision = this.decisions.get(task.key)
      return {
        id: task.key,
        dependsOn: task.dependsOn,
        writes: [...task.relevantFiles, ...task.newFiles],
        priority: task.priority,
        resource: decision?.executor === 'premium' ? 'premium' : decision?.executor === 'local' ? 'local' : 'none',
        model: decision?.model,
      }
    })
    const initialStates: Record<string, TaskState> = {}
    for (const task of this.tasks) {
      if (task.status === 'completed' && task.commitSha) initialStates[task.key] = 'succeeded'
      else if (task.status === 'blocked') initialStates[task.key] = 'failed'
    }
    this.scheduler = new DagScheduler(schedulable, {
      slots: { local: Math.max(1, this.deps.settings.localSlots), premium: Math.max(1, this.deps.settings.premiumSlots), none: 1 },
      initialStates,
      maxInfraRetries: 1,
      // localSlots > 1 is only configured when the hardware fits several models at once.
      modelsCanCoexist: () => this.deps.settings.localSlots > 1,
      run: (task, signal) => this.executeTask(byKey.get(task.id)!, signal),
      onStateChange: (key, state, detail) => {
        const task = byKey.get(key)
        if (!task) return
        if (state === 'skipped' || state === 'cancelled') {
          task.status = state
          void store.updateTask(task.id, { status: state, errorMessage: detail ?? null, finishedAt: new Date() })
        }
        this.event(state === 'failed' ? 'warn' : 'info', 'task_state', `${key}: ${state}${detail ? ` – ${detail}` : ''}`, { state }, task.id)
      },
    })
    const scheduled = await this.scheduler.run()
    await this.cleanupTaskWorktrees()

    const integratedTasks = this.tasks.filter((task) => task.status === 'completed' && task.commitSha).map((task) => task.key)
    const failedTasks = this.tasks.filter((task) => task.status !== 'completed').map((task) => task.key)

    if (scheduled.cancelled || this.controller.signal.aborted) {
      await store.updateRun(this.run.id, { status: 'cancelled', finishedAt: new Date(), summary: `Cancelled. ${integratedTasks.length} task(s) had been integrated.` })
      return { status: 'cancelled', integratedTasks, failedTasks }
    }
    if (!integratedTasks.length) {
      // Nothing to approve or resume: leave no branch or worktree behind in the user's repository.
      await this.deps.worktrees.remove(this.run.repoPath, this.integrationWorktree.path, integrationBranch).catch(() => undefined)
      const message = 'No task produced a validated change.'
      await store.updateRun(this.run.id, { status: 'failed', finishedAt: new Date(), errorMessage: message, summary: message, integrationBranch: '', integrationWorktree: '' })
      return { status: 'failed', integratedTasks, failedTasks }
    }

    // 5. Final validation + review on the integration worktree
    await store.updateRun(this.run.id, { status: 'integrating' })
    const finalization = await this.finalize(failedTasks)
    return { status: finalization.ok ? 'awaiting_approval' : 'failed', integratedTasks, failedTasks, finalValidation: finalization.validation, review: finalization.review, diff: finalization.patch.diff }
  }

  /**
   * Idempotent resume: the integration branch is the source of truth for which tasks are already
   * integrated. A task whose commit is on the branch is never executed (and applied) again, even if
   * the run was interrupted before its database row was updated; a task marked completed whose commit
   * is missing from the branch runs again.
   */
  private async reconcileIntegrated(base: string) {
    const integrated = await integratedTaskCommits(this.integrationWorktree!.path, base, this.tasks.map((task) => task.key))
    for (const task of this.tasks) {
      const sha = integrated.get(task.key)
      if (sha && !(task.status === 'completed' && task.commitSha === sha)) {
        task.status = 'completed'
        task.commitSha = sha
        await this.deps.store.updateTask(task.id, { status: 'completed', commitSha: sha, errorMessage: null, finishedAt: new Date() })
        this.event('info', 'task_recovered', `${task.key}: already integrated (${sha.slice(0, 8)}); it is not executed again.`, undefined, task.id)
      } else if (!sha && task.status === 'completed') {
        task.status = 'planned'
        task.commitSha = undefined
        this.event('warn', 'task_requeued', `${task.key}: marked completed but its commit is not on the integration branch; running it again.`, undefined, task.id)
      }
    }
  }

  private route(task: EngineTask): RouteDecision {
    const securityCritical = [...task.relevantFiles, ...task.newFiles].some(isSecurityCriticalPath)
    return routeTask(
      { id: task.key, category: task.category, complexity: task.complexity, risk: task.risk, expectedInputTokens: task.expectedInputTokens, suggestedExecutor: task.suggestedExecutor, securityCritical, manualModel: task.manualModel },
      this.deps.localModels.map((model) => ({ ...model, available: model.available && !this.unavailableModels.has(model.model) })),
      { costMode: this.deps.settings.costMode, premiumAvailable: Boolean(this.deps.orchestrator) && !this.premiumBlockedReason, premiumExecutionAllowed: this.deps.settings.premiumExecutionAllowed },
      this.deps.stats,
    )
  }

  private chainFor(task: EngineTask): ChainStep[] {
    const decision = this.decisions.get(task.key) ?? this.route(task)
    if (decision.executor === 'blocked') return []
    const chain: ChainStep[] = [{ executor: decision.executor, model: decision.model }, ...decision.escalation]
    const capped = chain.slice(0, 1 + this.deps.settings.maxEscalationSteps)
    const allowed = capped.filter((step) => step.executor === 'local' || this.deps.settings.premiumExecutionAllowed || decision.executor === 'premium')
    // the assigned agent limits escalation (the first step is always its own)
    if (task.agent?.escalation === 'none') return allowed.slice(0, 1)
    const local = task.agent?.escalation === 'local' ? allowed.filter((step, index) => index === 0 || step.executor === 'local') : allowed
    // premium execution was ruled out, but premium may still advise the local model
    const premiumDropped = capped.some((step) => step.executor === 'premium') && !local.some((step) => step.executor === 'premium')
    return this.withHintStep(local, premiumDropped)
  }

  /**
   * "Premium advises, local executes": before the first premium step that follows local attempts, one more
   * local round with the strongest local model of the chain, guided by the orchestrator's repair hint.
   * When premium execution was ruled out (setting or agent escalation 'local'), the hint round ends the chain.
   * Not counted as an escalation step (it is a repair round of a model that already ran).
   */
  private withHintStep(chain: ChainStep[], premiumDropped = false): ChainStep[] {
    if (this.deps.settings.premiumHints === false || typeof this.deps.orchestrator?.repairHint !== 'function') return chain
    const premiumIndex = premiumDropped ? chain.length : chain.findIndex((step) => step.executor === 'premium')
    if (premiumIndex <= 0) return chain
    const strongest = chain.slice(0, premiumIndex).filter((step) => step.executor === 'local' && step.model).at(-1)
    if (!strongest) return chain
    return [...chain.slice(0, premiumIndex), { executor: 'local', model: strongest.model, hint: true }, ...chain.slice(premiumIndex)]
  }

  private async executeTask(task: EngineTask, signal: AbortSignal): Promise<'succeeded' | 'failed'> {
    const { store, worktrees, settings } = this.deps
    const runKey = short(this.run.id)
    task.status = 'running'
    await store.updateTask(task.id, { status: 'running', startedAt: new Date(), errorMessage: null })

    if (task.tool) {
      const viaTool = await this.executeTool(task, task.tool, signal)
      if (viaTool) return viaTool
      // Generated content (approved design files) cannot be reproduced by an agent: fail instead of falling back.
      if (task.tool.kind === 'write-files') {
        task.status = 'failed'
        await store.updateTask(task.id, { status: 'failed', finishedAt: new Date(), errorMessage: `${task.tool.kind} could not write a validated change.` })
        return 'failed'
      }
      this.event('info', 'fast_path_fallback', `${task.key}: deterministic ${task.tool.kind} did not produce a validated change; using an agent.`, undefined, task.id)
    }

    const chain = this.chainFor(task)
    if (!chain.length) {
      task.status = 'blocked'
      await store.updateTask(task.id, { status: 'blocked', errorMessage: 'No executor available for this task.' })
      return 'failed'
    }

    let attemptsTotal = 0
    let lastSummary = ''
    let previousFailures = ''
    let lastError = ''
    let worktree: WorktreeHandle | undefined

    try {
      for (let conflictRound = 0; conflictRound < 2; conflictRound += 1) {
        const startHead = await this.integrationMutex.run(async () => (await headCommit(this.integrationWorktree!.path))!)
        worktree = await worktrees.create(this.run.repoPath, {
          projectKey: this.run.projectKey,
          name: `${runKey}-${task.key}`,
          branch: `mac/${runKey}/${task.key}`,
          baseCommit: startHead,
        })
        await store.updateTask(task.id, { worktreePath: worktree.path, branchName: worktree.branch })
        this.event('info', 'worktree_created', `${task.key}: worktree at ${startHead.slice(0, 8)}.`, { path: worktree.path }, task.id)

        let success: { commit: string; patch: PatchValidationResult; report: ValidationReport } | undefined
        let lastFailed: FailedAttempt | undefined

        for (const [stepIndex, step] of chain.entries()) {
          if (signal.aborted) throw new CancelledError()
          if (step.executor === 'local' && step.model && this.unavailableModels.has(step.model)) continue
          if (step.executor === 'premium' && this.premiumBlockedReason) {
            this.event('warn', 'premium_unavailable', `${task.key}: premium skipped – ${this.premiumBlockedReason}`, undefined, task.id)
            continue
          }
          if (step.hint) {
            const hint = await this.prepareHintRound(task, worktree, startHead, lastFailed, signal)
            if (!hint) continue
            previousFailures = renderRepairHint(hint, lastFailed?.failures)
          } else if (stepIndex > 0) {
            await worktrees.reset(worktree.path, startHead)
            this.event('warn', 'task_escalated', `${task.key}: escalating to ${step.executor === 'premium' ? 'premium orchestrator' : step.model}.`, undefined, task.id)
          }
          // the hint round is exactly one repair round of a model that already ran
          const maxRounds = step.hint ? 1 : step.executor === 'local' ? 1 + (task.agent?.maxRepairs ?? settings.maxLocalRepairs) : 1 + Math.min(1, task.agent?.maxRepairs ?? 1)
          let sessionId: string | undefined
          for (let stepRound = 0; stepRound < maxRounds; stepRound += 1) {
            if (signal.aborted) throw new CancelledError()
            const round = step.hint ? 1 : stepRound
            attemptsTotal += 1
            await store.updateTask(task.id, { status: round > 0 ? 'repairing' : 'running', attempts: attemptsTotal })
            const modelName = step.executor === 'premium' ? this.deps.orchestrator!.id : step.model!
            const attemptId = await store.startAttempt({
              runId: this.run.id,
              taskId: task.id,
              executor: step.executor,
              model: modelName,
              category: task.category,
              repairRound: round,
              promptSummary: `${task.key} ${task.title}`.slice(0, 500),
            })
            const started = Date.now()
            const logs: string[] = []
            const agent = await (step.executor === 'local'
              ? this.runLocal(task, step.model!, worktree, previousFailures, signal, logs, round)
              : this.runPremium(task, worktree, previousFailures, signal, logs, round, sessionId)
            ).catch(async (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error)
              await store.finishAttempt(attemptId, {
                outcome: signal.aborted ? 'cancelled' : 'error', status: signal.aborted ? 'cancelled' : 'failed',
                durationMs: Date.now() - started, tokensMeasured: false, patchStatus: 'no_patch', logs, errorMessage: message, escalated: false,
              })
              task.status = signal.aborted ? 'cancelled' : 'failed'
              await store.updateTask(task.id, { status: task.status, errorMessage: message })
              throw error
            })
            sessionId = agent.sessionId ?? sessionId
            lastSummary = agent.summary ?? lastSummary

            if (agent.hardFailure) {
              await store.finishAttempt(attemptId, {
                outcome: agent.timedOut ? 'timeout' : signal.aborted ? 'cancelled' : 'error',
                status: signal.aborted ? 'cancelled' : 'failed',
                durationMs: Date.now() - started,
                inputTokens: agent.inputTokens,
                outputTokens: agent.outputTokens,
                tokensMeasured: agent.tokensMeasured,
                patchStatus: 'no_patch',
                logs,
                errorMessage: agent.error,
                escalated: stepIndex < chain.length - 1,
              })
              lastError = agent.error ?? 'Agent failed.'
              if (signal.aborted) throw new CancelledError()
              break // no repair for infrastructure failures; next escalation step
            }

            if (agent.error) {
              await store.finishAttempt(attemptId, {
                outcome: 'error', status: 'failed', durationMs: Date.now() - started,
                inputTokens: agent.inputTokens, outputTokens: agent.outputTokens, tokensMeasured: agent.tokensMeasured,
                patchStatus: 'incomplete', logs, errorMessage: agent.error, escalated: false,
              })
              previousFailures = 'The previous response was incomplete: ' + agent.error + '. Inspect current files and finish the complete task.'
              lastError = previousFailures
              lastFailed = { diff: '', failures: previousFailures }
              continue
            }

            // Commit the attempt and validate it – after the mechanical design fixes (see design-normalize.ts).
            await store.updateTask(task.id, { status: 'validating' })
            const designFixes = await normalizeDesign(worktree.path).catch(() => [] as string[])
            if (designFixes.length) this.event('info', 'design_fixed', `${task.key}: ${designFixes.join('; ')}`, undefined, task.id)
            const commit = await commitIfChanged(worktree.path, `${task.key}: ${task.title}`)
            if (!commit && !agent.error && agent.summary && task.acceptanceCriteria.includes(FILE_SCOPED_CRITERION)) {
              // a per-file task of a project-wide goal: the agent found nothing in its file to change
              await store.finishAttempt(attemptId, {
                outcome: 'success', status: 'completed', durationMs: Date.now() - started, inputTokens: agent.inputTokens, outputTokens: agent.outputTokens,
                tokensMeasured: agent.tokensMeasured, patchStatus: 'empty', logs, escalated: false,
              })
              task.status = 'completed'
              await store.updateTask(task.id, { status: 'completed', finishedAt: new Date(), errorMessage: null })
              this.event('info', 'task_no_change', `${task.key}: nothing to change in ${task.relevantFiles.join(', ')}${agent.summary ? ` – ${agent.summary.slice(0, 300)}` : ''}.`, undefined, task.id)
              return 'succeeded'
            }
            if (!commit) {
              await store.finishAttempt(attemptId, {
                outcome: 'no_changes', status: 'failed', durationMs: Date.now() - started, inputTokens: agent.inputTokens, outputTokens: agent.outputTokens,
                tokensMeasured: agent.tokensMeasured, patchStatus: 'empty', logs, errorMessage: agent.error ?? 'No file was changed.', escalated: false,
              })
              previousFailures = `Your previous attempt did not change any file.${agent.error ? ` (${agent.error})` : ''} Implement the task by writing the files.`
              lastError = 'No changes produced.'
              lastFailed = { diff: '', failures: previousFailures }
              continue
            }

            const patch = await validatePatch(worktree.path, startHead, commit, this.patchPolicy(task))
            if (!patch.ok) {
              const issues = patch.issues.filter((issue) => issue.severity === 'blocking').map((issue) => `- ${issue.code}${issue.file ? ` (${issue.file})` : ''}: ${issue.message}`).join('\n')
              await git(worktree.path, ['reset', '-q', startHead], { internal: true })
              await store.finishAttempt(attemptId, {
                outcome: 'invalid_patch', status: 'failed', durationMs: Date.now() - started, inputTokens: agent.inputTokens, outputTokens: agent.outputTokens,
                tokensMeasured: agent.tokensMeasured, patchText: patch.diff.slice(0, 200_000), patchStatus: 'rejected', diffSummary: summarizePatch(patch), logs, errorMessage: issues, escalated: false,
              })
              this.event('warn', 'patch_rejected', `${task.key}: patch rejected.\n${issues}`, undefined, task.id)
              previousFailures = `The patch was rejected by the safety validator:\n${issues}`
              lastError = previousFailures
              lastFailed = { diff: patch.diff, failures: previousFailures }
              continue
            }

            // a file-scoped task may legitimately only remove (e.g. the old framework's import in one file)
            const hollow = task.acceptanceCriteria.includes(FILE_SCOPED_CRITERION) ? undefined : hollowChange(patch.diff, `${task.title}\n${this.run.goal}`)
            if (hollow) {
              await git(worktree.path, ['reset', '-q', startHead], { internal: true })
              await store.finishAttempt(attemptId, {
                outcome: 'invalid_patch', status: 'failed', durationMs: Date.now() - started, inputTokens: agent.inputTokens, outputTokens: agent.outputTokens,
                tokensMeasured: agent.tokensMeasured, patchText: patch.diff.slice(0, 200_000), patchStatus: 'rejected', diffSummary: summarizePatch(patch), logs, errorMessage: hollow, escalated: false,
              })
              this.event('warn', 'patch_rejected', `${task.key}: ${hollow}`, undefined, task.id)
              previousFailures = `${hollow} The task is not a removal: replace every removed piece with its equivalent that fulfils the task, then call finish.`
              lastError = hollow
              lastFailed = { diff: patch.diff, failures: hollow }
              continue
            }

            let report = await this.validate(worktree.path, signal, (checkId, chunk) => this.event('debug', 'check_output', chunk.slice(0, 2000), { checkId }, task.id))
            if (!report.ok) {
              const fixed = await this.deterministicFix(worktree.path, report, patch, task)
              if (fixed) report = fixed.report
            }
            let finalCommit = (await headCommit(worktree.path))!
            if (!report.ok) {
              await git(worktree.path, ['reset', '-q', startHead], { internal: true })
              const digest = failureDigest(report)
              await store.finishAttempt(attemptId, {
                outcome: 'validation_failed', status: 'failed', durationMs: Date.now() - started, inputTokens: agent.inputTokens, outputTokens: agent.outputTokens,
                tokensMeasured: agent.tokensMeasured, patchText: patch.diff.slice(0, 200_000), patchStatus: 'validation_failed', diffSummary: summarizePatch(patch), validation: report, logs,
                errorMessage: report.summary, escalated: stepRound === maxRounds - 1 && stepIndex < chain.length - 1,
              })
              this.event('warn', 'validation_failed', `${task.key}: ${report.summary}`, undefined, task.id)
              previousFailures = digest
              lastError = report.summary
              lastFailed = { diff: patch.diff, failures: digest || report.summary }
              continue
            }

            // Integration cherry-picks exactly one commit: fold a deterministic formatting commit into the
            // task commit, otherwise only the formatting change would be integrated.
            if (finalCommit !== commit) finalCommit = await squashSince(worktree.path, startHead, `${task.key}: ${task.title}`)
            const finalPatch = finalCommit === commit ? patch : await validatePatch(worktree.path, startHead, finalCommit, this.patchPolicy(task))
            await store.finishAttempt(attemptId, {
              outcome: 'success', status: 'completed', durationMs: Date.now() - started, inputTokens: agent.inputTokens, outputTokens: agent.outputTokens,
              tokensMeasured: agent.tokensMeasured, patchText: finalPatch.diff.slice(0, 200_000), patchStatus: 'validated', diffSummary: summarizePatch(finalPatch), validation: report, logs, escalated: false,
            })
            success = { commit: finalCommit, patch: finalPatch, report }
            break
          }
          if (success) break
        }

        if (!success) {
          task.status = 'failed'
          await store.updateTask(task.id, { status: 'failed', errorMessage: lastError.slice(0, 4000) || 'All attempts failed.', finishedAt: new Date() })
          return 'failed'
        }

        // Integrate (serialized). On conflict, retry once on top of the new integration head.
        const integration = await this.integrationMutex.run(() => cherryPick(this.integrationWorktree!.path, success!.commit))
        if (!integration.ok) {
          this.event('warn', 'integration_conflict', `${task.key}: conflicts with already integrated work in ${integration.conflicts.join(', ')}.`, { conflicts: integration.conflicts }, task.id)
          previousFailures = `Your change conflicted with work integrated by another agent in: ${integration.conflicts.join(', ')}. Re-apply the task on top of the current files.`
          lastError = `Integration conflict in ${integration.conflicts.join(', ')}`
          await worktrees.remove(this.run.repoPath, worktree.path, worktree.branch)
          worktree = undefined
          continue
        }
        task.status = 'completed'
        task.commitSha = integration.sha
        await store.updateTask(task.id, {
          status: 'completed',
          commitSha: integration.sha,
          patchText: success.patch.diff.slice(0, 200_000),
          patchStats: { files: success.patch.files, linesAdded: success.patch.linesAdded, linesDeleted: success.patch.linesDeleted, securityCritical: success.patch.securityCritical, warnings: success.patch.issues.filter((issue) => issue.severity === 'warning') },
          validation: success.report,
          finishedAt: new Date(),
          errorMessage: null,
        })
        this.event('info', 'task_integrated', `${task.key}: integrated (${success.patch.files.length} file(s), tests ${success.report.testsPassed} passed).`, undefined, task.id)
        this.recordHandoff(task, success.patch.files.map((file) => file.path), lastSummary)
        return 'succeeded'
      }
      task.status = 'failed'
      await store.updateTask(task.id, { status: 'failed', errorMessage: lastError || 'Integration conflicts could not be resolved.', finishedAt: new Date() })
      return 'failed'
    } catch (error) {
      if (error instanceof CancelledError || signal.aborted) {
        task.status = 'cancelled'
        await store.updateTask(task.id, { status: 'cancelled', finishedAt: new Date() })
        return 'failed'
      }
      throw error
    } finally {
      if (worktree) await worktrees.remove(this.run.repoPath, worktree.path, worktree.branch).catch(() => undefined)
      await store.updateTask(task.id, { worktreePath: null, branchName: null }).catch(() => undefined)
    }
  }

  /**
   * Fast path: runs the deterministic tool in its own worktree, validates and integrates like an agent
   * result. Returns undefined when the tool produced nothing usable (the agent chain takes over).
   */
  private async executeTool(task: EngineTask, tool: FastPathTool, signal: AbortSignal): Promise<'succeeded' | undefined> {
    const { store, worktrees, settings } = this.deps
    const runKey = short(this.run.id)
    const startHead = await this.integrationMutex.run(async () => (await headCommit(this.integrationWorktree!.path))!)
    const worktree = await worktrees.create(this.run.repoPath, { projectKey: this.run.projectKey, name: `${runKey}-${task.key}-tool`, branch: `mac/${runKey}/${task.key}-tool`, baseCommit: startHead })
    const started = Date.now()
    const attemptId = await store.startAttempt({ runId: this.run.id, taskId: task.id, executor: 'deterministic', model: `tool:${tool.kind}`, category: task.category, repairRound: 0, promptSummary: `${task.key} ${task.title}`.slice(0, 500) })
    const finish = (input: Partial<AttemptFinish> & Pick<AttemptFinish, 'outcome' | 'status'>) =>
      store.finishAttempt(attemptId, { durationMs: Date.now() - started, tokensMeasured: true, inputTokens: 0, outputTokens: 0, patchStatus: 'no_patch', logs: [], escalated: false, ...input })
    try {
      this.event('info', 'fast_path_started', `${task.key}: deterministic ${tool.kind} (no model call).`, undefined, task.id)
      const result = await runFastPathTool(worktree.path, tool, { signal })
      const commit = result.ok && result.changed.length ? await commitIfChanged(worktree.path, `${task.key}: ${task.title}`) : undefined
      if (result.ok && !commit && tool.kind === 'write-files') {
        // The files already hold exactly this content (re-run, or only line endings differ): nothing to integrate.
        await finish({ outcome: 'no_changes', status: 'completed', logs: [result.message] })
        task.status = 'completed'
        await store.updateTask(task.id, { status: 'completed', selectedModelClass: 'no_llm', selectedModelName: `Werkzeug: ${tool.kind}`, finishedAt: new Date(), errorMessage: null })
        this.event('info', 'task_integrated', `${task.key}: files already up to date (${tool.kind}).`, undefined, task.id)
        return 'succeeded'
      }
      if (!commit) {
        await finish({ outcome: result.ok ? 'no_changes' : 'error', status: 'failed', errorMessage: result.message, logs: [result.message] })
        return undefined
      }
      const patch = await validatePatch(worktree.path, startHead, commit, this.patchPolicy(task))
      if (!patch.ok) {
        await finish({ outcome: 'invalid_patch', status: 'failed', patchText: patch.diff.slice(0, 200_000), patchStatus: 'rejected', errorMessage: patch.issues.map((issue) => issue.message).join('; ') })
        return undefined
      }
      const report = await this.validate(worktree.path, signal)
      if (!report.ok) {
        await finish({ outcome: 'validation_failed', status: 'failed', patchText: patch.diff.slice(0, 200_000), patchStatus: 'validation_failed', validation: report, errorMessage: report.summary })
        return undefined
      }
      const integration = await this.integrationMutex.run(() => cherryPick(this.integrationWorktree!.path, commit))
      if (!integration.ok) {
        await finish({ outcome: 'conflict', status: 'failed', errorMessage: `conflict in ${integration.conflicts.join(', ')}` })
        return undefined
      }
      await finish({ outcome: 'success', status: 'completed', patchText: patch.diff.slice(0, 200_000), patchStatus: 'validated', diffSummary: summarizePatch(patch), validation: report, logs: [result.message] })
      task.status = 'completed'
      task.commitSha = integration.sha
      await store.updateTask(task.id, {
        status: 'completed',
        commitSha: integration.sha,
        selectedModelClass: 'no_llm',
        selectedModelName: `Werkzeug: ${tool.kind}`,
        patchText: patch.diff.slice(0, 200_000),
        patchStats: { files: patch.files, linesAdded: patch.linesAdded, linesDeleted: patch.linesDeleted, securityCritical: patch.securityCritical, warnings: patch.issues.filter((issue) => issue.severity === 'warning') },
        validation: report,
        finishedAt: new Date(),
        errorMessage: null,
      })
      this.event('info', 'task_integrated', `${task.key}: integrated via ${tool.kind} without a model call (${patch.files.length} file(s)).`, undefined, task.id)
      this.recordHandoff(task, patch.files.map((file) => file.path), `${tool.kind} applied deterministically.`)
      return 'succeeded'
    } catch (error) {
      if (signal.aborted) throw new CancelledError()
      await finish({ outcome: 'error', status: 'failed', errorMessage: error instanceof Error ? error.message : String(error) }).catch(() => undefined)
      return undefined
    } finally {
      await worktrees.remove(this.run.repoPath, worktree.path, worktree.branch).catch(() => undefined)
    }
  }

  private patchPolicy(task: EngineTask): PatchPolicy {
    const files = [...task.relevantFiles, ...task.newFiles]
    const allowed = files.length ? [...files, ...new Set(files.map((file) => path.posix.dirname(file)).filter((dir) => dir && dir !== '.').map((dir) => `${dir}/**`))] : []
    return { allowedPatterns: allowed, deniedPatterns: DEFAULT_DENIED_PATTERNS, strictScope: this.deps.settings.strictScope, maxFiles: task.agent?.permissions?.write === false ? 0 : Math.min(40, task.agent?.resources?.maxFiles ?? 40), maxFileBytes: Math.min(512 * 1024, task.agent?.resources?.maxWriteBytes ?? 512 * 1024) }
  }

  /** Structured, compact handoff (files + one-paragraph summary) for dependent tasks. */
  private recordHandoff(task: EngineTask, files: string[], summary: string) {
    const handoff: TaskHandoff = { key: task.key, title: task.title, files: files.slice(0, 30), summary: summary.replace(/\s+/g, ' ').trim().slice(0, 600) || task.title }
    this.handoffs.set(task.key, handoff)
    this.event('debug', 'task_handoff', `${task.key}: handoff for dependent tasks (${handoff.files.length} file(s)).`, { handoff }, task.id)
  }

  /** Results of the prerequisite tasks, as compact text for a dependent task's prompt. */
  handoffContext(task: EngineTask): string {
    const lines = task.dependsOn
      .map((key) => this.handoffs.get(key))
      .filter((handoff): handoff is TaskHandoff => Boolean(handoff))
      .map((handoff) => `- ${handoff.key} "${handoff.title}": ${handoff.summary} Files: ${handoff.files.join(', ') || '–'}`)
    return lines.length ? `## Results of prerequisite tasks (already integrated)\n${lines.join('\n')}` : ''
  }

  private async runLocal(task: EngineTask, model: string, worktree: WorktreeHandle, previousFailures: string, signal: AbortSignal, logs: string[], round: number) {
    const profile = this.deps.localModels.find((candidate) => candidate.model === model)
    const policy = this.patchPolicy(task)
    const workspace = new WorkspaceFiles(worktree.path, {
      writablePatterns: policy.allowedPatterns,
      deniedPatterns: DEFAULT_DENIED_PATTERNS,
      maxReadBytes: 64 * 1024,
      maxWriteBytes: Math.min(256 * 1024, task.agent?.resources?.maxWriteBytes ?? Infinity),
      allowDelete: false,
      allowRead: task.agent?.permissions?.read,
      allowWrite: task.agent?.permissions?.write,
      maxFiles: task.agent?.resources?.maxFiles,
    })
    const numCtx = Math.min(this.deps.settings.numCtx, profile?.contextWindow || this.deps.settings.numCtx, task.agent?.maxContextTokens ?? Infinity)
    const digest = await buildContextDigest(this.deps.index, `${task.title}\n${task.description}`, { explicitFiles: task.relevantFiles, budgetTokens: Math.min(2500, Math.floor(numCtx / 6)), excerptFiles: 0, maxFiles: 10 })
    // Without external tools (extraTools are dropped below) skills must be inlined, not loaded via load_skill.
    const resources = this.deps.agentResources
      ? await this.deps.agentResources({ task, model, worktreePath: worktree.path, supportsTools: (profile?.toolCalling ?? false) && task.agent?.permissions?.externalTools !== false }).catch((error: unknown) => {
          this.event('warn', 'agent_resources_failed', `${task.key}: skills/tools unavailable (${error instanceof Error ? error.message : String(error)}).`, undefined, task.id)
          throw error // Required instructions/tools must not be silently dropped.
        })
      : undefined
    this.event('info', 'agent_started', `${task.key}: ${task.agent ? `${task.agent.name} mit ` : ''}${model}${round ? ` (repair ${round})` : ''}, ${profile?.toolCalling ? 'tool calling' : 'structured output'}${resources?.sources?.length ? `, mit ${resources.sources.join(', ')}` : ''}.`, undefined, task.id)
    const result: LocalAgentResult = await runLocalAgent({
      client: this.deps.localClientFor?.(model) ?? this.deps.ollama,
      model,
      supportsTools: profile?.toolCalling ?? false,
      preferStructured: this.deps.settings.localExecutionMode !== 'tools' && profile?.structuredOutput !== false && !this.structuredUnavailableModels.has(model) && task.complexity <= 2 && task.risk <= 2 && ![...task.relevantFiles, ...task.newFiles].some(isSecurityCriticalPath),
      supportsThinking: profile?.thinking,
      workspace,
      task: { id: task.key, title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria, relevantFiles: task.relevantFiles, newFiles: task.newFiles },
      context: [renderContext(digest, 10_000), this.handoffContext(task)].filter(Boolean).join('\n\n'),
      previousFailures: previousFailures || undefined,
      search: (query) => searchCode(worktree.path, query, { maxResults: 30 }),
      extraTools: task.agent?.permissions?.externalTools === false ? [] : resources?.tools,
      requiredTools: [...(resources?.requiredTools ?? []), ...requiredToolNames(resources?.tools ?? [], this.run.goal)],
      extraInstructions: [task.agent?.instructions ? `## Your role: ${task.agent.name}\n${task.agent.instructions}` : '', resources?.instructions ?? ''].filter(Boolean).join('\n\n') || undefined,
      maxSteps: task.agent?.maxSteps,
      maxOutputTokens: task.agent?.resources?.maxOutputTokens,
      numCtx,
      keepAlive: this.deps.settings.keepAlive,
      timeoutMs: Math.min(this.deps.settings.taskTimeoutMs, task.agent?.resources?.timeoutMs ?? Infinity),
      signal,
      onEvent: (event) => {
        if (event.type === 'tool_call') {
          const line = `${event.ok ? '✓' : '✗'} ${event.name} ${event.args} – ${event.result}`
          logs.push(line)
          this.event(event.ok ? 'debug' : 'warn', 'tool_call', line, undefined, task.id)
        } else if (event.type === 'text') {
          logs.push(event.text)
        }
      },
    })
    let peakMemoryMb: number | undefined
    if (result.mode === 'structured' && (result.errorKind === 'invalid_output' || result.invalidToolCalls > 0)) {
      this.structuredUnavailableModels.add(model)
      this.event('info', 'structured_fallback', `${model}: structured operations could not be applied reliably; further attempts use its tool loop when available.`, undefined, task.id)
    }
    try {
      const running = await this.deps.ollama.running()
      const loaded = running.find((entry) => entry.name === model || entry.model === model)
      if (loaded) peakMemoryMb = Math.round(loaded.size / 1024 / 1024)
    } catch {
      // memory figure is optional
    }
    await this.deps.store.recordModelCall({
      runId: this.run.id,
      taskId: task.id,
      kind: 'local',
      provider: 'ollama',
      model,
      purpose: round ? 'repair' : 'execute',
      status: result.status === 'failed' ? 'error' : 'ok',
      errorClass: result.errorKind,
      durationMs: result.durationMs,
      usage: { inputTokens: result.promptTokens, outputTokens: result.completionTokens, cachedInputTokens: 0, measured: true, billing: 'subscription' },
      peakMemoryMb,
    })
    if (result.errorKind === 'out_of_memory' || result.errorKind === 'unreachable' || result.errorKind === 'not_found') {
      this.unavailableModels.add(model)
      this.event('error', 'model_unavailable', `${model} is unavailable for the rest of this run: ${result.error}`, { kind: result.errorKind }, task.id)
    }
    logs.unshift(`${model}: ${result.mode} mode, ${result.steps} step(s), ${result.toolCalls} tool call(s) (${result.invalidToolCalls} invalid, ${result.recoveredToolCalls} recovered from text), ${result.promptTokens}+${result.completionTokens} tokens, ${result.durationMs} ms.`)
    if (result.summary) logs.push(`Summary: ${result.summary}`)
    // Infrastructure failures (timeout, stall, OOM, unreachable, cancel) skip repair and go to the next
    // escalation step; behavioural failures (no edits, bad tool use) get a repair round with feedback.
    const hardFailure = result.status === 'failed' && result.errorKind !== undefined && result.errorKind !== 'tool_misuse' && result.errorKind !== 'invalid_output'
    return {
      hardFailure,
      timedOut: result.errorKind === 'timeout' || result.errorKind === 'stalled',
      error: result.error,
      inputTokens: result.promptTokens,
      outputTokens: result.completionTokens,
      tokensMeasured: true,
      sessionId: undefined as string | undefined,
      summary: result.summary,
    }
  }

  private async runPremium(task: EngineTask, worktree: WorktreeHandle, previousFailures: string, signal: AbortSignal, logs: string[], round: number, resumeSessionId?: string) {
    const orchestrator = this.deps.orchestrator!
    if (task.agent?.maxContextTokens !== undefined || task.agent?.resources?.maxOutputTokens !== undefined) {
      const error = `Agent ${task.agent.name}: hard context/output token limits are not supported by the premium CLI; no call was started.`
      this.event('error', 'agent_resource_limit', error, undefined, task.id)
      return { hardFailure: true, timedOut: false, error, inputTokens: 0, outputTokens: 0, tokensMeasured: true, sessionId: undefined as string | undefined, summary: undefined as string | undefined }
    }
    // a premium CLI reads the worktree itself: "no read permission" cannot be enforced there
    if (task.agent?.permissions?.read === false) {
      const error = `Agent ${task.agent.name} has no read permission; this can only be enforced for local agents, not for ${orchestrator.displayName}.`
      this.event('error', 'agent_permission', `${task.key}: ${error}`, undefined, task.id)
      return { hardFailure: true, timedOut: false, error, inputTokens: 0, outputTokens: 0, tokensMeasured: true, sessionId: undefined as string | undefined, summary: undefined as string | undefined }
    }
    // the same role and skills a local agent gets (e.g. the UI design rules for a frontend task)
    const resources = this.deps.agentResources
      ? await this.deps.agentResources({ task, model: orchestrator.id, worktreePath: worktree.path, supportsTools: false }).catch((error: unknown) => {
          this.event('warn', 'agent_resources_failed', `${task.key}: skills unavailable (${error instanceof Error ? error.message : String(error)}).`, undefined, task.id)
          throw error // Required instructions must not be silently dropped.
        })
      : undefined
    const guidance = [task.agent?.instructions ? `## Your role: ${task.agent.name}\n${task.agent.instructions}` : '', resources?.instructions ?? ''].filter(Boolean).join('\n\n') || undefined
    this.event('info', 'agent_started', `${task.key}: ${orchestrator.displayName}${round ? ' (repair)' : ''}${resources?.sources?.length ? `, mit ${resources.sources.join(', ')}` : ''}.`, undefined, task.id)
    const input: ExecutionInput = {
      taskId: task.key,
      title: task.title,
      instructions: task.description,
      guidance,
      acceptanceCriteria: task.acceptanceCriteria,
      relevantFiles: [...task.relevantFiles, ...task.newFiles],
      previousFailures: previousFailures || undefined,
      resumeSessionId: round > 0 ? resumeSessionId : undefined,
    }
    const callContext = (cwd: string, sink: string[]): CallContext => ({
      runId: `${this.run.id}:${task.key}`,
      cwd,
      mcpRole: 'coder',
      // externalTools: false = no MCP tools at all; otherwise the agent's assigned servers
      mcpServers: task.agent?.permissions?.externalTools === false ? [] : task.agent?.mcpServers,
      signal,
      timeoutMs: Math.min(this.deps.settings.taskTimeoutMs, task.agent?.resources?.timeoutMs ?? Infinity),
      effort: task.complexity >= 4 ? 'high' : 'medium',
      onEvent: (event) => this.forwardOrchestratorEvent(event, task, sink),
    })
    if (isDuo(orchestrator)) return this.runDuoPremium(orchestrator, task, worktree, input, callContext, signal, logs, round)
    return this.runSinglePremium(orchestrator, task, input, callContext(worktree.path, logs), logs, round)
  }

  private async runSinglePremium(adapter: OrchestratorAdapter, task: EngineTask, input: ExecutionInput, ctx: CallContext, logs: string[], round: number): Promise<PremiumAgentResult> {
    const outcome = await this.premiumCall(adapter, task, input, ctx, round)
    if (outcome.ok) {
      logs.push(`Summary: ${outcome.summary}`)
      return { hardFailure: false, timedOut: false, error: undefined, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, tokensMeasured: outcome.usage.measured, sessionId: outcome.sessionId, summary: outcome.summary }
    }
    if (outcome.blocking) this.blockPremium(adapter.displayName, outcome, task)
    logs.push(`Error (${outcome.kind}): ${outcome.message}`)
    return { hardFailure: true, timedOut: outcome.kind === 'timeout', error: `${outcome.kind}: ${outcome.message}`, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, tokensMeasured: outcome.usage.measured, sessionId: undefined, summary: undefined }
  }

  private blockPremium(name: string, outcome: PremiumCallOutcome, task: EngineTask) {
    this.premiumBlockedReason = `${name}: ${(outcome.kind ?? 'process_failed').replace(/_/g, ' ')}`
    this.event('error', 'premium_blocked', `${this.premiumBlockedReason}. Premium execution disabled for this run. ${(outcome.message ?? '').slice(0, 300)}`, { kind: outcome.kind }, task.id)
  }

  /** The one event when a duo side becomes unusable; the other side then works alone for the rest of the run. */
  private duoSideBlockedEvent(adapter: OrchestratorAdapter, outcome: PremiumCallOutcome, task: EngineTask) {
    this.event('warn', 'duo_partner_unavailable', `${task.key}: ${adapter.displayName} is unavailable (${outcome.kind}); the other orchestrator's result is used and it works alone for the rest of this run.`, { kind: outcome.kind, provider: adapter.id }, task.id)
  }

  /** One executeComplexTask call of one CLI, booked with that CLI as provider. */
  private async premiumCall(adapter: OrchestratorAdapter, task: EngineTask, input: ExecutionInput, ctx: CallContext, round: number): Promise<PremiumCallOutcome> {
    const purpose = round ? 'repair' : 'execute'
    const started = Date.now()
    try {
      const { result, meta } = await adapter.executeComplexTask(input, ctx)
      await this.recordOrchestratorCall(adapter.id, { taskId: task.id, purpose, status: 'ok', durationMs: meta.durationMs, meta })
      return { ok: true, summary: result.summary, sessionId: result.sessionId, usage: meta.usage, blocking: false }
    } catch (error) {
      const kind = error instanceof OrchestratorError ? error.kind : 'process_failed'
      const message = error instanceof Error ? error.message : String(error)
      // a completed call whose output was rejected still used the quota
      const meta = error instanceof OrchestratorError ? error.details.meta : undefined
      await this.recordOrchestratorCall(adapter.id, { taskId: task.id, purpose, status: 'error', errorClass: kind, durationMs: Date.now() - started, meta })
      return { ok: false, kind, message, usage: meta?.usage ?? NO_USAGE, blocking: BLOCKING_KINDS.includes(kind) }
    }
  }

  /**
   * Duo premium execution (ADR-004): lead and partner implement the task at the same time, the lead in the task
   * worktree, the partner in a sibling worktree on the same commit with the same uncommitted state. The winner is
   * chosen deterministically (checks green > fewer failed tests > fewer failed checks > fewer type errors); on a
   * tie the lead picks (`duo_choose` call). The task worktree then holds exactly the winner's change, and
   * executeTask validates and integrates it as usual. The sibling worktree is always removed.
   */
  private async runDuoPremium(duo: DuoOrchestrator, task: EngineTask, worktree: WorktreeHandle, input: ExecutionInput, callContext: (cwd: string, sink: string[]) => CallContext, signal: AbortSignal, logs: string[], round: number): Promise<PremiumAgentResult> {
    const { worktrees } = this.deps
    // a side that hit a usage limit or lost its login earlier in this run is not called again
    const leadBlocked = this.duoBlockedSides.has(duo.leadAdapter.id)
    const partnerBlocked = this.duoBlockedSides.has(duo.partnerAdapter.id)
    if (leadBlocked && !partnerBlocked) {
      const alone = await this.runSinglePremium(duo.partnerAdapter, task, { ...input, resumeSessionId: round > 0 ? this.duoPartnerSessions.get(task.key) : undefined }, callContext(worktree.path, logs), logs, round)
      if (alone.sessionId) this.duoPartnerSessions.set(task.key, alone.sessionId)
      return alone
    }
    if (partnerBlocked && leadBlocked) {
      const error = `premium blocked: ${this.premiumBlockedReason ?? [...this.duoBlockedSides.values()].join('; ')}`
      return { hardFailure: true, timedOut: false, error, inputTokens: 0, outputTokens: 0, tokensMeasured: false, sessionId: undefined, summary: undefined }
    }
    if (partnerBlocked) return this.runSinglePremium(duo.leadAdapter, task, input, callContext(worktree.path, logs), logs, round)
    const runKey = short(this.run.id)
    const head = (await headCommit(worktree.path))!
    // a repair round starts from the failed attempt's files, which are still uncommitted in the task worktree
    const carried = await workingDiff(worktree.path)
    let sibling: WorktreeHandle | undefined
    try {
      sibling = await worktrees.create(this.run.repoPath, { projectKey: this.run.projectKey, name: `${runKey}-${task.key}-duo`, branch: `mac/${runKey}/${task.key}-duo`, baseCommit: head })
      if (carried.trim()) {
        const copied = await applyPatch(sibling.path, carried)
        if (!copied.ok) throw new Error(`the current files could not be copied (${copied.message.slice(0, 200)})`)
      }
    } catch (error) {
      if (sibling) await worktrees.remove(this.run.repoPath, sibling.path, sibling.branch).catch(() => undefined)
      this.event('warn', 'duo_sibling_failed', `${task.key}: no worktree for ${duo.partnerAdapter.displayName} (${error instanceof Error ? error.message : String(error)}); ${duo.leadAdapter.displayName} executes alone.`, undefined, task.id)
      return this.runSinglePremium(duo.leadAdapter, task, input, callContext(worktree.path, logs), logs, round)
    }

    try {
      const leadLogs: string[] = []
      const partnerLogs: string[] = []
      const partnerInput: ExecutionInput = { ...input, resumeSessionId: round > 0 ? this.duoPartnerSessions.get(task.key) : undefined }
      const [lead, partner] = await Promise.all([
        this.premiumCall(duo.leadAdapter, task, input, callContext(worktree.path, leadLogs), round),
        this.premiumCall(duo.partnerAdapter, task, partnerInput, callContext(sibling.path, partnerLogs), round),
      ])
      if (partner.sessionId) this.duoPartnerSessions.set(task.key, partner.sessionId)
      // a cancelled run must not continue with the side that happened to finish
      if (signal.aborted) throw new CancelledError()
      const sides = [
        { adapter: duo.leadAdapter, outcome: lead, path: worktree.path, sideLogs: leadLogs },
        { adapter: duo.partnerAdapter, outcome: partner, path: sibling.path, sideLogs: partnerLogs },
      ] as const
      for (const side of sides) {
        logs.push(...side.sideLogs.map((line) => `[${side.adapter.displayName}] ${line}`))
        logs.push(side.outcome.ok ? `[${side.adapter.displayName}] Summary: ${side.outcome.summary}` : `[${side.adapter.displayName}] Error (${side.outcome.kind}): ${side.outcome.message}`)
        if (side.outcome.ok) this.event('info', 'duo_proposal', `${task.key}: ${side.adapter.displayName}: ${(side.outcome.summary ?? '').slice(0, 300)}`, { provider: side.adapter.id, phase: 'execute', summary: (side.outcome.summary ?? '').slice(0, 300) }, task.id)
      }
      const usage = { inputTokens: lead.usage.inputTokens + partner.usage.inputTokens, outputTokens: lead.usage.outputTokens + partner.usage.outputTokens, tokensMeasured: lead.usage.measured && partner.usage.measured }

      for (const side of sides) {
        if (side.outcome.ok || !side.outcome.blocking) continue
        this.duoBlockedSides.set(side.adapter.id, `${side.adapter.displayName}: ${(side.outcome.kind ?? 'process_failed').replace(/_/g, ' ')}`)
      }
      if (!lead.ok && !partner.ok) {
        if (lead.blocking && partner.blocking) this.blockPremium(duo.displayName, lead, task)
        else for (const side of sides) if (side.outcome.blocking) this.duoSideBlockedEvent(side.adapter, side.outcome, task)
        return { hardFailure: true, timedOut: lead.kind === 'timeout', error: `${lead.kind}: ${lead.message}`, ...usage, sessionId: undefined, summary: undefined }
      }
      for (const side of sides) {
        if (!side.outcome.ok && side.outcome.blocking) this.duoSideBlockedEvent(side.adapter, side.outcome, task)
      }

      const leadDiff = lead.ok ? await workingDiff(worktree.path) : ''
      const partnerDiff = partner.ok ? await workingDiff(sibling.path) : ''
      const changed = (diff: string) => diff.trim() !== '' && diff !== carried
      let winner: 'lead' | 'partner'
      let reason: string
      let fallback: string | undefined
      if (!lead.ok || !partner.ok) {
        winner = lead.ok ? 'lead' : 'partner'
        const failed = lead.ok ? sides[1] : sides[0]
        fallback = `${failed.adapter.displayName} ist fehlgeschlagen (${failed.outcome.kind}); es gilt das Ergebnis von ${sides[winner === 'lead' ? 0 : 1].adapter.displayName}.`
        reason = fallback
      } else if (changed(leadDiff) !== changed(partnerDiff)) {
        winner = changed(leadDiff) ? 'lead' : 'partner'
        reason = `Nur ${sides[winner === 'lead' ? 0 : 1].adapter.displayName} hat Dateien geändert.`
      } else if (!changed(leadDiff)) {
        winner = 'lead'
        reason = 'Keiner der beiden hat Dateien geändert.'
      } else {
        const leadReport = await this.validate(worktree.path, signal)
        const partnerReport = await this.validate(sibling.path, signal)
        const order = compareValidation(leadReport, partnerReport)
        if (order !== 0) {
          winner = order < 0 ? 'lead' : 'partner'
          const winnerReport = winner === 'lead' ? leadReport : partnerReport
          reason = `Bessere Prüfergebnisse: ${winnerReport.summary.slice(0, 200)}`
        } else {
          const choice = await this.chooseExecution(duo, task, worktree.path, signal, [
            { label: duo.leadAdapter.displayName, diff: leadDiff, summary: lead.summary ?? '', validation: leadReport.summary },
            { label: duo.partnerAdapter.displayName, diff: partnerDiff, summary: partner.summary ?? '', validation: partnerReport.summary },
          ])
          winner = choice.winner
          reason = choice.reason
        }
      }

      // The task worktree gets exactly the winner's change: validation may have left build output behind, and a
      // failed lead may have left partial edits.
      const winnerSide = sides[winner === 'lead' ? 0 : 1]
      const winnerDiff = winner === 'lead' ? leadDiff : partnerDiff
      if (winner === 'partner' || changed(leadDiff)) {
        await worktrees.reset(worktree.path, head)
        if (winnerDiff.trim()) {
          const applied = await applyPatch(worktree.path, winnerDiff)
          if (!applied.ok) {
            const error = `the change of ${winnerSide.adapter.displayName} could not be applied to the task worktree (${applied.message.slice(0, 300)})`
            this.event('error', 'duo_apply_failed', `${task.key}: ${error}`, undefined, task.id)
            return { hardFailure: true, timedOut: false, error, ...usage, sessionId: undefined, summary: undefined }
          }
        }
      }
      this.event('info', 'duo_reconciled', `${task.key}: ${winnerSide.adapter.displayName} gewinnt – ${reason}`, { phase: 'execute', winner: winnerSide.adapter.id, notes: [reason], ...(fallback ? { fallback } : {}) }, task.id)
      logs.push(`Duo: ${winnerSide.adapter.displayName} gewinnt – ${reason}`)
      return { hardFailure: false, timedOut: false, error: undefined, ...usage, sessionId: lead.sessionId, summary: winnerSide.outcome.summary }
    } finally {
      await worktrees.remove(this.run.repoPath, sibling.path, sibling.branch).catch(() => undefined)
    }
  }

  /** Tie between two green executions: the lead picks; without an answer the lead's change wins. */
  private async chooseExecution(duo: DuoOrchestrator, task: EngineTask, cwd: string, signal: AbortSignal, candidates: Array<{ label: string; diff: string; summary: string; validation: string }>): Promise<{ winner: 'lead' | 'partner'; reason: string }> {
    const choose = duo.leadAdapter.structuredCall
    if (!choose) return { winner: 'lead', reason: `Gleichstand; ${duo.leadAdapter.displayName} entscheidet als Lead.` }
    const started = Date.now()
    try {
      const call = await choose.call(
        duo.leadAdapter,
        { prompt: chooseExecutionPrompt({ taskId: task.key, title: task.title, instructions: task.description, acceptanceCriteria: task.acceptanceCriteria }, candidates), schema: CHOOSE_SCHEMA },
        { runId: `${this.run.id}:${task.key}`, cwd, signal, timeoutMs: Math.min(this.deps.settings.taskTimeoutMs, 5 * 60_000), effort: 'low', onEvent: (event) => this.forwardOrchestratorEvent(event, task, []) },
      )
      const choice = normalizeWithMeta(call.meta, () => normalizeChoice(call.result))
      await this.recordOrchestratorCall(duo.leadAdapter.id, { taskId: task.id, purpose: 'duo_choose', status: 'ok', durationMs: call.meta.durationMs, meta: call.meta })
      return { winner: choice.winner === 'A' ? 'lead' : 'partner', reason: `Gleichstand, ${duo.leadAdapter.displayName} wählt: ${choice.reason || (choice.winner === 'A' ? candidates[0]!.label : candidates[1]!.label)}` }
    } catch (error) {
      if (signal.aborted) throw new CancelledError()
      const kind = error instanceof OrchestratorError ? error.kind : 'process_failed'
      const meta = error instanceof OrchestratorError ? error.details.meta : undefined
      await this.recordOrchestratorCall(duo.leadAdapter.id, { taskId: task.id, purpose: 'duo_choose', status: 'error', errorClass: kind, durationMs: Date.now() - started, meta })
      return { winner: 'lead', reason: `Gleichstand; die Auswahl ist fehlgeschlagen (${kind}), es gilt die Änderung von ${duo.leadAdapter.displayName}.` }
    }
  }

  /** Books one orchestrator request: one ModelCall per duo part (with its own provider), else one for the call. */
  private async recordOrchestratorCall(provider: string, call: { taskId?: string; purpose: ModelCallRecord['purpose']; status: 'ok' | 'error'; errorClass?: string; durationMs: number; meta?: CallMeta }) {
    for (const entry of bookableCalls(provider, call.meta, call.status, call.errorClass)) {
      await this.deps.store.recordModelCall({
        runId: this.run.id,
        ...(call.taskId !== undefined ? { taskId: call.taskId } : {}),
        kind: 'orchestrator',
        provider: entry.provider,
        model: entry.meta?.model ?? entry.provider,
        purpose: call.purpose,
        status: entry.status,
        ...(entry.status === 'error' ? { errorClass: entry.errorClass } : {}),
        sessionId: entry.meta?.sessionId,
        durationMs: entry.durationMs ?? call.durationMs,
        usage: entry.meta?.usage ?? NO_USAGE,
      })
    }
  }

  /**
   * Restores the last failed local attempt in the worktree and asks the orchestrator for a repair hint.
   * Returns the hint only when it is actionable; undefined means: go straight to premium execution.
   */
  private async prepareHintRound(task: EngineTask, worktree: WorktreeHandle, startHead: string, failed: FailedAttempt | undefined, signal: AbortSignal): Promise<RepairHint | undefined> {
    if (!failed || this.premiumBlockedReason || signal.aborted) return undefined
    // the orchestrator advises on exactly the files the local model will repair: base + the failed attempt
    await this.deps.worktrees.reset(worktree.path, startHead)
    if (failed.diff.trim()) {
      const applied = await applyPatch(worktree.path, failed.diff)
      if (!applied.ok) {
        this.event('warn', 'premium_hint_skipped', `${task.key}: the failed attempt could not be restored for a repair hint (${applied.message.slice(0, 200)}).`, undefined, task.id)
        return undefined
      }
    }
    const hint = await this.requestRepairHint(task, worktree, failed, signal)
    if (!hint) return undefined
    if (hint.confidence === 'low' || !hint.edits.length) {
      this.event('info', 'premium_hint_skipped', `${task.key}: premium repair hint not actionable (confidence ${hint.confidence}, ${hint.edits.length} edit(s)). ${hint.diagnosis.slice(0, 300)}`, { diagnosis: hint.diagnosis, confidence: hint.confidence }, task.id)
      return undefined
    }
    this.event('info', 'premium_hint', `${task.key}: premium repair hint (confidence ${hint.confidence}, ${hint.edits.length} edit(s)): ${hint.diagnosis.slice(0, 600)}`, { diagnosis: hint.diagnosis, confidence: hint.confidence, files: [...new Set(hint.edits.map((edit) => edit.file))] }, task.id)
    return hint
  }

  private async requestRepairHint(task: EngineTask, worktree: WorktreeHandle, failed: FailedAttempt, signal: AbortSignal): Promise<RepairHint | undefined> {
    const orchestrator = this.deps.orchestrator!
    const started = Date.now()
    this.event('info', 'premium_hint_requested', `${task.key}: asking ${orchestrator.displayName} for a repair hint before premium execution.`, undefined, task.id)
    try {
      const { result, meta } = await orchestrator.repairHint!(
        {
          taskId: task.key,
          title: task.title,
          instructions: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          files: [...task.relevantFiles, ...task.newFiles],
          diff: failed.diff,
          failures: failed.failures,
        },
        {
          runId: `${this.run.id}:${task.key}:hint`,
          cwd: worktree.path,
          signal,
          timeoutMs: Math.min(this.deps.settings.taskTimeoutMs, 10 * 60_000),
          effort: 'medium',
          onEvent: (event) => this.forwardOrchestratorEvent(event, task, []),
        },
      )
      await this.recordOrchestratorCall(orchestrator.id, { taskId: task.id, purpose: 'repair_hint', status: 'ok', durationMs: meta.durationMs, meta })
      return result
    } catch (error) {
      if (signal.aborted) throw new CancelledError()
      const kind = error instanceof OrchestratorError ? error.kind : 'process_failed'
      const message = error instanceof Error ? error.message : String(error)
      // a completed call whose output was rejected still used the quota
      const meta = error instanceof OrchestratorError ? error.details.meta : undefined
      await this.recordOrchestratorCall(orchestrator.id, { taskId: task.id, purpose: 'repair_hint', status: 'error', errorClass: kind, durationMs: Date.now() - started, meta })
      if (BLOCKING_KINDS.includes(kind)) {
        this.premiumBlockedReason = `${orchestrator.displayName}: ${kind.replace(/_/g, ' ')}`
        this.event('error', 'premium_blocked', `${this.premiumBlockedReason}. Premium execution disabled for this run. ${message.slice(0, 300)}`, { kind }, task.id)
      } else {
        this.event('warn', 'premium_hint_failed', `${task.key}: repair hint failed (${kind}): ${message.slice(0, 300)}`, { kind }, task.id)
      }
      return undefined
    }
  }

  private forwardOrchestratorEvent(event: OrchestratorEvent, task: EngineTask | undefined, logs: string[]) {
    if (event.type === 'duo_proposal' || event.type === 'duo_reconciled') {
      // duo milestones (review, repair hint) become their own engine events for the chat
      const { type, ...data } = event
      const message = event.type === 'duo_proposal' ? `${event.provider} (${event.phase}): ${event.summary}` : `${event.phase}: ${[event.fallback, ...event.notes].filter(Boolean).join(' ') || `winner ${event.winner ?? '–'}`}`
      logs.push(`Duo ${message}`)
      this.event('info', type, message.slice(0, 1000), data, task?.id)
      return
    }
    if (event.type === 'text') logs.push(event.text.slice(0, 2000))
    if (event.type === 'tool') logs.push(`${event.name} ${event.detail}`)
    if (event.type === 'file_change') logs.push(`changed ${event.path}`)
    if (event.type === 'command') logs.push(`$ ${event.command} (exit ${event.exitCode ?? '?'})`)
    const level = event.type === 'error' ? 'warn' : 'debug'
    const message = event.type === 'text' ? event.text.slice(0, 500) : event.type === 'rate_limit' ? `rate limit ${event.info.status}${event.info.resetsAt ? ` (resets ${event.info.resetsAt})` : ''}` : JSON.stringify(event).slice(0, 500)
    this.event(level, `orchestrator_${event.type}`, message, event.type === 'rate_limit' ? { ...event.info } : undefined, task?.id)
  }

  /** Deterministic correction: run the project's formatter / eslint --fix on changed files, then re-validate. */
  private async deterministicFix(worktreePath: string, report: ValidationReport, patch: PatchValidationResult, task: EngineTask): Promise<{ report: ValidationReport } | undefined> {
    const lintFailed = report.results.some((result) => result.kind === 'lint' && result.status === 'failed')
    const blockingFailed = report.results.some((result) => result.blocking && result.status === 'failed' && result.kind !== 'lint')
    if (!lintFailed || blockingFailed) return undefined
    const files = patch.files.filter((file) => file.status !== 'D').map((file) => file.path).filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|json|md)$/.test(file))
    if (!files.length) return undefined
    let ran = false
    for (const [tool, args] of [['prettier', ['--write', ...files]], ['eslint', ['--fix', ...files]]] as const) {
      const local = path.join(worktreePath, 'node_modules', '.bin', process.platform === 'win32' ? `${tool}.cmd` : tool)
      const result = await runProcess(local, [...args], { cwd: worktreePath, env: sanitizedEnv(), timeoutMs: 120_000 })
      if (!result.spawnError) ran = true
    }
    if (!ran) return undefined
    const commit = await commitIfChanged(worktreePath, `${task.key}: deterministic formatting`)
    if (!commit) return undefined
    this.event('info', 'deterministic_fix', `${task.key}: applied formatter/eslint --fix without a model call.`, undefined, task.id)
    const rerun = await this.validate(worktreePath)
    return { report: rerun }
  }

  /** Runs the project checks; a check that already fails on the run's base commit only blocks when the change adds failures. */
  private async validate(cwd: string, signal?: AbortSignal, onOutput?: RunChecksOptions['onOutput']): Promise<ValidationReport> {
    const { settings } = this.deps
    const report = await runValidationChecks(cwd, this.deps.checks, { signal, onOutput, allowProjectCode: settings.allowProjectCode, approvedCommands: settings.approvedCommands })
    if (report.ok) return report
    const baseline = await this.baselineReport()
    return baseline ? againstBaseline(report, baseline) : report
  }

  /** Validation of the run's base commit in its own worktree – computed once, on the first failing check. */
  private baselineReport(): Promise<ValidationReport | undefined> {
    this.baseline ??= (async () => {
      const { worktrees, settings } = this.deps
      const runKey = short(this.run.id)
      const worktree = await worktrees.create(this.run.repoPath, { projectKey: this.run.projectKey, name: `${runKey}-baseline`, branch: `mac/${runKey}/baseline`, baseCommit: this.run.baseCommit! })
      try {
        const report = await runValidationChecks(worktree.path, this.deps.checks, { signal: this.signal, allowProjectCode: settings.allowProjectCode, approvedCommands: settings.approvedCommands })
        const failing = baselineFailures(report)
        if (failing.length) {
          const hint = failing.some((result) => /playwright install/i.test(result.output)) ? ' Playwright browsers are missing: run "npx playwright install" in the project.' : ''
          this.event('warn', 'baseline_failing', `Already failing before any change: ${failing.map((result) => `${result.kind} (${result.command})`).join(', ')}. These checks only block a task that adds failures.${hint}`, { checks: failing.map((result) => result.id) })
        }
        return report
      } finally {
        await worktrees.remove(this.run.repoPath, worktree.path, worktree.branch).catch(() => undefined)
      }
    })().catch((error: unknown) => {
      this.event('warn', 'baseline_unavailable', `Could not validate the base commit: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
    return this.baseline
  }

  private async finalize(failedTasks: string[]): Promise<{ ok: boolean; validation: ValidationReport; review: ReviewSummary; patch: PatchValidationResult }> {
    const { store, settings } = this.deps
    const integration = this.integrationWorktree!
    let head = (await headCommit(integration.path))!
    let validation = await this.validate(integration.path, this.signal)
    let patch = await validatePatch(integration.path, this.run.baseCommit!, head, { ...this.patchPolicyAll(), allowEmpty: false })
    let review = await this.review(validation, patch, failedTasks)

    // One bounded fix round when the reviewer found blockers.
    if (review.result && review.result.verdict !== 'approve' && review.result.issues.some((issue) => issue.severity === 'blocker') && settings.reviewFixRounds > 0 && !this.signal.aborted) {
      const fixTask: EngineTask = {
        // Synthetic task: '' means "not a planned subtask" for the store.
        id: '',
        key: 'review-fix',
        title: 'Address review findings',
        description: `Fix the following review findings in the integrated change set:\n${review.result.requiredFixes.map((fix) => `- ${fix}`).join('\n')}\n${review.result.issues.filter((issue) => issue.severity === 'blocker').map((issue) => `- [${issue.file}] ${issue.message}`).join('\n')}`,
        category: 'bugfix',
        complexity: 3,
        risk: 3,
        relevantFiles: [...new Set(review.result.issues.map((issue) => issue.file).filter(Boolean))],
        newFiles: [],
        dependsOn: [],
        acceptanceCriteria: review.result.requiredFixes,
        expectedInputTokens: 6000,
        suggestedExecutor: 'premium',
        priority: 0,
        status: 'planned',
      }
      this.event('info', 'review_fix_started', `Review requested changes; running one fix round (${review.result.requiredFixes.length} item(s)).`)
      // explicit delegation: the store is usually a class instance whose methods live on the
      // prototype, so an object spread would drop them (→ "store.emit is not a function")
      const fixStore: EngineStore = {
        updateRun: (runId, patch) => store.updateRun(runId, patch),
        updateTask: async () => undefined,
        startAttempt: (input) => store.startAttempt(input),
        finishAttempt: (attemptId, input) => store.finishAttempt(attemptId, input),
        recordModelCall: (call) => store.recordModelCall(call),
        emit: (event) => store.emit(event),
      }
      const runner = new ExecutionRunner(this.run, [fixTask], { ...this.deps, store: fixStore })
      runner.integrationWorktree = integration
      runner.baseline = this.baseline
      runner.decisions.set('review-fix', runner.route(fixTask))
      const outcome = await runner.executeTask(fixTask, this.signal)
      if (outcome === 'succeeded') {
        head = (await headCommit(integration.path))!
        validation = await this.validate(integration.path, this.signal)
        patch = await validatePatch(integration.path, this.run.baseCommit!, head, { ...this.patchPolicyAll(), allowEmpty: false })
        review = await this.review(validation, patch, failedTasks, true)
      } else {
        this.event('warn', 'review_fix_failed', 'The review fix round did not produce a validated change; findings stay open for the user.')
      }
    }

    const ok = patch.ok && validation.ok
    await store.updateRun(this.run.id, {
      status: ok ? 'awaiting_approval' : 'failed',
      integrationCommit: head,
      finalDiff: patch.diff.slice(0, 2_000_000),
      finalValidation: validation,
      review,
      summary: `${this.tasks.length - failedTasks.length}/${this.tasks.length} task(s) integrated; ${patch.files.length} file(s), +${patch.linesAdded}/-${patch.linesDeleted}. Validation: ${validation.summary}`,
      errorMessage: ok ? (failedTasks.length ? `Tasks not integrated: ${failedTasks.join(', ')}` : null) : [patch.issues.filter((issue) => issue.severity === 'blocking').map((issue) => issue.message).join('; '), !validation.ok ? `Final validation failed: ${validation.summary}` : ''].filter(Boolean).join('; '),
    })
    this.event(ok ? 'info' : 'error', 'run_ready', ok ? 'Run finished; waiting for approval.' : 'Final validation failed.')
    return { ok, validation, review, patch }
  }

  private patchPolicyAll(): PatchPolicy {
    return { allowedPatterns: [], deniedPatterns: DEFAULT_DENIED_PATTERNS, strictScope: false, maxFiles: 200, maxFileBytes: 512 * 1024 }
  }

  private async review(validation: ValidationReport, patch: PatchValidationResult, failedTasks: string[], afterFix = false): Promise<ReviewSummary> {
    const deterministicIssues = [
      ...patch.issues.map((issue) => `${issue.severity}: ${issue.message}${issue.file ? ` (${issue.file})` : ''}`),
      ...validation.results.filter((result) => result.status !== 'passed').map((result) => `${result.kind} ${result.status}${result.reason ? `: ${result.reason}` : ''}`),
      ...failedTasks.map((key) => `task ${key} was not integrated`),
    ]
    const riskReasons: string[] = []
    if (patch.securityCritical.length) riskReasons.push(`security-critical files: ${patch.securityCritical.slice(0, 5).join(', ')}`)
    if (this.tasks.some((task) => task.risk >= 4)) riskReasons.push('a task has risk ≥ 4')
    if (patch.linesAdded + patch.linesDeleted > 400) riskReasons.push(`large change (${patch.linesAdded + patch.linesDeleted} lines)`)
    if (!validation.ok) riskReasons.push('final validation failed')
    if (!validation.results.some((result) => result.kind === 'test' && result.status === 'passed')) riskReasons.push('no passing test run')
    if (this.deps.settings.costMode === 'quality') riskReasons.push('quality mode')

    const policy = this.deps.settings.premiumReviewPolicy
    // The decision is based on deterministic signals only, never on the agents' self-assessment.
    const needsPremium = policy === 'always' || (policy === 'risk_based' && riskReasons.length > 0)
    if (!needsPremium) {
      return { kind: 'deterministic', reason: policy === 'never' ? 'Premium review disabled in settings.' : 'Low-risk change with passing validation: automated review only.', deterministicIssues, requiresHumanApproval: true }
    }
    if (!this.deps.orchestrator || this.premiumBlockedReason) {
      return { kind: 'human_required', reason: `Premium review required (${riskReasons.join('; ')}) but no orchestrator is available${this.premiumBlockedReason ? ` (${this.premiumBlockedReason})` : ''}. Review the diff carefully.`, deterministicIssues, requiresHumanApproval: true }
    }
    const started = Date.now()
    try {
      const { result, meta } = await this.deps.orchestrator.reviewResult(
        {
          goal: this.run.goal,
          tasks: this.tasks.map((task) => ({ id: task.key, title: task.title, status: task.status, executor: this.decisions.get(task.key)?.executor === 'premium' ? 'premium' : this.decisions.get(task.key)?.model ?? 'unknown', testsPassed: validation.testsPassed, testsFailed: validation.testsFailed })),
          diff: patch.diff,
          validationSummary: validation.summary,
          riskFlags: [...riskReasons, ...deterministicIssues.slice(0, 10)],
        },
        { runId: this.run.id, cwd: this.integrationWorktree!.path, signal: this.signal, timeoutMs: 10 * 60_000, effort: patch.securityCritical.length ? 'high' : 'medium', onEvent: (event) => this.forwardOrchestratorEvent(event, undefined, []) },
      )
      await this.recordOrchestratorCall(this.deps.orchestrator.id, { purpose: afterFix ? 'review_fix' : 'review', status: 'ok', durationMs: meta.durationMs, meta })
      this.event('info', 'review_done', `Premium review: ${result.verdict} (${result.score}/100). ${result.summary}`)
      return { kind: 'premium', reason: `Premium review because: ${riskReasons.join('; ')}.`, result, deterministicIssues, requiresHumanApproval: true }
    } catch (error) {
      const kind = error instanceof OrchestratorError ? error.kind : 'process_failed'
      // a completed review whose output was rejected still used the quota
      const meta = error instanceof OrchestratorError ? error.details.meta : undefined
      await this.recordOrchestratorCall(this.deps.orchestrator.id, { purpose: afterFix ? 'review_fix' : 'review', status: 'error', errorClass: kind, durationMs: Date.now() - started, meta })
      return { kind: 'human_required', reason: `Premium review failed (${kind}): ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`, deterministicIssues, requiresHumanApproval: true }
    }
  }

  private async cleanupTaskWorktrees() {
    const managed = await this.deps.worktrees.listManaged(this.run.repoPath).catch(() => [])
    const prefix = `mac/${short(this.run.id)}/`
    for (const entry of managed) {
      if (entry.branch?.startsWith(prefix) && !entry.branch.endsWith('/integration')) {
        await this.deps.worktrees.remove(this.run.repoPath, entry.path, entry.branch).catch(() => undefined)
      }
    }
  }
}

class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

/** Stages and commits all changes in a worktree; returns the commit or undefined when nothing changed. */
export async function commitIfChanged(worktreePath: string, message: string): Promise<string | undefined> {
  await stageAll(worktreePath)
  if (!(await hasStagedChanges(worktreePath))) return undefined
  return commitStaged(worktreePath, message)
}

/** Uncommitted change of a worktree against its HEAD (new files included, dependency links excluded); the index is left unstaged. */
export async function workingDiff(worktreePath: string): Promise<string> {
  await stageAll(worktreePath)
  try {
    return (await git(worktreePath, ['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', 'HEAD', '--', '.', ...DEPENDENCY_DIR_EXCLUDES], { internal: true })).stdout
  } finally {
    await git(worktreePath, ['reset', '-q'], { internal: true, allowFailure: true })
  }
}

const failedChecks = (report: ValidationReport) => report.results.filter((result) => result.blocking && result.status !== 'passed' && result.status !== 'skipped' && !result.preexisting).length
const typeErrors = (report: ValidationReport) => report.results.filter((result) => result.kind === 'typecheck' && result.status === 'failed').reduce((sum, result) => sum + (result.errorCount ?? 1), 0)

/** Duo execution: < 0 when `first` validated better, > 0 when `second` did, 0 on a tie. */
export function compareValidation(first: ValidationReport, second: ValidationReport): number {
  const rank = (report: ValidationReport) => [report.ok ? 0 : 1, report.testsFailed, failedChecks(report), typeErrors(report)]
  const a = rank(first)
  const b = rank(second)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return 0
}

const REMOVAL_TASK =/\b(remove|delete|drop|strip|clean ?up|entfern\w*|lösch\w*|streich\w*|aufräum\w*)\b/i

/**
 * Detects an attempt that only removed code (e.g. an import replaced by a lone ";") although the task
 * asks for an implementation. Returns the reason, or undefined when the change has substance.
 */
export function hollowChange(diff: string, taskText: string): string | undefined {
  if (REMOVAL_TASK.test(taskText)) return undefined
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    // a line counts when it has at least a few letters/digits, not just punctuation or whitespace
    const substance = line.slice(1).replace(/[^\p{L}\p{N}]/gu, '').length >= 3
    if (line.startsWith('+') && substance) added += 1
    else if (line.startsWith('-') && substance) removed += 1
  }
  return added === 0 && removed > 0 ? `The change only removed code (${removed} line(s)) and added nothing.` : undefined
}

function summarizePatch(patch: PatchValidationResult): string {
  return `${patch.files.length} file(s), +${patch.linesAdded}/-${patch.linesDeleted}: ${patch.files.slice(0, 10).map((file) => `${file.status} ${file.path}`).join(', ')}`
}
