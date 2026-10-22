import { Injectable } from '@nestjs/common'
import type { ElectricityTariff } from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { asJson } from '../common/json.js'
import { AsyncMutex } from '../common/locks.js'
import { EventBusService } from './event-bus.service.js'

export type OrchestratorChoice = 'claude-code' | 'codex'
/** single = one premium orchestrator; duo = Claude Code and Codex in parallel with reconciliation (ADR-004). */
export type OrchestratorMode = 'single' | 'duo'
/** auto_commit: a validated result is committed onto the checked-out branch (e.g. main) without asking. */
export type ApprovalMode = 'manual' | 'auto_branch' | 'auto_working_tree' | 'auto_commit'

export interface AppSettings {
  languageServers: Array<{ command: string; args: string[]; extensions: string[]; languageId: string }>
  pluginExtensions: Record<string, { plugin: string; id: string } | null>
  orchestrator: OrchestratorChoice | null
  /** duo: both CLIs work on every phase (needs both installed and signed in; else single with a chat hint). */
  orchestratorMode: OrchestratorMode
  /** Duo mode: who reconciles both results and owns the chat session. */
  duoLead: OrchestratorChoice
  claudeModel: string
  codexModel: string
  /** Prompt prefix authentication: never switch to API billing unless explicitly chosen. */
  orchestratorAuthMode: 'subscription' | 'api_key'
  costMode: 'cheapest' | 'balanced' | 'quality'
  /** manual = user approves every integration; auto_* only after passing validation and review. */
  approvalMode: ApprovalMode
  premiumExecutionAllowed: boolean
  premiumReviewPolicy: 'risk_based' | 'always' | 'never'
  /** Ask the user to approve the plan before execution starts. */
  planApproval: boolean
  /** With planApproval: small, low-risk plans (see isSmallSafePlan) start without asking. */
  autoStartSmallPlans: boolean
  maxTasks: number
  maxLocalRepairs: number
  maxEscalationSteps: number
  reviewFixRounds: number
  /** Premium returns repair edits for a failed local attempt before executing the task itself. */
  premiumHints: boolean
  localParallelism: number | 'auto'
  premiumParallelism: number
  ollamaBaseUrl: string
  /** Further local Ollama instances whose loaded models the resource monitor shows (read-only). */
  extraOllamaUrls: string[]
  /** Model storage used when Multi-AI Coder starts Ollama itself (OLLAMA_MODELS). null = Ollama default. */
  ollamaModelsDir: string | null
  numCtx: number
  /** Load the planned local models in the background before the first agent call (memory permitting). */
  modelWarmup: boolean
  /** Small, unambiguous requests run without premium planning (see engine fastpath). */
  fastPath: boolean
  /** Format with the project's Prettier before saving (only when Prettier is installed). */
  formatOnSave: boolean
  /** How long Ollama keeps a local model loaded after its last use. */
  keepAliveMinutes: number
  /** Unload the local models of a run when it ends (unless another active run still uses them). */
  unloadAfterRun: boolean
  taskTimeoutMinutes: number
  modelRoles: { fast: string | null; balanced: string | null; advanced: string | null }
  allowProjectCode: boolean
  approvedCommands: string[]
  strictScope: boolean
  gpuWatts: number | null
  /** Electricity tariff for the energy costs (unit price per kWh, monthly base price, own estimates). */
  electricity: ElectricityTariff | null
  premiumPriceOverride: { inputPerMillion: number; outputPerMillion: number; source: string } | null
  onboarding: { completed: boolean; steps: Record<string, { ok: boolean; at: string; detail?: string }> }
  lastProjectId: string | null
  modelSelfTests: Record<string, ModelSelfTest>
}

export interface ModelSelfTest {
  at: string
  ok: boolean
  /** Result of a real tool-call round trip (not the template claim). */
  /** verified = native tool_calls; text_format = calls written as JSON text (recovered by the agent). */
  toolCalling: 'verified' | 'text_format' | 'failed' | 'not_supported'
  structuredOutput: boolean
  tokensPerSecond?: number
  loadMs?: number
  sampleOutput?: string
  error?: string
}

const DEFAULT_OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'

/**
 * The other well-known local instance: the system Ollama listens on :11434, the instance Multi-AI Coder
 * starts with its own model folder usually on :11435. Other ports have no known partner.
 */
export function defaultExtraOllamaUrls(baseUrl: string): string[] {
  try {
    const url = new URL(baseUrl)
    const other = url.port === '11434' ? '11435' : url.port === '11435' ? '11434' : undefined
    return other ? [`${url.protocol}//${url.hostname}:${other}`] : []
  } catch {
    return []
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  languageServers: [],
  pluginExtensions: {},
  orchestrator: null,
  orchestratorMode: 'single',
  duoLead: 'claude-code',
  claudeModel: '',
  codexModel: '',
  orchestratorAuthMode: 'subscription',
  costMode: 'balanced',
  approvalMode: 'auto_commit',
  premiumExecutionAllowed: true,
  premiumReviewPolicy: 'risk_based',
  planApproval: true,
  autoStartSmallPlans: true,
  maxTasks: 12,
  maxLocalRepairs: 2,
  maxEscalationSteps: 2,
  reviewFixRounds: 1,
  premiumHints: true,
  localParallelism: 'auto',
  premiumParallelism: 1,
  ollamaBaseUrl: DEFAULT_OLLAMA_URL,
  extraOllamaUrls: defaultExtraOllamaUrls(DEFAULT_OLLAMA_URL),
  ollamaModelsDir: null,
  numCtx: 16_384,
  modelWarmup: true,
  fastPath: true,
  formatOnSave: false,
  keepAliveMinutes: 15,
  unloadAfterRun: true,
  taskTimeoutMinutes: 20,
  modelRoles: { fast: null, balanced: null, advanced: null },
  allowProjectCode: true,
  approvedCommands: [],
  strictScope: false,
  gpuWatts: null,
  electricity: null,
  premiumPriceOverride: null,
  onboarding: { completed: false, steps: {} },
  lastProjectId: null,
  modelSelfTests: {},
}

const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_SETTINGS))
/** Row that stores the monotonically increasing settings version. */
const VERSION_KEY = '__version'
/** Marker row: existing installations were switched to approvalMode auto_commit once. */
const AUTO_COMMIT_MIGRATION_KEY = '__migration_auto_commit'

/**
 * Patch semantics for object-valued settings. A patch only names the entries it changes, so a caller
 * holding an outdated copy can never reset entries written by someone else in the meantime
 * (e.g. a model self-test finishing while the user completes onboarding).
 * `null` as an entry value removes the entry (modelSelfTests) or clears it (modelRoles).
 */
export function mergeSettings(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...current }
  for (const [key, value] of Object.entries(patch) as Array<[keyof AppSettings, unknown]>) {
    if (!ALLOWED_KEYS.has(key) || value === undefined) continue
    if (key === 'onboarding') {
      const incoming = (value ?? {}) as Partial<AppSettings['onboarding']>
      next.onboarding = {
        completed: incoming.completed ?? current.onboarding.completed,
        steps: { ...current.onboarding.steps, ...(incoming.steps ?? {}) },
      }
    } else if (key === 'modelRoles') {
      next.modelRoles = { ...current.modelRoles, ...((value ?? {}) as Partial<AppSettings['modelRoles']>) }
    } else if (key === 'modelSelfTests') {
      const merged: Record<string, ModelSelfTest> = { ...current.modelSelfTests }
      for (const [model, result] of Object.entries((value ?? {}) as Record<string, ModelSelfTest | null>)) {
        if (result === null) delete merged[model]
        else merged[model] = result
      }
      next.modelSelfTests = merged
    } else {
      ;(next as unknown as Record<string, unknown>)[key] = value
    }
  }
  // the default partner instance follows a changed base URL; an explicitly chosen list stays
  if (patch.ollamaBaseUrl !== undefined && patch.extraOllamaUrls === undefined && JSON.stringify(current.extraOllamaUrls) === JSON.stringify(defaultExtraOllamaUrls(current.ollamaBaseUrl))) {
    next.extraOllamaUrls = defaultExtraOllamaUrls(next.ollamaBaseUrl)
  }
  return next
}

export type VersionedSettings = AppSettings & { version: number }

@Injectable()
export class SettingsService {
  private cache?: AppSettings
  private version = 0
  /** The one-time auto_commit migration is applied in memory but not yet stored. */
  private migrationPending = false
  private readonly mutex = new AsyncMutex()

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
  ) {}

  async get(): Promise<AppSettings> {
    if (this.cache) return this.cache
    return this.mutex.run(async () => {
      if (this.cache) return this.cache
      const rows = await this.prisma.appSetting.findMany()
      const stored: Record<string, unknown> = {}
      for (const row of rows) {
        if (row.key === VERSION_KEY) this.version = Number(row.value) || 0
        else if (ALLOWED_KEYS.has(row.key)) stored[row.key] = row.value
      }
      // one-time switch of existing installations to the new default (results are committed onto main);
      // a mode chosen after this migration is kept
      // (get() may run inside someone else's transaction: the write is not awaited here, and until it
      // landed every settings update writes the migration along)
      if (!rows.some((row) => row.key === AUTO_COMMIT_MIGRATION_KEY)) {
        if (stored.approvalMode !== undefined && stored.approvalMode !== 'auto_commit') stored.approvalMode = 'auto_commit'
        this.migrationPending = true
        // queued behind this load and before any update (same mutex): it writes the value current then
        void this.mutex
          .run(async () => {
            if (!this.migrationPending) return
            await this.prisma.$transaction(this.migrationWrites(this.cache!.approvalMode))
            this.migrationPending = false
          })
          .catch(() => undefined)
      }
      this.cache = mergeSettings(DEFAULT_SETTINGS, stored as Partial<AppSettings>)
      return this.cache
    })
  }

  /** Rows of the one-time auto_commit migration (approvalMode as it is now, plus the marker). */
  private migrationWrites(approvalMode: ApprovalMode) {
    return [
      this.prisma.appSetting.upsert({ where: { key: 'approvalMode' }, create: { key: 'approvalMode', value: approvalMode }, update: { value: approvalMode } }),
      this.prisma.appSetting.upsert({ where: { key: AUTO_COMMIT_MIGRATION_KEY }, create: { key: AUTO_COMMIT_MIGRATION_KEY, value: true }, update: { value: true } }),
    ]
  }

  async getVersioned(): Promise<VersionedSettings> {
    const settings = await this.get()
    return { ...settings, version: this.version }
  }

  /**
   * Applies a patch atomically: all keys and the new version are written in one transaction, under a
   * mutex so concurrent callers never lose each other's changes. The returned version lets clients
   * discard responses that arrive out of order.
   */
  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    return (await this.updateVersioned(patch)).settings
  }

  async updateVersioned(patch: Partial<AppSettings>, source = 'runtime'): Promise<{ settings: AppSettings; version: number; changed: string[] }> {
    await this.get()
    return this.mutex.run(async () => {
      const current = this.cache!
      const next = mergeSettings(current, patch)
      const changed = [...new Set([...Object.keys(patch), 'extraOllamaUrls'])].filter((key) => ALLOWED_KEYS.has(key) && JSON.stringify((next as unknown as Record<string, unknown>)[key]) !== JSON.stringify((current as unknown as Record<string, unknown>)[key]))
      if (!changed.length) return { settings: current, version: this.version, changed }
      const version = this.version + 1
      await this.prisma.$transaction([
        ...changed.map((key) => {
          const value = asJson((next as unknown as Record<string, unknown>)[key])
          return this.prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
        }),
        this.prisma.appSetting.upsert({ where: { key: VERSION_KEY }, create: { key: VERSION_KEY, value: version }, update: { value: version } }),
        ...(this.migrationPending ? this.migrationWrites(next.approvalMode) : []),
      ])
      this.migrationPending = false
      // The cache only changes after the transaction committed.
      this.cache = next
      this.version = version
      this.events.publish('system', 'settings_changed', { version, keys: changed, source })
      return { settings: next, version, changed }
    })
  }

  async markOnboardingStep(step: string, ok: boolean, detail?: string) {
    // Only the step is sent: "completed" is left to whoever owns it (merge semantics, see mergeSettings).
    return this.updateVersioned({ onboarding: { steps: { [step]: { ok, at: new Date().toISOString(), detail } } } as AppSettings['onboarding'] })
  }
}
