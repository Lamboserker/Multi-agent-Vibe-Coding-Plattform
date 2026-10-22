// DTOs returned by the local runtime (subset of the Prisma models + engine types).

export type CostMode = 'cheapest' | 'balanced' | 'quality'
export type ApprovalMode = 'manual' | 'auto_branch' | 'auto_working_tree' | 'auto_commit'
export type OrchestratorId = 'claude-code' | 'codex'
/** single = one premium orchestrator; duo = Claude Code and Codex in parallel with reconciliation. */
export type OrchestratorMode = 'single' | 'duo'
/** Composer choice per request: one CLI or both (duo). */
export type OrchestratorChoice = OrchestratorId | 'duo'
export type LocalRole = 'fast' | 'balanced' | 'advanced'

export interface ModelSelfTest {
  at: string
  ok: boolean
  /** verified = native tool_calls; text_format = calls written as JSON text (recovered by the agent). */
  toolCalling: 'verified' | 'text_format' | 'failed' | 'not_supported'
  structuredOutput: boolean
  tokensPerSecond?: number
  loadMs?: number
  sampleOutput?: string
  error?: string
}

export interface Settings {
  orchestrator: OrchestratorId | null
  orchestratorMode: OrchestratorMode
  duoLead: OrchestratorId
  claudeModel: string
  codexModel: string
  orchestratorAuthMode: 'subscription' | 'api_key'
  costMode: CostMode
  approvalMode: ApprovalMode
  premiumExecutionAllowed: boolean
  premiumReviewPolicy: 'risk_based' | 'always' | 'never'
  planApproval: boolean
  autoStartSmallPlans: boolean
  maxTasks: number
  maxLocalRepairs: number
  maxEscalationSteps: number
  reviewFixRounds: number
  premiumHints: boolean
  localParallelism: number | 'auto'
  premiumParallelism: number
  ollamaBaseUrl: string
  extraOllamaUrls: string[]
  ollamaModelsDir: string | null
  numCtx: number
  modelWarmup: boolean
  keepAliveMinutes: number
  unloadAfterRun: boolean
  fastPath: boolean
  formatOnSave: boolean
  taskTimeoutMinutes: number
  modelRoles: Record<LocalRole, string | null>
  allowProjectCode: boolean
  approvedCommands: string[]
  strictScope: boolean
  gpuWatts: number | null
  electricity: ElectricityTariff | null
  premiumPriceOverride: { inputPerMillion: number; outputPerMillion: number; source: string } | null
  onboarding: { completed: boolean; steps: Record<string, { ok: boolean; at: string; detail?: string }> }
  lastProjectId: string | null
  modelSelfTests: Record<string, ModelSelfTest>
}

export type VersionedSettings = Settings & { version: number }

export type SessionStatus = 'active' | 'idle' | 'running' | 'paused' | 'interrupted' | 'completed' | 'failed' | 'archived'

export interface SessionSummary {
  id: string
  projectId: string
  title: string
  status: SessionStatus
  provider?: string | null
  externalSessionId?: string | null
  pinned: boolean
  archivedAt?: string | null
  lastActivityAt: string
  activeTaskId?: string | null
  createdAt: string
  messageCount?: number
  taskCount?: number
  recovery: { pendingAsk?: { jobId: string; messageId: string }; interruptedAsk?: { messageId: string; at: string } }
}

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[]
  hasMore: boolean
  tasks: Array<{ id: string; title: string; status: string; currentStep: string; createdAt: string; execution: { id: string; status: ExecutionRun['status'] } | null }>
}

export interface Activity {
  executions: Array<{ id: string; status: string; projectId: string; taskId: string; sessionId?: string | null; title: string; startedAt?: string | null }>
  plans: Array<{ taskId: string; projectId: string; sessionId?: string | null; title: string }>
  asks: Array<{ jobId: string; sessionId: string }>
}

export interface Project {
  id: string
  name: string
  repoPath: string
  defaultBranch?: string | null
  lastOpenedAt?: string | null
  isGit?: boolean
  exists?: boolean
  _count?: { tasks: number }
  /** Result of the automatic git setup when the project was opened. */
  repository?: { initialized: boolean; committed: boolean; hasCommit: boolean; skipped?: string; excluded?: string[] }
}

export interface TreeEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  heavy?: boolean
}

export interface FileContent {
  path: string
  binary: boolean
  tooLarge: boolean
  size: number
  mtimeMs: number
  content: string
}

export interface GitStatusEntry {
  path: string
  originalPath?: string
  index: string
  worktree: string
  untracked: boolean
  conflicted: boolean
}

export type GitStatus = { isRepo: false } | { isRepo: true; branch?: string; head?: string; entries: GitStatusEntry[] }

export interface ChatMessage {
  id: string
  taskId?: string | null
  sessionId?: string | null
  clientId?: string | null
  role: 'user' | 'assistant' | 'agent' | 'system'
  content: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface Subtask {
  id: string
  taskId: string
  key: string
  title: string
  goal: string
  status: 'planned' | 'queued' | 'running' | 'validating' | 'repairing' | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'blocked'
  selectedModelClass: string
  selectedModelName?: string | null
  modelReason?: string | null
  manualModel?: string | null
  fastPath?: Record<string, unknown> | null
  agentId?: string | null
  allowedFiles: string[]
  newFiles: string[]
  dependsOn: string[]
  category: string
  complexityScore: number
  riskScore: number
  acceptanceCriteria: string[]
  testStrategy?: string | null
  expectedInputTokens: number
  suggestedExecutor: 'local' | 'premium'
  attempts: number
  commitSha?: string | null
  patchText?: string | null
  patchStats: { files?: Array<{ path: string; status: string; added: number | null; deleted: number | null }>; linesAdded?: number; linesDeleted?: number; securityCritical?: string[]; warnings?: Array<{ code: string; message: string; file?: string }> }
  validation: ValidationReport | Record<string, never>
  errorMessage?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export interface TaskPlan {
  id: string
  summary: string
  source: string
  classification: Record<string, unknown>
  modelAssignments: Array<{ key: string; subtaskId: string; executor: 'local' | 'premium' | 'blocked'; model?: string; tier: string; reasons: string[]; requiresApproval: boolean }>
  dag: { warnings?: string[]; contextTokens?: number; consideredFiles?: number }
  createdAt: string
}

export interface Task {
  id: string
  projectId: string
  userPrompt: string
  normalizedGoal?: string | null
  status: string
  currentStep: string
  createdAt: string
  planning?: { startedAt: string; phase: 'queued' | 'preparing' }
  /** Design phase before planning (auto = only for UI requests). */
  designMode?: DesignMode
  subtasks: Subtask[]
  chatMessages?: ChatMessage[]
  plans?: TaskPlan[]
  executions?: ExecutionRun[]
}

export type DesignMode = 'auto' | 'force' | 'skip'

/** A design draft of a task (GET /tasks/:id/design). `spec` is stored JSON: read it through designView(). */
export interface DesignDraft {
  id: string
  taskId: string
  version: number
  status: 'generating' | 'draft' | 'approved' | 'rejected' | 'failed'
  provider?: string | null
  designType?: string | null
  summary: string
  spec?: unknown
  /** Sanitized server-side (no scripts, no event handlers, no external URLs); '' = no preview. */
  mockupHtml?: string | null
  feedback?: string | null
  createdAt: string
  updatedAt: string
}

export interface CheckResult {
  id: string
  kind: string
  command: string
  status: 'passed' | 'failed' | 'skipped' | 'timeout' | 'error'
  blocking: boolean
  durationMs: number
  testsPassed?: number
  testsFailed?: number
  errorCount?: number
  output: string
  reason?: string
}

export interface ValidationReport {
  ok: boolean
  results: CheckResult[]
  testsPassed: number
  testsFailed: number
  summary: string
}

export interface ReviewSummary {
  kind: 'premium' | 'deterministic' | 'human_required'
  reason: string
  result?: { verdict: 'approve' | 'request_changes' | 'reject'; score: number; summary: string; issues: Array<{ severity: string; file: string; message: string }>; requiredFixes: string[] }
  deterministicIssues: string[]
  requiresHumanApproval: boolean
}

export interface AgentRun {
  id: string
  subtaskId?: string | null
  agentName: string
  selectedModelClass: string
  selectedModelName?: string | null
  runtime?: string | null
  category?: string | null
  repairRound: number
  escalated: boolean
  outcome?: string | null
  status: string
  startedAt?: string | null
  finishedAt?: string | null
  durationMs?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  tokensMeasured: boolean
  logs: string[]
  diffSummary?: string | null
  patchText?: string | null
  patchStatus: string
  validationStatus: string
  validationResults: CheckResult[]
  errorMessage?: string | null
}

export interface ModelCall {
  id: string
  subtaskId?: string | null
  kind: 'orchestrator' | 'local'
  provider: string
  model: string
  purpose: string
  status: string
  errorClass?: string | null
  durationMs: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  tokensMeasured: boolean
  apiEquivalentUsd?: string | null
  billing: string
  peakMemoryMb?: number | null
  createdAt: string
}

export interface ApplyRecord {
  id: string
  mode: 'branch' | 'working_tree' | 'fast_forward' | 'commit'
  files: string[]
  targetBranch?: string | null
  status: string
  message?: string | null
  createdAt: string
  revertedAt?: string | null
}

export interface ExecutionRun {
  id: string
  taskId: string
  projectId: string
  status: 'pending' | 'planning' | 'awaiting_plan_approval' | 'running' | 'paused' | 'integrating' | 'awaiting_approval' | 'applied' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  orchestrator?: string | null
  costMode: string
  approvalMode: string
  baseCommit?: string | null
  integrationBranch?: string | null
  integrationCommit?: string | null
  finalDiff?: string | null
  finalValidation: ValidationReport | Record<string, never>
  review: ReviewSummary | Record<string, never>
  summary?: string | null
  errorMessage?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  createdAt: string
  task?: Task & { plans?: TaskPlan[] }
  agentRuns?: AgentRun[]
  modelCalls?: ModelCall[]
  applyRecords?: ApplyRecord[]
  usage?: UsageSummary
  active?: boolean
}

export interface RunEvent {
  id: string
  subtaskId?: string | null
  level: 'debug' | 'info' | 'warn' | 'error'
  type: string
  message: string
  data: Record<string, unknown>
  createdAt: string
}

export interface UsageSummary {
  premium: {
    calls: number
    failedCalls: number
    byPurpose: Record<string, number>
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    measuredCalls: number
    unmeasuredCalls: number
    apiEquivalentUsd: { value: number; basis: 'reported' | 'mixed' | 'none'; reportedCalls: number }
    durationMs: number
    /** Premium calls per provider (duo: Claude Code and Codex separately). */
    byProvider?: Record<string, { calls: number; failedCalls: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }>
  }
  local: {
    calls: number
    failedCalls: number
    inputTokens: number
    outputTokens: number
    durationMs: number
    peakMemoryMb?: number
    byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; durationMs: number }>
    energyWh?: { value: number; assumptionWatts: number; label: string }
  }
  spend: { actualUsd: number; actualBasis: string }
  baseline?: { label: string; method: string; localTokensAtPremiumPriceUsd: number; effectiveInputPerMillion: number; effectiveOutputPerMillion: number; estimate: true }
  notes: string[]
  subscription?: Array<{ id: string; authMethod?: string; rateLimit?: { status: string; window?: string; resetsAt?: string; observedAt: string } }>
}

export interface ConnectionStatus {
  orchestrator: OrchestratorId
  installed: boolean
  version?: string
  authenticated: boolean
  authMethod?: string
  account?: string
  usesApiKeyBilling: boolean
  checkedAt: string
  message: string
  rateLimit?: { status: string; window?: string; resetsAt?: string; observedAt: string }
}

export interface OrchestratorOverview {
  selected: OrchestratorId | null
  authMode: string
  mode?: OrchestratorMode
  duoLead?: OrchestratorId
  /** CLIs a request can use right now. */
  usable?: OrchestratorId[]
  duo?: { available: boolean; reason?: string }
  orchestrators: Array<{
    id: OrchestratorId
    displayName: string
    status: ConnectionStatus
    detection: { installed: boolean; binary?: string; version?: string; installHint: { docsUrl: string; commands: Array<{ label: string; command: string[] }> } }
  }>
  policy: { apiFallback: string; note: string }
}

export interface DiagnosticReport {
  orchestrator: OrchestratorId
  ok: boolean
  checks: Array<{ name: string; ok: boolean; detail: string }>
}

export interface GpuInfo {
  name: string
  vendor: string
  vramTotalMb?: number
  vramUsedMb?: number
  vramReliable: boolean
  vramSource: string
  driver?: string
}

export interface HardwareProfile {
  os: { platform: string; release: string; arch: string; version?: string }
  cpu: { model: string; physicalCores?: number; logicalCores: number }
  memory: { totalBytes: number; freeBytes: number }
  gpus: GpuInfo[]
  acceleration: string[]
  disks: { appData?: { path: string; freeBytes?: number; totalBytes?: number }; ollamaModels?: { path: string; freeBytes?: number; totalBytes?: number } }
  ollamaModelsDir: string
  detectedAt: string
  warnings: string[]
}

export interface OllamaStatus {
  installed: boolean
  binary?: string
  version?: string
  reachable: boolean
  serverVersion?: string
  baseUrl: string
  installPlan?: { method: string; command?: string[]; manualCommand?: string; downloadUrl: string; requiresAdmin: boolean; explanation: string }
}

export interface InstalledModel {
  name: string
  sizeBytes: number
  family?: string
  parameterSize?: string
  quantization?: string
  capabilities: string[]
  contextLength?: number
  loaded: boolean
  vramBytes?: number
  roles: LocalRole[]
  selfTest?: ModelSelfTest
}

export interface ModelRecommendation {
  model: string
  family: string
  license: string
  notes: string
  downloadBytes: number
  estimatedMemoryBytes: number
  fit: 'gpu' | 'partial_offload' | 'cpu' | 'too_large'
  fitExplanation: string
  diskOk: boolean
  toolCalling: 'verified' | 'template' | 'unknown' | 'none'
  roles: LocalRole[]
  recommended: boolean
  completionOnly: boolean
}

export interface SuitabilityStats {
  model: string
  category: string
  attempts: number
  successes: number
  failures: number
  repairRate: number
  escalationRate: number
  avgDurationMs: number
  successRate: number
  lowerBound: number
  confidence: 'insufficient_data' | 'low' | 'medium' | 'high'
}

// ---------------------------------------------------------------------------
// Resource monitor (GET /system/resources)
// ---------------------------------------------------------------------------

export interface ResourceWarning {
  code: string
  severity: 'info' | 'warn' | 'error'
  message: string
  model?: string
}

export interface ResourceModel {
  name: string
  sizeBytes: number
  vramBytes: number
  gpuShare: number
  contextLength?: number
  expiresAt?: string
  agents: string[]
  /** app = the instance Multi-AI Coder works with; external = another local Ollama instance. */
  instance: 'app' | 'external'
  baseUrl: string
  state: 'generating' | 'idle' | 'external'
  unloadsInSec: number | null
}

export interface ResourceSnapshot {
  at: string
  /** Time of the sample (ms) and the sampling cadence of the runtime. */
  sampledAt: number
  intervalMs: number
  cpu: { pct: number; model: string; logicalCores: number; physicalCores?: number }
  ram: { usedBytes: number; totalBytes: number }
  gpu?: { name: string; utilizationPct?: number; vramUsedMb?: number; vramTotalMb?: number; temperatureC?: number; powerW?: number; powerLimitW?: number; source: 'nvidia-smi' | 'ollama' | 'none' }
  disk?: { path: string; freeBytes?: number; totalBytes?: number }
  history: Array<{ at: string; cpuPct: number; ramUsedBytes: number; gpuPct?: number; vramUsedMb?: number }>
  ollama: { reachable: boolean }
  models: ResourceModel[]
  /** VRAM of the app instance's models and of everything else on the card (GB; null without a VRAM figure). */
  vram: { appModelsGb: number; otherGb: number | null }
  slots: { local: number; premium: number; busyLocal: number; busyPremium: number }
  waiting: Array<{ key: string; title: string; model?: string; reason: string }>
  warnings: ResourceWarning[]
}

// ---------------------------------------------------------------------------
// Execution forecast (GET /tasks/:id/forecast)
// ---------------------------------------------------------------------------

export type ForecastReason = 'ready' | 'running' | 'done' | 'dependencies' | 'file_conflict' | 'local_slot' | 'premium_slot' | 'memory' | 'blocked'

export interface ScheduleForecast {
  waves: Array<{ index: number; tasks: string[]; localModels: string[]; memoryBytes: number; fitsVram?: boolean; durationMs: number }>
  tasks: Record<string, { wave?: number; reason: ForecastReason; waitsFor: string[]; detail: string; startsAtMs?: number; critical: boolean }>
  criticalPath: string[]
  estimatedMs: number
  maxParallel: number
  warnings: string[]
  slots: { local: number; premium: number }
  vramBytes: number | null
  measuredDurations: number
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Electricity (GET /system/energy)
// ---------------------------------------------------------------------------

export interface ElectricityTariff {
  /** € per kWh */
  pricePerKwh: number
  /** € per month */
  basePricePerMonth: number
  systemBaseWatts?: number | null
  cpuMaxWatts?: number | null
}

export interface EnergySummary {
  kWh: number
  inferenceKWh: number
  hours: number
  energyCost: number | null
  baseCost: number | null
  totalCost: number | null
  days: number
}

export interface EnergyStatus {
  at: string
  live: { gpuW?: number; gpuSource: 'nvidia-smi' | 'setting' | 'none'; systemW?: number; systemSource: 'estimate' | 'none'; totalW: number; inferenceActive: boolean; costPerHour: { energy: number; base: number; total: number } | null }
  tariff: ElectricityTariff | null
  today: EnergySummary
  period: EnergySummary
  daily: Array<{ date: string; kWh: number; inferenceKWh: number; hours: number; energyCost: number | null }>
  measuringSince: string | null
  sampleIntervalMs: number
}
