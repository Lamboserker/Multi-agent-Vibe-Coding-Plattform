import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma.service.js'
import { asJson } from '../common/json.js'
import { AsyncMutex } from '../common/locks.js'
import { EventBusService } from './event-bus.service.js'

export type OrchestratorChoice = 'claude-code' | 'codex'
export type ApprovalMode = 'manual' | 'auto_branch' | 'auto_working_tree'

export interface AppSettings {
  orchestrator: OrchestratorChoice | null
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
  maxTasks: number
  maxLocalRepairs: number
  maxEscalationSteps: number
  reviewFixRounds: number
  localParallelism: number | 'auto'
  premiumParallelism: number
  ollamaBaseUrl: string
  /** Model storage used when Multi-AI Coder starts Ollama itself (OLLAMA_MODELS). null = Ollama default. */
  ollamaModelsDir: string | null
  numCtx: number
  taskTimeoutMinutes: number
  modelRoles: { fast: string | null; balanced: string | null; advanced: string | null }
  allowProjectCode: boolean
  approvedCommands: string[]
  strictScope: boolean
  gpuWatts: number | null
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

export const DEFAULT_SETTINGS: AppSettings = {
  orchestrator: null,
  claudeModel: '',
  codexModel: '',
  orchestratorAuthMode: 'subscription',
  costMode: 'balanced',
  approvalMode: 'manual',
  premiumExecutionAllowed: true,
  premiumReviewPolicy: 'risk_based',
  planApproval: true,
  maxTasks: 8,
  maxLocalRepairs: 2,
  maxEscalationSteps: 2,
  reviewFixRounds: 1,
  localParallelism: 'auto',
  premiumParallelism: 1,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
  ollamaModelsDir: null,
  numCtx: 16_384,
  taskTimeoutMinutes: 20,
  modelRoles: { fast: null, balanced: null, advanced: null },
  allowProjectCode: true,
  approvedCommands: [],
  strictScope: false,
  gpuWatts: null,
  premiumPriceOverride: null,
  onboarding: { completed: false, steps: {} },
  lastProjectId: null,
  modelSelfTests: {},
}

const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_SETTINGS))
/** Row that stores the monotonically increasing settings version. */
const VERSION_KEY = '__version'

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
  return next
}

export type VersionedSettings = AppSettings & { version: number }

@Injectable()
export class SettingsService {
  private cache?: AppSettings
  private version = 0
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
      this.cache = mergeSettings(DEFAULT_SETTINGS, stored as Partial<AppSettings>)
      return this.cache
    })
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
      const changed = Object.keys(patch).filter((key) => ALLOWED_KEYS.has(key) && JSON.stringify((next as unknown as Record<string, unknown>)[key]) !== JSON.stringify((current as unknown as Record<string, unknown>)[key]))
      if (!changed.length) return { settings: current, version: this.version, changed }
      const version = this.version + 1
      await this.prisma.$transaction([
        ...changed.map((key) => {
          const value = asJson((next as unknown as Record<string, unknown>)[key])
          return this.prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
        }),
        this.prisma.appSetting.upsert({ where: { key: VERSION_KEY }, create: { key: VERSION_KEY, value: version }, update: { value: version } }),
      ])
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
