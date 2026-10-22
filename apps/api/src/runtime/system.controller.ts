import { BadRequestException, Body, Controller, Get, MessageEvent, Patch, Post, Query, Sse } from '@nestjs/common'
import { filter, map, type Observable } from 'rxjs'
import { gitVersion } from '@multi-ai-coder/engine'
import { str, bool } from '../common/validate.js'
import { EventBusService, type EventChannel } from './event-bus.service.js'
import { JobQueueService } from './job-queue.service.js'
import { DiagnosticsService } from './diagnostics.service.js'
import { runtimeConfig } from './runtime-config.js'
import { SettingsService, type AppSettings } from './settings.service.js'

export const SETTINGS_VALIDATORS: Partial<Record<keyof AppSettings, (value: unknown) => boolean>> = {
  languageServers: (value) => Array.isArray(value) && value.length <= 20 && value.every((entry) => entry && typeof entry.command === 'string' && Array.isArray(entry.args) && entry.args.every((arg: unknown) => typeof arg === 'string') && Array.isArray(entry.extensions) && entry.extensions.every((ext: unknown) => typeof ext === 'string' && /^[a-z0-9]+$/i.test(ext)) && typeof entry.languageId === 'string'),
  orchestrator: (value) => value === null || value === 'claude-code' || value === 'codex',
  orchestratorMode: (value) => value === 'single' || value === 'duo',
  duoLead: (value) => value === 'claude-code' || value === 'codex',
  claudeModel: (value) => typeof value === 'string' && /^[\w.:-]{0,80}$/.test(value),
  codexModel: (value) => typeof value === 'string' && /^[\w.:-]{0,80}$/.test(value),
  orchestratorAuthMode: (value) => value === 'subscription' || value === 'api_key',
  costMode: (value) => value === 'cheapest' || value === 'balanced' || value === 'quality',
  approvalMode: (value) => value === 'manual' || value === 'auto_branch' || value === 'auto_working_tree' || value === 'auto_commit',
  premiumExecutionAllowed: (value) => typeof value === 'boolean',
  premiumReviewPolicy: (value) => value === 'risk_based' || value === 'always' || value === 'never',
  planApproval: (value) => typeof value === 'boolean',
  autoStartSmallPlans: (value) => typeof value === 'boolean',
  maxTasks: (value) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 20,
  maxLocalRepairs: (value) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 4,
  maxEscalationSteps: (value) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3,
  reviewFixRounds: (value) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 2,
  premiumHints: (value) => typeof value === 'boolean',
  localParallelism: (value) => value === 'auto' || (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 4),
  premiumParallelism: (value) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 3,
  ollamaBaseUrl: (value) => typeof value === 'string' && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/?$/.test(value),
  // local instances only, like ollamaBaseUrl
  extraOllamaUrls: (value) => Array.isArray(value) && value.length <= 4 && value.every((entry) => typeof entry === 'string' && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/?$/.test(entry)),
  ollamaModelsDir: (value) => value === null || (typeof value === 'string' && value.length < 1000 && /^([a-zA-Z]:[\\/]|\/)/.test(value) && !value.includes('\0')),
  numCtx: (value) => Number.isInteger(value) && Number(value) >= 2048 && Number(value) <= 262_144,
  modelWarmup: (value) => typeof value === 'boolean',
  fastPath: (value) => typeof value === 'boolean',
  formatOnSave: (value) => typeof value === 'boolean',
  keepAliveMinutes: (value) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 240,
  unloadAfterRun: (value) => typeof value === 'boolean',
  taskTimeoutMinutes: (value) => Number.isInteger(value) && Number(value) >= 2 && Number(value) <= 120,
  allowProjectCode: (value) => typeof value === 'boolean',
  approvedCommands: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length < 300),
  strictScope: (value) => typeof value === 'boolean',
  gpuWatts: (value) => value === null || (typeof value === 'number' && value > 0 && value < 2000),
  electricity: (value) => {
    if (value === null) return true
    if (!value || typeof value !== 'object') return false
    const tariff = value as Record<string, unknown>
    const watts = (entry: unknown) => entry === undefined || entry === null || (typeof entry === 'number' && entry >= 0 && entry < 5000)
    return typeof tariff.pricePerKwh === 'number' && tariff.pricePerKwh >= 0 && tariff.pricePerKwh < 10
      && typeof tariff.basePricePerMonth === 'number' && tariff.basePricePerMonth >= 0 && tariff.basePricePerMonth < 1000
      && watts(tariff.systemBaseWatts) && watts(tariff.cpuMaxWatts)
      && Object.keys(tariff).every((key) => ['pricePerKwh', 'basePricePerMonth', 'systemBaseWatts', 'cpuMaxWatts'].includes(key))
  },
  premiumPriceOverride: (value) =>
    value === null ||
    (typeof value === 'object' && typeof (value as Record<string, unknown>).inputPerMillion === 'number' && typeof (value as Record<string, unknown>).outputPerMillion === 'number' && typeof (value as Record<string, unknown>).source === 'string'),
  lastProjectId: (value) => value === null || typeof value === 'string',
}

@Controller()
export class SystemController {
  constructor(
    private readonly settings: SettingsService,
    private readonly events: EventBusService,
    private readonly jobs: JobQueueService,
    private readonly diagnostics: DiagnosticsService,
  ) {}

  /** Performance and health snapshot (diagnostics view, exportable; contains no secrets). */
  @Get('system/diagnostics')
  diagnosticsSnapshot() {
    return this.diagnostics.collect()
  }

  @Get('system/health')
  health() {
    return { ok: true, pid: process.pid, uptimeSec: Math.round(process.uptime()) }
  }

  @Get('system/info')
  async info() {
    const config = runtimeConfig()
    return {
      desktop: config.desktop,
      dataDir: config.dataDir,
      worktreesDir: config.worktreesDir,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      git: await gitVersion(),
      isolation: {
        worktrees: 'All agent changes happen in separate git worktrees outside your checkout.',
        localAgents: 'Local models can only use the validated file tool layer (no shell). File access is restricted to the task scope; secrets are blocked.',
        commands: 'Validation commands run with an allowlist and a secret-free environment inside the worktree. This is policy isolation, not an OS sandbox.',
        osSandbox: process.platform === 'win32' ? 'not available (Windows): validation runs as your user inside the worktree' : 'not enforced by the app; Codex uses its own OS sandbox for premium execution',
      },
    }
  }

  /** Settings plus their version; clients use the version to ignore out-of-order responses. */
  @Get('settings')
  getSettings() {
    return this.settings.getVersioned()
  }

  @Patch('settings')
  async updateSettings(@Body() body: Record<string, unknown>) {
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body ?? {})) {
      const validator = SETTINGS_VALIDATORS[key as keyof AppSettings]
      if (!validator) continue
      if (!validator(value)) throw new BadRequestException(`Invalid value for setting "${key}".`)
      patch[key] = value
    }
    const result = await this.settings.updateVersioned(patch as Partial<AppSettings>, 'user')
    return { ...result.settings, version: result.version }
  }

  @Post('onboarding/step')
  async onboardingStep(@Body() body: unknown) {
    const result = await this.settings.markOnboardingStep(str(body, 'step', { max: 40 }), bool(body, 'ok'), str(body, 'detail', { optional: true, max: 2000 }) || undefined)
    return { ...result.settings, version: result.version }
  }

  @Post('onboarding/complete')
  async completeOnboarding() {
    const result = await this.settings.updateVersioned({ onboarding: { completed: true } as AppSettings['onboarding'] }, 'user')
    return { ...result.settings, version: result.version }
  }

  @Get('system/jobs')
  jobsList(@Query('type') type?: string, @Query('active') active?: string) {
    return this.jobs.list(50, { type: type || undefined, active: active === '1' })
  }

  /** Server-Sent Events: live run/model/orchestrator updates. */
  @Sse('events')
  stream(@Query('channels') channels?: string): Observable<MessageEvent> {
    const allowed = channels ? new Set(channels.split(',') as EventChannel[]) : undefined
    return this.events.stream().pipe(
      filter((event) => !allowed || allowed.has(event.channel)),
      map((event) => ({ data: event }) as MessageEvent),
    )
  }
}
