import { useEffect, useState } from 'react'
import { ArrowLeft, Check, ExternalLink } from 'lucide-react'
import type { GrantGroup, IntegrationCatalog, McpPreset, SetupCheck, SetupJobDetails } from '@multi-ai-coder/shared'
import { api, bridge, enc } from '../../lib/api'
import { useAppEvents, useLoader } from '../../lib/hooks'
import { AsyncButton, Badge, PanelHeader, Spinner } from '../common'

const GROUPS: Record<GrantGroup, string> = { read: 'Informationen lesen', browser: 'Browser bedienen', desktop: 'Desktop steuern', code: 'Code und Befehle ausführen', generate: 'Kostenpflichtige Generierung', write: 'Daten und Inhalte ändern' }
const PHASES: Record<string, string> = { checking: 'Prüfung', installing: 'Installation', configuring: 'Konfiguration', authentication: 'Anmeldung', testing: 'Verbindungstest', approval: 'Freigabe', ready: 'Bereit', failed: 'Fehlgeschlagen', cancelled: 'Abgebrochen' }
const ROLES = [{ id: 'coder', label: 'Lokale Coder' }, { id: 'chat', label: 'Chat / Premium-Orchestrator' }, { id: 'planner', label: 'Planer' }, { id: 'designer', label: 'Designer' }]

export function IntegrationSetup({ preset, catalog, onBack }: { preset: McpPreset; catalog: IntegrationCatalog; onBack: () => void }) {
  const [jobId, setJobId] = useState(catalog.jobs.find((job) => job.presetId === preset.id)?.id)
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(preset.fields.filter((field) => field.defaultValue).map((field) => [field.key, field.defaultValue!])))
  const [install, setInstall] = useState<string[]>([])
  const [installServer, setInstallServer] = useState(true)
  const [installAddon, setInstallAddon] = useState(false)
  const [reuse, setReuse] = useState('')
  const [allow, setAllow] = useState<string[]>([])
  const [roles, setRoles] = useState(['coder', 'chat'])
  const checks = useLoader(() => api.post<SetupCheck>(`/integrations/presets/${enc(preset.id)}/check`), [preset.id])
  const servers = useLoader(() => api.get<Array<{ id: string; name: string; transport: string }>>('/mcp/servers'))
  const job = useLoader(() => jobId ? api.get<SetupJobDetails>(`/integrations/jobs/${enc(jobId)}`) : Promise.resolve(undefined), [jobId])
  useAppEvents((event) => { if (event.type === 'integration_setup_changed' && event.data.id === jobId) void job.reload() }, [jobId])
  useEffect(() => {
    if (!jobId || ['ready', 'cancelled', 'failed', 'approval', 'authentication'].includes(job.data?.phase ?? '')) return
    const timer = window.setInterval(() => void job.reload(), 1500)
    return () => window.clearInterval(timer)
  }, [jobId, job.data?.phase, job.reload])
  useEffect(() => { if (job.data?.phase === 'approval') setAllow(job.data.tools.filter((tool) => tool.policy === 'allow').map((tool) => tool.name)) }, [job.data?.phase])
  useEffect(() => { if (job.data?.values) setValues((current) => ({ ...current, ...job.data?.values })) }, [job.data?.id])
  const setup = async (resume = false) => {
    const payload = { values, install, installServer, installAddon, ...(reuse ? { reuseServerId: reuse } : {}) }
    const next = await api.post<SetupJobDetails>(resume && jobId ? `/integrations/jobs/${enc(jobId)}/resume` : `/integrations/presets/${enc(preset.id)}/setup`, payload)
    setJobId(next.id)
    setValues((current) => Object.fromEntries(Object.entries(current).filter(([key]) => preset.fields.find((field) => field.key === key)?.type !== 'secret')))
    job.setData(next)
  }
  const current = job.data
  const editable = !current || ['failed', 'cancelled', 'authentication'].includes(current.phase)
  const supported = preset.platforms.includes(catalog.platform)
  const toggle = (names: string[], checked: boolean) => setAllow((selected) => [...new Set([...(checked ? [...selected, ...names] : selected.filter((name) => !names.includes(name))), ...(current?.tools.filter((tool) => tool.policy === 'allow').map((tool) => tool.name) ?? [])])])
  return <><PanelHeader title={preset.title}><button className="icon-btn" aria-label="Zurück zum Katalog" onClick={onBack}><ArrowLeft size={16} /></button></PanelHeader><div className="panel-body stack integration-catalog" data-testid="integration-setup">
    <p>{preset.description}</p><div className="row"><Badge>{preset.publisher}</Badge><Badge>{preset.transport === 'stdio' ? 'Lokaler Server' : 'Remote MCP'}</Badge>{preset.packageVersion && <Badge>Version {preset.packageVersion}</Badge>}<AsyncButton className="btn small" onClick={() => bridge().shell.openExternal(preset.docs)}><ExternalLink size={12} /> Dokumentation</AsyncButton></div><p className="faint">{preset.cost}</p>{preset.notes && <div className="callout">{preset.notes}</div>}
    {!supported && <div className="callout error">Diese Integration ist auf diesem Betriebssystem nicht verfügbar.</div>}
    {current && <div className="card stack" role="status"><div className="row"><Badge kind={current.phase === 'ready' ? 'ok' : current.phase === 'failed' ? 'error' : undefined}>{PHASES[current.phase]}</Badge><strong>{current.message}</strong></div><div className="integration-steps">{['checking', 'installing', 'configuring', 'authentication', 'testing', 'approval', 'ready'].map((phase) => <span key={phase} className={phase === current.phase ? 'active' : ''}>{PHASES[phase]}</span>)}</div>{current.error && <p role="alert">{current.error}</p>}</div>}
    {editable && <>
      <h3>Voraussetzungen</h3>{checks.error && <div role="alert">{checks.error}</div>}{checks.loading && <Spinner />}{checks.data?.checks.map((entry) => <div className="card stack" key={entry.id}><div className="row">{entry.available ? <Check size={16} /> : null}<strong>{entry.label}</strong><Badge kind={entry.available ? 'ok' : 'warn'}>{entry.available ? 'Vorhanden' : 'Fehlt'}</Badge></div>{!entry.available && <><p className="faint">{entry.instruction}</p>{entry.installable && <label className="row"><input type="checkbox" checked={install.includes(entry.id)} onChange={(event) => setInstall((selected) => event.target.checked ? [...selected, entry.id] : selected.filter((id) => id !== entry.id))} />Gezielt über Windows-Paketmanager installieren</label>}</>}</div>)}{!preset.prerequisites.length && <span className="faint">Keine lokale Laufzeit erforderlich.</span>}<AsyncButton className="btn small" onClick={checks.reload}>Voraussetzungen erneut prüfen</AsyncButton>
      {!current && Boolean(servers.data?.filter((entry) => entry.transport === preset.transport).length) && <label className="stack">Vorhandene Verbindung verwenden<select className="select" value={reuse} onChange={(event) => setReuse(event.target.value)}><option value="">Neue Verbindung anlegen</option>{servers.data?.filter((entry) => entry.transport === preset.transport).map((entry) => <option value={entry.id} key={entry.id}>{entry.name}</option>)}</select></label>}
      {preset.fields.map((field) => <label className="stack" key={field.key}><span>{field.label}{field.required ? ' *' : ''}</span><div className="row"><input className="input" style={{ flex: 1 }} type={field.type === 'secret' ? 'password' : field.type === 'port' ? 'number' : 'text'} min={field.type === 'port' ? 1 : undefined} max={field.type === 'port' ? 65535 : undefined} disabled={Boolean(current?.serverId) && field.type !== 'secret'} autoComplete="off" value={values[field.key] ?? ''} placeholder={field.type === 'secret' && current?.serverId ? 'Gespeicherten Wert behalten oder ersetzen' : undefined} onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))} />{field.type === 'directory' && <AsyncButton className="btn small" onClick={async () => { const folder = await bridge().dialog.openFolder(field.label); if (folder) setValues((previous) => ({ ...previous, [field.key]: folder })) }}>Ordner wählen</AsyncButton>}</div>{field.type === 'secret' && <span className="faint">Wird verschlüsselt im Desktop-Tresor gespeichert.</span>}</label>)}
      {preset.runtime && !reuse && <label className="row"><input type="checkbox" checked={installServer} onChange={(event) => setInstallServer(event.target.checked)} />Serverpaket {preset.package} in Version {preset.packageVersion} installieren</label>}
      {preset.id === 'blender' && <label className="row"><input type="checkbox" checked={installAddon} onChange={(event) => setInstallAddon(event.target.checked)} />MCP-Add-on installieren; anschließend in Blender aktivieren und Server starten</label>}
      <div className="row"><AsyncButton className="btn primary" disabled={!supported || checks.loading || (!reuse && Boolean(checks.data?.checks.some((entry) => !entry.available && !install.includes(entry.id))))} onClick={() => setup(Boolean(current && current.phase !== 'cancelled'))}>{current?.phase === 'authentication' ? 'Zugangsdaten speichern und Verbindung prüfen' : current?.phase === 'failed' ? 'Erneut versuchen' : 'Einrichtung starten'}</AsyncButton>{current?.phase === 'authentication' && preset.auth === 'oauth' && <AsyncButton onClick={async () => { const result = await api.post<{ authorizationUrl?: string }>(`/integrations/jobs/${enc(current.id)}/login`); if (result.authorizationUrl) await bridge().shell.openExternal(result.authorizationUrl) }}>Beim Anbieter anmelden</AsyncButton>}</div>
    </>}
    {current?.phase === 'approval' && <><h3>Werkzeuge und Agenten freigeben</h3><p>Wähle konkrete Werkzeuge für selbstständige Agentenaufrufe. Künftig neue Werkzeuge erhalten dadurch keine Freigabe.</p><div className="row integration-filters">{ROLES.map((role) => <label className="row" key={role.id}><input type="checkbox" checked={roles.includes(role.id)} onChange={(event) => setRoles((selected) => event.target.checked ? [...selected, role.id] : selected.filter((id) => id !== role.id))} />{role.label}</label>)}</div>{(Object.keys(GROUPS) as GrantGroup[]).map((group) => { const tools = current.tools.filter((tool) => tool.group === group); if (!tools.length) return null; return <div className="card stack" key={group}><label className="row"><input type="checkbox" checked={tools.every((tool) => allow.includes(tool.name))} onChange={(event) => toggle(tools.map((tool) => tool.name), event.target.checked)} /><strong>{GROUPS[group]}</strong><Badge>{tools.length}</Badge></label>{tools.map((tool) => <label className="integration-tool" key={tool.name}><input type="checkbox" checked={allow.includes(tool.name)} disabled={tool.policy === 'allow'} onChange={(event) => toggle([tool.name], event.target.checked)} /><span><strong>{tool.name}</strong><span className="faint">{tool.description}</span></span></label>)}</div> })}<AsyncButton className="btn primary" onClick={async () => { job.setData(await api.post<SetupJobDetails>(`/integrations/jobs/${enc(current.id)}/approve`, { roles, allow })); }}>Auswahl freigeben und abschließen</AsyncButton></>}
    {current?.phase === 'ready' && <div className="callout"><Check size={17} /> Integration bereit. Passende Skills können einzeln oder über ein Workflow-Paket aktiviert werden.<button className="btn small" onClick={onBack}>Zum Katalog</button></div>}
    {current && !['ready', 'failed', 'cancelled'].includes(current.phase) && <AsyncButton className="btn small" onClick={async () => { job.setData(await api.post<SetupJobDetails>(`/integrations/jobs/${enc(current.id)}/cancel`)); }}>Einrichtung abbrechen</AsyncButton>}
    {job.error && <div role="alert" className="callout error">{job.error}<AsyncButton onClick={job.reload}>Status erneut laden</AsyncButton></div>}
  </div></>
}
