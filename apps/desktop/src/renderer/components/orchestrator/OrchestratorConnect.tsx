import { useEffect, useState } from 'react'
import { ExternalLink, LogIn, LogOut, RefreshCw, Stethoscope } from 'lucide-react'
import { api, bridge, errorMessage } from '../../lib/api'
import { useLoader } from '../../lib/hooks'
import { loadSettings } from '../../lib/actions'
import { useApp } from '../../lib/store'
import type { DiagnosticReport, OrchestratorId, OrchestratorMode, OrchestratorOverview } from '../../lib/types'
import { AsyncButton, Badge, Spinner, StatusDot } from '../common'
import { Seg } from '../ui'

const DESCRIPTIONS: Record<OrchestratorId, string> = {
  'claude-code': 'Anthropic Claude Code CLI – Anmeldung mit deinem Claude-Abonnement (Pro/Max) über das offizielle „claude auth login“.',
  codex: 'OpenAI Codex CLI – Anmeldung mit deinem ChatGPT-Abonnement über das offizielle „codex login“.',
}

export function OrchestratorConnect({ onRunCommand, onChanged }: { onRunCommand: (command: string[], title: string) => void; onChanged?: (overview: OrchestratorOverview) => void }) {
  const { notify, settings, updateSettings } = useApp()
  // Cached status first (instant), then a background refresh of the CLI login state.
  const { data: overview, reload, loading, setData } = useLoader(() => api.get<OrchestratorOverview>('/orchestrator'), [])
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    setRefreshing(true)
    try {
      setData(await api.get<OrchestratorOverview>('/orchestrator?refresh=1'))
    } finally {
      setRefreshing(false)
    }
  }
  useEffect(() => {
    void refresh().catch(() => undefined)
    // once per mount (the view stays mounted while hidden)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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

      <DuoSettings overview={overview} mode={settings?.orchestratorMode ?? 'single'} lead={settings?.duoLead ?? 'claude-code'} onChange={(patch) => void updateSettings(patch)} />

      {overview.orchestrators.map((entry) => {
        if (settings?.orchestrator !== entry.id) return null
        const status = entry.status
        return (
          <div key={entry.id} className="card stack">
            <div className="row">
              <strong>{entry.displayName}</strong>
              <span className="spacer" />
              <button className="icon-btn" title="Status neu prüfen" onClick={() => void refresh()}>
                {loading || refreshing ? <Spinner /> : <RefreshCw size={14} />}
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

/** Single or duo mode (ADR-004): both CLIs plan, design, review and execute in parallel, the lead reconciles. */
function DuoSettings({ overview, mode, lead, onChange }: { overview: OrchestratorOverview; mode: OrchestratorMode; lead: OrchestratorId; onChange: (patch: { orchestratorMode?: OrchestratorMode; duoLead?: OrchestratorId }) => void }) {
  const available = overview.duo?.available ?? false
  return (
    <div className="card stack" data-testid="duo-settings">
      <div className="row wrap">
        <strong>Arbeitsweise</strong>
        <span className="spacer" />
        <Seg
          label="Arbeitsweise"
          value={mode}
          onChange={(value: OrchestratorMode) => onChange({ orchestratorMode: value })}
          options={[
            { id: 'single', label: 'Einzeln', title: 'Ein Premium-Orchestrator (die Auswahl oben) bearbeitet alle Phasen' },
            { id: 'duo', label: 'Duo (Claude + Codex)', title: 'Claude Code und Codex arbeiten parallel und gleichen ihre Ergebnisse ab', disabled: !available && mode !== 'duo' },
          ]}
        />
      </div>
      {mode === 'duo' ? (
        <div className="row wrap">
          <span className="muted" title="Der Lead führt beide Vorschläge zusammen und entscheidet bei Gleichstand">Lead</span>
          <span className="spacer" />
          <Seg label="Duo-Lead" value={lead} onChange={(value: OrchestratorId) => onChange({ duoLead: value })} options={[{ id: 'claude-code', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }]} />
        </div>
      ) : null}
      <span className="faint" style={{ fontSize: 12 }}>Duo nutzt beide Abos parallel – etwa 2–3× Premium-Kontingent pro Phase. Im Composer wählst du pro Auftrag „Claude“, „Codex“ oder „Beide“.</span>
      {!available ? (
        <span className="muted" style={{ fontSize: 12 }}>
          {overview.duo?.reason ?? 'Duo braucht beide CLIs installiert und angemeldet.'}
          {mode === 'duo' ? ' Bis dahin arbeitet der verbundene Orchestrator allein (mit Hinweis im Chat).' : ''}
        </span>
      ) : null}
    </div>
  )
}
