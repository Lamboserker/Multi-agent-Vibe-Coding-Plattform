import { useState } from 'react'
import { ExternalLink, LogIn, LogOut, RefreshCw, Stethoscope } from 'lucide-react'
import { api, bridge, errorMessage } from '../../lib/api'
import { useLoader } from '../../lib/hooks'
import { loadSettings } from '../../lib/actions'
import { useApp } from '../../lib/store'
import type { DiagnosticReport, OrchestratorId, OrchestratorOverview } from '../../lib/types'
import { AsyncButton, Badge, Spinner, StatusDot } from '../common'

const DESCRIPTIONS: Record<OrchestratorId, string> = {
  'claude-code': 'Anthropic Claude Code CLI – Anmeldung mit deinem Claude-Abonnement (Pro/Max) über das offizielle „claude auth login“.',
  codex: 'OpenAI Codex CLI – Anmeldung mit deinem ChatGPT-Abonnement über das offizielle „codex login“.',
}

export function OrchestratorConnect({ onRunCommand, onChanged }: { onRunCommand: (command: string[], title: string) => void; onChanged?: (overview: OrchestratorOverview) => void }) {
  const { notify, settings, updateSettings } = useApp()
  const { data: overview, reload, loading } = useLoader(() => api.get<OrchestratorOverview>('/orchestrator?refresh=1'), [])
  const [diagnosis, setDiagnosis] = useState<DiagnosticReport>()
  const [liveCall, setLiveCall] = useState(false)
  const { data: capabilities } = useLoader(async () => (settings?.orchestrator ? api.get<{ models: Array<{ id: string; label: string }>; sandbox: string }>(`/orchestrator/${settings.orchestrator}/capabilities`) : undefined), [settings?.orchestrator])

  const select = async (id: OrchestratorId) => {
    try {
      const next = await api.post<OrchestratorOverview>('/orchestrator/select', { orchestrator: id })
      await loadSettings()
      onChanged?.(next)
      await reload()
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }

  if (!overview) return <div className="row"><Spinner /> Erkenne installierte CLIs …</div>

  return (
    <div className="stack">
      <div className="choice-grid">
        {overview.orchestrators.map((entry) => {
          const status = entry.status
          const selected = settings?.orchestrator === entry.id
          return (
            <button key={entry.id} className={`choice ${selected ? 'selected' : ''}`} onClick={() => void select(entry.id)}>
              <div className="row">
                <h3>{entry.displayName}</h3>
                <span className="spacer" />
                <StatusDot status={status.authenticated && !status.usesApiKeyBilling ? 'ok' : status.installed ? 'warn' : 'error'} />
              </div>
              <span className="muted" style={{ fontSize: 12 }}>{DESCRIPTIONS[entry.id]}</span>
              <div className="row wrap">
                <Badge kind={status.installed ? 'ok' : 'error'}>{status.installed ? `installiert ${status.version ?? ''}` : 'nicht installiert'}</Badge>
                {status.installed ? <Badge kind={status.authenticated ? 'ok' : 'warn'}>{status.authenticated ? status.authMethod ?? 'angemeldet' : 'nicht angemeldet'}</Badge> : null}
                {status.usesApiKeyBilling ? <Badge kind="error">API-Key-Abrechnung</Badge> : null}
              </div>
              {status.account ? <span className="faint" style={{ fontSize: 11 }}>{status.account}</span> : null}
            </button>
          )
        })}
      </div>

      {overview.orchestrators.map((entry) => {
        if (settings?.orchestrator !== entry.id) return null
        const status = entry.status
        return (
          <div key={entry.id} className="card stack">
            <div className="row">
              <strong>{entry.displayName}</strong>
              <span className="spacer" />
              <button className="icon-btn" title="Status neu prüfen" onClick={() => void reload()}>
                {loading ? <Spinner /> : <RefreshCw size={14} />}
              </button>
            </div>
            <div className="muted">{status.message}</div>
            {!entry.detection.installed ? (
              <div className="stack">
                <div>Die CLI ist nicht installiert. Offizielle Installationswege (werden sichtbar im Terminal ausgeführt):</div>
                <div className="row wrap">
                  {entry.detection.installHint.commands.map((hint) => (
                    <button key={hint.label} className="btn" onClick={() => onRunCommand(hint.command, `${entry.displayName} installieren`)}>
                      {hint.label}: <code>{hint.command.join(' ')}</code>
                    </button>
                  ))}
                  <button className="btn ghost" onClick={() => void bridge().shell.openExternal(entry.detection.installHint.docsUrl)}>
                    <ExternalLink size={13} /> Dokumentation
                  </button>
                </div>
              </div>
            ) : null}
            {entry.detection.installed && !status.authenticated ? (
              <div className="stack">
                <div>Melde dich mit deinem Abonnement an. Der offizielle Login öffnet den Browser; die App liest oder speichert keine Zugangsdaten.</div>
                <AsyncButton
                  className="btn primary"
                  onClick={async () => {
                    const result = await api.post<{ status: string; loginCommand?: string[]; message: string }>(`/orchestrator/${entry.id}/connect`)
                    if (result.loginCommand) onRunCommand(result.loginCommand, `${entry.displayName} Login`)
                    else notify(result.message, 'info')
                  }}
                >
                  <LogIn size={14} /> Offiziellen Login starten
                </AsyncButton>
                <span className="faint">Nach dem Login im Browser: „Status neu prüfen“.</span>
              </div>
            ) : null}
            {status.authenticated ? (
              <div className="stack">
                {status.usesApiKeyBilling ? (
                  <div className="callout error">
                    Die CLI ist mit einem API-Key angemeldet. Aufrufe würden pro Token abgerechnet. Multi-AI Coder nutzt diesen Orchestrator erst, wenn du auf Abonnement-Login wechselst oder in den Einstellungen ausdrücklich den API-Key-Modus wählst.
                  </div>
                ) : null}
                {status.rateLimit ? (
                  <div className="faint">
                    Abonnement-Limit ({status.rateLimit.window ?? 'Fenster'}): {status.rateLimit.status}
                    {status.rateLimit.resetsAt ? ` · Reset ${new Date(status.rateLimit.resetsAt).toLocaleString()}` : ''}
                  </div>
                ) : null}
                {capabilities?.models?.length ? (
                  <label className="row">
                    <span className="muted" style={{ whiteSpace: 'nowrap' }}>Modell</span>
                    <select
                      className="select"
                      value={entry.id === 'codex' ? settings?.codexModel ?? '' : settings?.claudeModel ?? ''}
                      onChange={(event) => void updateSettings(entry.id === 'codex' ? { codexModel: event.target.value } : { claudeModel: event.target.value })}
                    >
                      {capabilities.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {capabilities?.sandbox ? <div className="faint" style={{ fontSize: 12 }}>Isolation: {capabilities.sandbox}</div> : null}
                <div className="row wrap">
                  <label className="row muted" style={{ gap: 5, fontSize: 12 }}>
                    <input type="checkbox" checked={liveCall} onChange={(event) => setLiveCall(event.target.checked)} /> mit echtem Testaufruf (verbraucht minimal Kontingent)
                  </label>
                  <AsyncButton className="btn" onClick={async () => setDiagnosis(await api.post<DiagnosticReport>(`/orchestrator/${entry.id}/diagnose`, { liveCall }))}>
                    <Stethoscope size={14} /> Verbindung diagnostizieren
                  </AsyncButton>
                  <AsyncButton className="btn ghost" onClick={async () => { await api.post(`/orchestrator/${entry.id}/logout`); await reload() }}>
                    <LogOut size={14} /> Abmelden
                  </AsyncButton>
                </div>
              </div>
            ) : null}
            {diagnosis && diagnosis.orchestrator === entry.id ? (
              <div className="stack" style={{ gap: 3 }}>
                {diagnosis.checks.map((check) => (
                  <div key={check.name} className="row">
                    <StatusDot status={check.ok ? 'ok' : 'failed'} />
                    <strong>{check.name}</strong>
                    <span className="muted">{check.detail}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
      <div className="faint" style={{ fontSize: 12 }}>{overview.policy.note}</div>
    </div>
  )
}
