import { Injectable, Logger, Optional } from '@nestjs/common'
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  type ConnectionStatus,
  type OrchestratorAdapter,
  type OrchestratorId,
  type RuntimeDetection,
  type CallContext,
  ANALYSIS_SCHEMA,
  CHAT_SCHEMA,
  EXECUTION_SUMMARY_SCHEMA,
  normalizeAnalysis,
  normalizePlan,
  normalizeReview,
  OrchestratorError,
  PLAN_SCHEMA,
  REVIEW_SCHEMA,
} from '@multi-ai-coder/engine'
import { McpService } from '../mcp/mcp.service.js'
import { openMcpGateway } from '../mcp/mcp-gateway.js'
import type { AgentRole } from '../skills/skills.service.js'
import { EventBusService } from '../runtime/event-bus.service.js'
import { SettingsService } from '../runtime/settings.service.js'
import { PluginsService } from '../plugins/plugins.service.js'

const IDS: OrchestratorId[] = ['claude-code', 'codex']

function normalizeExecution(raw: unknown) {
  const value = (raw ?? {}) as { summary?: unknown; filesChanged?: unknown; commandsRun?: unknown }
  const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [])
  if (typeof value.summary !== 'string') throw new OrchestratorError('Plugin orchestrator returned no execution summary.', 'invalid_output')
  return { summary: value.summary, filesChanged: strings(value.filesChanged), commandsRun: strings(value.commandsRun) }
}

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger('Orchestrator')
  private adapters = new Map<OrchestratorId, OrchestratorAdapter>()
  private adapterKey = ''
  private statusCache = new Map<OrchestratorId, { at: number; status: ConnectionStatus }>()
  /** CLI detection (binary lookup + version) spawns processes; it only changes on install/uninstall. */
  private detectionCache = new Map<OrchestratorId, { at: number; detection: Promise<RuntimeDetection> }>()
  private static readonly DETECTION_TTL_MS = 10 * 60_000
  private static readonly STATUS_TTL_OK_MS = 10 * 60_000
  private static readonly STATUS_TTL_FAILED_MS = 15_000
  /** Timings of real CLI process calls and cache use (diagnostics). */
  readonly metrics = { statusCalls: [] as Array<{ id: OrchestratorId; ms: number; at: string }>, detectCalls: [] as Array<{ id: OrchestratorId; ms: number; at: string }>, statusCacheHits: 0, detectCacheHits: 0 }

  constructor(
    private readonly settings: SettingsService,
    private readonly events: EventBusService,
    @Optional() private readonly mcp?: McpService,
    @Optional() private readonly plugins?: PluginsService,
  ) {}

  /** (Re)creates adapters when model/auth settings change. */
  async adapter(id: OrchestratorId): Promise<OrchestratorAdapter> {
    const settings = await this.settings.get()
    const key = `${settings.claudeModel}|${settings.codexModel}|${settings.orchestratorAuthMode}`
    if (key !== this.adapterKey) {
      const codex = new CodexAdapter({ model: settings.codexModel || undefined, authMode: settings.orchestratorAuthMode })
      codex.onModelFallback = (from, to) => {
        this.logger.warn(`Codex model "${from ?? 'default'}" unavailable for this account; using "${to}".`)
        this.events.publish('orchestrator', 'model_fallback', { orchestrator: 'codex', from, to })
      }
      this.adapters = new Map<OrchestratorId, OrchestratorAdapter>([
        ['claude-code', new ClaudeCodeAdapter({ model: settings.claudeModel || undefined, authMode: settings.orchestratorAuthMode })],
        ['codex', codex],
      ])
      this.adapterKey = key
    }
    const adapter = this.adapters.get(id)!
    if (!this.mcp) return adapter
    const roles: Record<string, AgentRole> = { analyzeTask: 'planner', createPlan: 'planner', reviewResult: 'planner', executeComplexTask: 'coder', chat: 'chat' }
    const mcp = this.mcp
    return new Proxy(adapter, {
      get(target, property) {
        const member = Reflect.get(target, property)
        if (typeof member !== 'function') return member
        if (typeof property !== 'string' || !roles[property]) return member.bind(target)
        return async (input: Record<string, unknown>, ctx: CallContext) => {
          const role = (ctx.mcpRole ?? roles[property]) as AgentRole
          // no server shared with this role: skip the per-call gateway (HTTP server + CLI handshake)
          if (!(await mcp.hasServersFor(role, ctx.mcpServers ?? ['*']).catch(() => true))) return member.call(target, input, ctx)
          const gateway = await openMcpGateway((query) => mcp.agentTools(role, query, ctx.mcpServers ?? ['*'], Number.MAX_SAFE_INTEGER))
          try { return await member.call(target, input, { ...ctx, mcpGateway: { url: gateway.url } }) }
          finally { await gateway.close() }
        }
      },
    })
  }

  /** The selected orchestrator if it is installed and authenticated; otherwise undefined. */
  async active(): Promise<OrchestratorAdapter | undefined> {
    const settings = await this.settings.get()
    const selected = await this.plugins?.selectedExtension('orchestratorAdapters')
    if (selected) {
      // operation + schema tell the plugin what is expected (analyze and plan share the "plan" method);
      // results are normalized exactly like Claude/Codex output before planning/execution sees them
      const methods: Record<string, { method: string; operation: string; schema: unknown; normalize(raw: unknown, input: Record<string, unknown>): unknown }> = {
        analyzeTask: { method: 'plan', operation: 'analyze', schema: ANALYSIS_SCHEMA, normalize: (raw) => normalizeAnalysis(raw) },
        createPlan: { method: 'plan', operation: 'plan', schema: PLAN_SCHEMA, normalize: (raw, input) => normalizePlan(raw, Number(input.maxTasks) || 12) },
        executeComplexTask: { method: 'execute', operation: 'execute', schema: EXECUTION_SUMMARY_SCHEMA, normalize: normalizeExecution },
        reviewResult: { method: 'review', operation: 'review', schema: REVIEW_SCHEMA, normalize: (raw) => normalizeReview(raw) },
        chat: { method: 'chat', operation: 'chat', schema: CHAT_SCHEMA, normalize: (raw) => {
          const answer = (raw as { answer?: unknown } | null)?.answer
          if (typeof answer !== 'string') throw new OrchestratorError('Plugin orchestrator returned no answer.', 'invalid_output')
          return { answer }
        } },
      }
      const base = await this.adapter(settings.orchestrator ?? 'codex')
      const plugins = this.plugins!
      const calls = new Map<string, Set<AbortController>>()
      return new Proxy(base, { get(target, property) {
        if (property === 'displayName') return selected.title
        if (typeof property === 'string' && methods[property]) return async (input: Record<string, unknown>, ctx: CallContext) => {
          if (ctx.signal?.aborted) throw new Error('Orchestrator call cancelled.')
          const started = Date.now()
          const spec = methods[property]!
          if (ctx.limits?.maxContextTokens !== undefined || ctx.limits?.maxOutputTokens !== undefined) throw new OrchestratorError('Plugin orchestrator does not declare hard token limit support; no call was started.', 'resource_limit', { retryable: false })
          const controller = new AbortController()
          const active = calls.get(ctx.runId) ?? new Set<AbortController>()
          active.add(controller); calls.set(ctx.runId, active)
          try {
            const signal = AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])])
            const raw = await plugins.invokeExtension(selected.plugin, 'orchestratorAdapters', selected.id, spec.method, { ...input, operation: spec.operation, schema: spec.schema, cwd: ctx.cwd, runId: ctx.runId }, { signal, timeoutMs: ctx.timeoutMs })
            const result = spec.normalize(raw, input)
            return { result, meta: { durationMs: Date.now() - started, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, measured: false, billing: 'unknown' } } }
          } finally { active.delete(controller); if (!active.size) calls.delete(ctx.runId) }
        }
        if (property === 'cancelRun') return async (runId: string) => { for (const controller of calls.get(runId) ?? []) controller.abort(new Error('Orchestrator call cancelled.')) }
        const member = Reflect.get(target, property)
        return typeof member === 'function' ? member.bind(target) : member
      } })
    }
    if (!settings.orchestrator) return undefined
    const status = await this.status(settings.orchestrator)
    if (!status.installed || !status.authenticated) return undefined
    if (status.usesApiKeyBilling && settings.orchestratorAuthMode !== 'api_key') return undefined
    return this.adapter(settings.orchestrator)
  }

  async status(id: OrchestratorId, refresh = false): Promise<ConnectionStatus> {
    const cached = this.statusCache.get(id)
    // A usable connection is trusted for 10 min (each check spawns two CLI processes, ~1-4 s on
    // Windows); real calls that fail with an auth error invalidate it at once (see invalidate()).
    // An unusable one is rechecked quickly so a fresh login is picked up.
    const ttl = cached?.status.installed && cached.status.authenticated ? OrchestratorService.STATUS_TTL_OK_MS : OrchestratorService.STATUS_TTL_FAILED_MS
    if (!refresh && cached && Date.now() - cached.at < ttl) {
      this.metrics.statusCacheHits += 1
      return cached.status
    }
    const adapter = await this.adapter(id)
    const started = Date.now()
    const status = await adapter.getStatus()
    this.metrics.statusCalls = [...this.metrics.statusCalls.slice(-19), { id, ms: Date.now() - started, at: new Date().toISOString() }]
    this.statusCache.set(id, { at: Date.now(), status })
    return status
  }

  async detect(id: OrchestratorId, refresh = false): Promise<RuntimeDetection> {
    const cached = this.detectionCache.get(id)
    if (!refresh && cached && Date.now() - cached.at < OrchestratorService.DETECTION_TTL_MS) {
      this.metrics.detectCacheHits += 1
      return cached.detection
    }
    const started = Date.now()
    const detection = (await this.adapter(id)).detect()
    void detection.then(() => {
      this.metrics.detectCalls = [...this.metrics.detectCalls.slice(-19), { id, ms: Date.now() - started, at: new Date().toISOString() }]
    }, () => undefined)
    this.detectionCache.set(id, { at: Date.now(), detection })
    detection.catch(() => this.detectionCache.delete(id))
    return detection
  }

  async overview(refresh = false) {
    const settings = await this.settings.get()
    const statuses = await Promise.all(IDS.map((id) => this.status(id, refresh)))
    return {
      selected: settings.orchestrator,
      authMode: settings.orchestratorAuthMode,
      orchestrators: await Promise.all(
        IDS.map(async (id, index) => {
          const adapter = await this.adapter(id)
          return { id, displayName: adapter.displayName, status: statuses[index]!, detection: await this.detect(id, refresh) }
        }),
      ),
      policy: {
        apiFallback: 'disabled',
        note: 'The app never switches to paid API billing on its own. API-key variables are removed from the CLI environment unless API-key mode is chosen explicitly.',
      },
    }
  }

  async select(id: OrchestratorId | null) {
    if (id !== null && !IDS.includes(id)) throw new Error(`Unknown orchestrator ${String(id)}`)
    await this.settings.update({ orchestrator: id })
    this.events.publish('orchestrator', 'selected', { orchestrator: id })
    return this.overview()
  }

  async connect(id: OrchestratorId) {
    const adapter = await this.adapter(id)
    this.statusCache.delete(id)
    const result = await adapter.connect()
    this.events.publish('orchestrator', 'connect', { orchestrator: id, status: result.status })
    return { ...result, detection: await this.detect(id, true) }
  }

  async logout(id: OrchestratorId) {
    const adapter = await this.adapter(id)
    await adapter.logout()
    this.statusCache.delete(id)
    this.detectionCache.delete(id)
    const status = await this.status(id, true)
    this.events.publish('orchestrator', 'logout', { orchestrator: id })
    return status
  }

  async diagnose(id: OrchestratorId, liveCall: boolean) {
    const adapter = await this.adapter(id)
    this.statusCache.delete(id)
    return adapter.diagnose({ liveCall })
  }

  async capabilities(id: OrchestratorId) {
    return (await this.adapter(id)).capabilities()
  }

  invalidate(id?: OrchestratorId) {
    if (id) {
      this.statusCache.delete(id)
      this.detectionCache.delete(id)
    } else {
      this.statusCache.clear()
      this.detectionCache.clear()
    }
  }
}
