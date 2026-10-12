import { Injectable, Logger } from '@nestjs/common'
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  type ConnectionStatus,
  type OrchestratorAdapter,
  type OrchestratorId,
} from '@multi-ai-coder/engine'
import { EventBusService } from '../runtime/event-bus.service.js'
import { SettingsService } from '../runtime/settings.service.js'

const IDS: OrchestratorId[] = ['claude-code', 'codex']

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger('Orchestrator')
  private adapters = new Map<OrchestratorId, OrchestratorAdapter>()
  private adapterKey = ''
  private statusCache = new Map<OrchestratorId, { at: number; status: ConnectionStatus }>()

  constructor(
    private readonly settings: SettingsService,
    private readonly events: EventBusService,
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
    return this.adapters.get(id)!
  }

  /** The selected orchestrator if it is installed and authenticated; otherwise undefined. */
  async active(): Promise<OrchestratorAdapter | undefined> {
    const settings = await this.settings.get()
    if (!settings.orchestrator) return undefined
    const status = await this.status(settings.orchestrator)
    if (!status.installed || !status.authenticated) return undefined
    if (status.usesApiKeyBilling && settings.orchestratorAuthMode !== 'api_key') return undefined
    return this.adapter(settings.orchestrator)
  }

  async status(id: OrchestratorId, refresh = false): Promise<ConnectionStatus> {
    const cached = this.statusCache.get(id)
    if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.status
    const adapter = await this.adapter(id)
    const status = await adapter.getStatus()
    this.statusCache.set(id, { at: Date.now(), status })
    return status
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
          return { id, displayName: adapter.displayName, status: statuses[index]!, detection: await adapter.detect() }
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
    return { ...result, detection: await adapter.detect() }
  }

  async logout(id: OrchestratorId) {
    const adapter = await this.adapter(id)
    await adapter.logout()
    this.statusCache.delete(id)
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
    if (id) this.statusCache.delete(id)
    else this.statusCache.clear()
  }
}
