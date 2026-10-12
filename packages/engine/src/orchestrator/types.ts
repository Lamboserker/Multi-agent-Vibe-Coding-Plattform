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

export class OrchestratorError extends Error {
  constructor(
    message: string,
    readonly kind: OrchestratorErrorKind,
    readonly details: { retryable?: boolean; resetsAt?: string; exitCode?: number | null; stderr?: string } = {},
  ) {
    super(message)
    this.name = 'OrchestratorError'
  }

  get retryable(): boolean {
    return this.details.retryable ?? (this.kind === 'timeout' || this.kind === 'process_failed')
  }
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

export interface CallContext {
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
}

export interface RepoContextDigest {
  /** Compact deterministic repository description (stack, structure, scripts, conventions). */
  summary: string
  /** Paths + short symbol outlines of the most relevant files. */
  relevantFiles: Array<{ path: string; outline: string; excerpt?: string }>
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
}

export interface ExecutionResult {
  summary: string
  filesChanged: string[]
  commandsRun: string[]
  sessionId?: string
}

export interface ChatInput {
  question: string
  context: RepoContextDigest
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
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
  reviewResult(input: ReviewInput, ctx: CallContext): Promise<{ result: ReviewResult; meta: CallMeta }>
  executeComplexTask(input: ExecutionInput, ctx: CallContext): Promise<{ result: ExecutionResult; meta: CallMeta }>
  chat(input: ChatInput, ctx: CallContext): Promise<{ result: { answer: string }; meta: CallMeta }>
  cancelRun(runId: string): Promise<void>
}
