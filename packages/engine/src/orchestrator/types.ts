export type OrchestratorId = 'claude-code' | 'codex'

export type OrchestratorErrorKind =
  | 'not_installed'
  | 'not_authenticated'
  | 'session_expired'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'model_unavailable'
  | 'timeout'
  | 'cancelled'
  | 'invalid_output'
  | 'process_failed'
  | 'resource_limit'
  | 'needs_clarification'

export class OrchestratorError extends Error {
  constructor(
    message: string,
    readonly kind: OrchestratorErrorKind,
    /** `meta`: usage of a call that completed but whose output was rejected (e.g. needs_clarification) – it still used the quota. */
    readonly details: { retryable?: boolean; resetsAt?: string; exitCode?: number | null; stderr?: string; questions?: string[]; meta?: CallMeta } = {},
  ) {
    super(message)
    this.name = 'OrchestratorError'
  }

  get retryable(): boolean {
    return this.details.retryable ?? (this.kind === 'timeout' || this.kind === 'process_failed')
  }
}

/** Runs `normalize` on a completed call's output; an OrchestratorError it throws carries the call's meta so the tokens can still be booked. */
export function normalizeWithMeta<T>(meta: CallMeta, normalize: () => T): T {
  try {
    return normalize()
  } catch (error) {
    if (error instanceof OrchestratorError && !error.details.meta) {
      const withMeta = new OrchestratorError(error.message, error.kind, { ...error.details, meta })
      // keep the throw site inside the normalizer for diagnostics
      withMeta.stack = error.stack
      throw withMeta
    }
    throw error
  }
}

/** Sums two calls that served one request (a discarded first attempt and its retry). */
export function mergeCallMeta(first: CallMeta | undefined, second: CallMeta): CallMeta {
  if (!first) return second
  const cost = first.usage.apiEquivalentUsd === undefined && second.usage.apiEquivalentUsd === undefined ? undefined : (first.usage.apiEquivalentUsd ?? 0) + (second.usage.apiEquivalentUsd ?? 0)
  return {
    ...second,
    model: second.model ?? first.model,
    durationMs: first.durationMs + second.durationMs,
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      cachedInputTokens: first.usage.cachedInputTokens + second.usage.cachedInputTokens,
      measured: first.usage.measured && second.usage.measured,
      apiEquivalentUsd: cost,
      billing: second.usage.billing,
    },
  }
}

/** Returns `error` carrying `meta` so a caller can book the tokens; `meta` counts as the earlier call, merged with the error's own meta (whose session/billing win). */
export function withErrorMeta(error: unknown, meta: CallMeta | undefined): unknown {
  if (!meta || !(error instanceof OrchestratorError)) return error
  const withMeta = new OrchestratorError(error.message, error.kind, { ...error.details, meta: error.details.meta ? mergeCallMeta(meta, error.details.meta) : meta })
  withMeta.stack = error.stack
  return withMeta
}

export interface RuntimeDetection {
  installed: boolean
  binary?: string
  version?: string
  installHint: { docsUrl: string; commands: Array<{ label: string; command: string[] }> }
}

export interface ConnectionStatus {
  orchestrator: OrchestratorId
  installed: boolean
  version?: string
  authenticated: boolean
  /** e.g. "claude.ai (pro)" or "ChatGPT". */
  authMethod?: string
  account?: string
  /** True when the CLI would bill an API key instead of a subscription. */
  usesApiKeyBilling: boolean
  checkedAt: string
  message: string
  rateLimit?: RateLimitInfo
}

export interface RateLimitInfo {
  status: string
  window?: string
  resetsAt?: string
  observedAt: string
}

export interface ConnectionResult {
  status: 'already_connected' | 'login_required' | 'needs_install' | 'failed'
  /** Official login command; the desktop app runs it in a visible terminal so the user completes the browser flow. */
  loginCommand?: string[]
  message: string
}

export interface OrchestratorCapabilities {
  structuredOutput: boolean
  streaming: boolean
  sessionResume: boolean
  fileEditing: boolean
  /** How file edits by the premium agent are isolated. */
  sandbox: string
  models: Array<{ id: string; label: string; default?: boolean }>
  /** Typical fixed prompt overhead per call (measured), useful for cost routing. */
  typicalOverheadTokens?: number
}

export interface DiagnosticCheck {
  name: string
  ok: boolean
  detail: string
}

export interface DiagnosticReport {
  orchestrator: OrchestratorId
  ok: boolean
  checks: DiagnosticCheck[]
}

export interface UsageReport {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  /** Tokens come from the CLI's own usage report. */
  measured: boolean
  /** API-list-price equivalent reported by the CLI (not billed under a subscription). */
  apiEquivalentUsd?: number
  billing: 'subscription' | 'api_key' | 'unknown'
}

export type OrchestratorEvent =
  | { type: 'session'; sessionId: string; model?: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'file_change'; path: string; kind: string }
  | { type: 'command'; command: string; exitCode?: number | null }
  | { type: 'rate_limit'; info: RateLimitInfo }
  | { type: 'usage'; usage: UsageReport }
  | { type: 'error'; message: string }
  /** Duo mode: one side's own result of a phase (before reconciliation). */
  | { type: 'duo_proposal'; provider: OrchestratorId; phase: DuoPhase; summary: string }
  /** Duo mode: both results of a phase were reconciled (or one side's result was used). */
  | { type: 'duo_reconciled'; phase: DuoPhase; notes: string[]; winner?: OrchestratorId | 'merged'; fallback?: string }

export interface CallContext {
  /** Hard per-call limits. CLIs must reject unsupported limits before invoking the model. */
  limits?: { maxContextTokens?: number; maxOutputTokens?: number }
  /** Session-scoped, policy-filtered MCP gateway. No upstream credentials enter the CLI. */
  mcpGateway?: { url: string }
  mcpRole?: string
  mcpServers?: string[]
  /** Identifies the process so cancelRun(runId) can stop it. */
  runId: string
  signal?: AbortSignal
  onEvent?: (event: OrchestratorEvent) => void
  timeoutMs?: number
  /** Working directory (repository or worktree). */
  cwd: string
  effort?: 'low' | 'medium' | 'high'
}

export interface CallMeta {
  sessionId?: string
  model?: string
  usage: UsageReport
  durationMs: number
  /**
   * Duo mode: the single calls that served this request (each booked as its own ModelCall with its
   * provider). The top-level usage/duration is their sum; without parts the meta is one call.
   */
  parts?: CallMetaPart[]
  /** Duo mode: what both orchestrators proposed and how it was reconciled (for chat milestones). */
  duo?: DuoInfo
}

export type DuoRole = 'lead' | 'partner' | 'reconcile' | 'choose'
export type DuoPhase = 'plan' | 'design' | 'review' | 'repair_hint' | 'chat' | 'execute'

/** One call of a duo request. `status` is the call's own outcome (one side may fail while the request succeeds). */
export interface CallMetaPart extends Omit<CallMeta, 'parts' | 'duo'> {
  provider: OrchestratorId
  role: DuoRole
  status: 'ok' | 'error'
  errorClass?: string
}

export interface DuoInfo {
  phase: DuoPhase
  lead: OrchestratorId
  partner: OrchestratorId
  /** Short summary of each side's own result (only sides that answered). */
  proposals: Array<{ provider: OrchestratorId; summary: string }>
  /** Reconciliation notes (from the lead's reconcile call or the deterministic merge). */
  notes: string[]
  /** Whose result was used: one provider, or 'merged' when both results were combined. */
  winner?: OrchestratorId | 'merged'
  /** Set when only one side's result could be used (the other failed); shown to the user as a hint. */
  fallback?: string
}

/**
 * Booking units of one orchestrator request: one entry per duo part, otherwise the request itself.
 * `durationMs` is only set for parts (a single call keeps the caller's own duration semantics).
 */
export function bookableCalls(provider: string, meta: CallMeta | undefined, status: 'ok' | 'error', errorClass?: string): Array<{ provider: string; status: 'ok' | 'error'; errorClass?: string; meta?: CallMeta; durationMs?: number }> {
  if (!meta?.parts?.length) return [{ provider, status, errorClass, meta }]
  return meta.parts.map(({ provider: partProvider, role: _role, status: partStatus, errorClass: partError, ...call }) => ({
    provider: partProvider,
    status: partStatus,
    errorClass: partStatus === 'error' ? partError ?? errorClass : undefined,
    meta: call,
    durationMs: call.durationMs,
  }))
}

export interface RepoContextDigest {
  /** Compact deterministic repository description (stack, structure, scripts, conventions). */
  summary: string
  /** Paths + short symbol outlines of the most relevant files. */
  relevantFiles: Array<{ path: string; outline: string; excerpt?: string; /** The excerpt is the whole file. */ complete?: boolean }>
  validationCommands: string[]
}

export interface AnalysisInput {
  goal: string
  context: RepoContextDigest
}

export interface TaskAnalysis {
  summary: string
  taskType: string
  complexity: number
  risk: number
  securitySensitive: boolean
  affectedAreas: string[]
  needsDecomposition: boolean
  openQuestions: string[]
}

export interface LocalModelOffer {
  role: string
  model: string
  toolCalling: boolean
  strengths: string[]
}

export interface PlanningInput {
  goal: string
  context: RepoContextDigest
  costMode: 'cheapest' | 'balanced' | 'quality'
  localModels: LocalModelOffer[]
  maxTasks: number
  feedback?: string
  /** Enabled coder agent profiles the planner may assign tasks to. */
  agents?: AgentOffer[]
  /** Active skills the planner may attach to tasks; `requested` = the user named it in the request. */
  skills?: SkillOffer[]
  /** The approved design draft the plan has to build on. */
  design?: DesignBrief
}

export interface AgentOffer {
  name: string
  description: string
  categories: string[]
  skills: string[]
}

export interface SkillOffer {
  name: string
  description: string
  requested: boolean
}

export interface PlannedTask {
  id: string
  title: string
  description: string
  category: string
  complexity: number
  risk: number
  relevantFiles: string[]
  newFiles: string[]
  dependsOn: string[]
  capabilities: string[]
  expectedInputTokens: number
  testStrategy: string
  acceptanceCriteria: string[]
  suggestedExecutor: 'local' | 'premium'
  rationale: string
  /** Name of the agent profile that should execute the task; '' = choose automatically. */
  agent: string
  /** Names of the skills the executing agent needs for this task. */
  skills: string[]
}

export interface ExecutionPlan {
  summary: string
  analysis: TaskAnalysis
  tasks: PlannedTask[]
  warnings: string[]
}

export interface ReviewInput {
  goal: string
  tasks: Array<{ id: string; title: string; status: string; executor: string; testsPassed: number; testsFailed: number }>
  diff: string
  validationSummary: string
  riskFlags: string[]
}

export interface ReviewIssue {
  severity: 'blocker' | 'major' | 'minor'
  file: string
  message: string
}

export interface ReviewResult {
  verdict: 'approve' | 'request_changes' | 'reject'
  score: number
  summary: string
  issues: ReviewIssue[]
  requiredFixes: string[]
}

export interface ExecutionInput {
  taskId: string
  title: string
  instructions: string
  acceptanceCriteria: string[]
  relevantFiles: string[]
  /** Errors from previous attempts (validation output, failing tests) for repair runs. */
  previousFailures?: string
  resumeSessionId?: string
  /** The agent role and the skills relevant for the task (same guidance local agents get). */
  guidance?: string
}

export interface ExecutionResult {
  summary: string
  filesChanged: string[]
  commandsRun: string[]
  sessionId?: string
}

/** Failed local attempt handed to the orchestrator for advice ("premium advises, local executes"). */
export interface RepairHintInput {
  taskId: string
  title: string
  /** Task description as planned (the instruction the local model got). */
  instructions: string
  acceptanceCriteria: string[]
  /** Files the task may touch (relevant + new). */
  files: string[]
  /** Diff of the last failed attempt against the task's base commit ('' if nothing was written). */
  diff: string
  /** Compact output of the failing checks or the rejection reason. */
  failures: string
}

export interface RepairHintEdit {
  file: string
  /** Exact text in the current file ('' = the file does not exist yet; replace is its full content). */
  find: string
  replace: string
  note: string
}

export interface RepairHint {
  diagnosis: string
  edits: RepairHintEdit[]
  confidence: 'high' | 'medium' | 'low'
}

export interface ChatInput {
  question: string
  context: RepoContextDigest
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  /**
   * CLI session of an earlier answer in the same conversation. When set, only the question is sent
   * (the session already holds the repository context and history); if the session cannot be
   * resumed, the adapter falls back to a full prompt.
   */
  resumeSessionId?: string
  /** Duo mode: the partner's own CLI session of an earlier answer (`resumeSessionId` belongs to the lead). */
  partnerResumeSessionId?: string
}

export interface ChatResult {
  answer: string
  /** Duo mode: the partner's answer, shown next to the lead's. */
  duo?: { partner: OrchestratorId; partnerAnswer: string }
}

/** A free structured call (no tools, read-only) – used by the duo orchestrator to reconcile two results. */
export interface StructuredRequest {
  prompt: string
  schema: Record<string, unknown>
  /** Replaces the default orchestrator system prompt (e.g. the designer prompt). */
  systemPrompt?: string
}

/** Common contract for premium orchestrators (Claude Code, Codex). */
export interface OrchestratorAdapter {
  readonly id: OrchestratorId
  readonly displayName: string
  detect(): Promise<RuntimeDetection>
  capabilities(): Promise<OrchestratorCapabilities>
  connect(): Promise<ConnectionResult>
  getStatus(): Promise<ConnectionStatus>
  logout(): Promise<void>
  diagnose(options?: { liveCall?: boolean; cwd?: string }): Promise<DiagnosticReport>
  analyzeTask(input: AnalysisInput, ctx: CallContext): Promise<{ result: TaskAnalysis; meta: CallMeta }>
  createPlan(input: PlanningInput, ctx: CallContext): Promise<{ result: ExecutionPlan; meta: CallMeta }>
  /** Optional: plugin orchestrators may not support the design phase. */
  createDesign?(input: DesignInput, ctx: CallContext): Promise<{ result: DesignDraft; meta: CallMeta }>
  reviewResult(input: ReviewInput, ctx: CallContext): Promise<{ result: ReviewResult; meta: CallMeta }>
  /** Optional: precise "old → new" repair instructions for a failed local attempt (read-only, no edits). */
  repairHint?(input: RepairHintInput, ctx: CallContext): Promise<{ result: RepairHint; meta: CallMeta }>
  executeComplexTask(input: ExecutionInput, ctx: CallContext): Promise<{ result: ExecutionResult; meta: CallMeta }>
  chat(input: ChatInput, ctx: CallContext): Promise<{ result: ChatResult; meta: CallMeta }>
  /** Optional: one structured answer to a free prompt (no tools). Without it the duo lead cannot reconcile and its own result is used. */
  structuredCall?(request: StructuredRequest, ctx: CallContext): Promise<{ result: unknown; meta: CallMeta }>
  cancelRun(runId: string): Promise<void>
}

export type DesignMode = 'auto' | 'force' | 'skip'

export const DESIGN_TYPES = ['dashboard', 'crm', 'landing-page', 'saas-app', 'admin-forms', 'ecommerce', 'other'] as const
export type DesignType = (typeof DESIGN_TYPES)[number]

export const DESIGN_TOKEN_GROUPS = ['color', 'typography', 'spacing', 'radius', 'shadow', 'motion'] as const

export interface DesignToken {
  /** CSS custom property, e.g. `--accent`. */
  name: string
  value: string
  /** Dark-mode value; '' = same as the light value. */
  darkValue: string
  group: (typeof DESIGN_TOKEN_GROUPS)[number]
}

export interface DesignComponent {
  name: string
  purpose: string
  /** Suggested repo path; '' = the planner decides. */
  file: string
  /** Precise build spec for a small model (markup structure, classes, states, tokens). */
  spec: string
  tokens: string[]
}

export interface DesignScreen {
  name: string
  route: string
  layout: string
  /** Names of the components the screen uses. */
  components: string[]
}

export interface DesignDraft {
  summary: string
  designType: DesignType
  direction: string
  tokens: DesignToken[]
  components: DesignComponent[]
  screens: DesignScreen[]
  /** One self-contained HTML document (sanitized); '' = no preview. */
  mockupHtml: string
  questions: string[]
}

/** The approved part of a draft that planning and executors build on. */
export type DesignBrief = Omit<DesignDraft, 'mockupHtml' | 'questions'>

export interface DesignInput {
  goal: string
  context: RepoContextDigest
  /** Inline text of the design skills. */
  skills?: string
  skillCatalog?: Array<{ name: string; description: string }>
  feedback?: string
  previous?: DesignBrief
  provider: OrchestratorId
}
