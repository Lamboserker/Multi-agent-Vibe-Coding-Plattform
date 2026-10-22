import { useState } from 'react'
import { ArrowLeft, Package } from 'lucide-react'
import type { IntegrationCatalog, WorkflowBundle } from '@multi-ai-coder/shared'
import { api, enc } from '../../lib/api'
import { useAppEvents, useVisibleLoader } from '../../lib/hooks'
import { AsyncButton, Badge, PanelHeader, Spinner } from '../common'
import { IntegrationSetup } from './IntegrationSetup'
import './integrations.css'

type Tab = 'mcp' | 'skills' | 'bundles'
export function IntegrationsPanel({ onBack, initialTab = 'mcp' }: { onBack: () => void; initialTab?: Tab }) {
  const catalog = useVisibleLoader(() => api.get<IntegrationCatalog>('/integrations/catalog'))
  const [tab, setTab] = useState<Tab>(initialTab)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [platform, setPlatform] = useState('supported')
  const [auth, setAuth] = useState('')
  const [status, setStatus] = useState('')
  const [presetId, setPresetId] = useState<string>()
  const [bundleId, setBundleId] = useState<string>()
  const [bundleOptional, setBundleOptional] = useState<Record<string, string[]>>({})
  useAppEvents((event) => { if (['integration_setup_changed', 'integrations_changed', 'skills_changed', 'mcp_changed'].includes(event.type)) void catalog.reload() })
  const data = catalog.data
  const preset = data?.presets.find((entry) => entry.id === presetId)
  const bundle = data?.bundles.find((entry) => entry.id === bundleId)
  if (preset && data) return <IntegrationSetup key={preset.id} preset={preset} catalog={data} onBack={() => { setPresetId(undefined); void catalog.reload() }} />
  if (bundle && data) return <BundleDetails key={bundle.id} bundle={bundle} optional={bundleOptional[bundle.id] ?? bundle.selectedOptional} onOptional={(optional) => setBundleOptional((current) => ({ ...current, [bundle.id]: optional }))} catalog={data} onBack={() => setBundleId(undefined)} onSetup={setPresetId} onReload={catalog.reload} />
  const matches = (text: string) => text.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  const categories = [...new Set([...(data?.presets ?? []), ...(data?.skills ?? [])].map((entry) => entry.category))].sort()
  return <>
    <PanelHeader title="Integrationskatalog"><button className="icon-btn" aria-label="Zurück zum Manager" onClick={onBack}><ArrowLeft size={16} /></button></PanelHeader>
    <div className="panel-body stack integration-catalog" data-testid="integration-catalog">
      <div className="integration-intro"><Package size={23} /><div><h3>Werkzeuge für deine nächsten Aufgaben</h3><p>30 MCP-Integrationen · 40 zusätzliche Skills · 8 Workflow-Pakete</p></div></div>
      <div className="row integration-tabs" role="tablist" aria-label="Katalogbereiche">{([['mcp', 'MCP-Server'], ['skills', 'Skills'], ['bundles', 'Workflow-Pakete']] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={`btn ${tab === id ? 'primary' : ''}`} onClick={() => { setTab(id); setCategory('') }}>{label}</button>)}</div>
      <input className="input" aria-label="Katalog durchsuchen" placeholder="Integrationen, Skills und Pakete suchen …" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="row integration-filters">
        {tab !== 'bundles' && <select className="select" aria-label="Kategorie" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">Alle Kategorien</option>{categories.map((entry) => <option key={entry}>{entry}</option>)}</select>}
        {tab === 'mcp' && <>
          <select className="select" aria-label="Plattform" value={platform} onChange={(event) => setPlatform(event.target.value)}><option value="supported">Für dieses Betriebssystem</option><option value="all">Alle Betriebssysteme</option></select>
          <select className="select" aria-label="Anmeldung" value={auth} onChange={(event) => setAuth(event.target.value)}><option value="">Jede Anmeldung</option><option value="none">Ohne Anmeldung</option><option value="oauth">OAuth-Anmeldung</option><option value="secret">Zugangsdaten</option></select>
          <select className="select" aria-label="Einrichtungsstatus" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Jeder Status</option><option value="available">Noch nicht eingerichtet</option><option value="installed">Verbindung vorhanden</option><option value="ready">Bereit</option><option value="attention">Einrichtung fortsetzen</option></select>
        </>}
      </div>
      {catalog.error && <div role="alert" className="callout error">{catalog.error}<AsyncButton onClick={catalog.reload}>Erneut laden</AsyncButton></div>}{catalog.loading && !data && <Spinner />}
      <div className="integration-grid">
        {tab === 'mcp' && data?.presets.filter((entry) => {
          const job = data.jobs.find((candidate) => candidate.presetId === entry.id)
          return matches(`${entry.title} ${entry.description} ${entry.publisher} ${entry.category}`) && (!category || entry.category === category) && (platform === 'all' || entry.platforms.includes(data.platform)) && (!auth || entry.auth === auth) && (!status || (status === 'available' ? !entry.serverId && !job : status === 'installed' ? Boolean(entry.serverId) : status === 'ready' ? job?.phase === 'ready' : job && job.phase !== 'ready'))
        }).map((entry) => <article className="integration-card" key={entry.id}><div className="row"><span className="faint">{entry.category}</span>{entry.serverId && <Badge kind={entry.status === 'connected' ? 'ok' : undefined}>{entry.status === 'connected' ? 'Verbunden' : 'Konfiguriert'}</Badge>}</div><h3>{entry.title}</h3><p>{entry.description}</p><div className="faint">{entry.publisher} · {entry.transport === 'stdio' ? 'Lokal' : 'Remote'} · {entry.auth === 'oauth' ? 'OAuth' : entry.auth === 'secret' ? 'Zugangsdaten' : 'Ohne Anmeldung'}</div><div className="integration-card-footer"><span className="faint">{entry.platforms.map((os) => os === 'win32' ? 'Windows' : os === 'darwin' ? 'macOS' : 'Linux').join(' · ')}</span><button className="btn small primary" onClick={() => setPresetId(entry.id)}>{entry.serverId ? 'Einrichtung öffnen' : 'Einrichten'}</button></div></article>)}
        {tab === 'skills' && data?.skills.filter((entry) => matches(`${entry.title} ${entry.description} ${entry.triggers.join(' ')}`) && (!category || entry.category === category)).map((entry) => <article className="integration-card" key={entry.id}><div className="row"><span className="faint">{entry.category}</span><Badge kind={entry.enabled ? 'ok' : undefined}>{entry.enabled ? 'Aktiv' : 'Verfügbar'}</Badge></div><h3>{entry.title}</h3><p>{entry.description}</p><details><summary>Arbeitsschritte und Testaufgabe</summary><ol>{entry.steps.map((step) => <li key={step}>{step}</li>)}</ol><p>{entry.testTask}</p><p className="faint">Werkzeuge: {entry.tools.join(', ')}</p></details><div className="integration-card-footer"><AsyncButton className={`btn small ${entry.enabled ? '' : 'primary'}`} onClick={async () => { await api.post(`/integrations/skills/${enc(entry.id)}/activation`, { enabled: !entry.enabled }); await catalog.reload() }}>{entry.enabled ? 'Deaktivieren' : 'Aktivieren'}</AsyncButton></div></article>)}
        {tab === 'bundles' && data?.bundles.filter((entry) => matches(`${entry.title} ${entry.description} ${entry.example}`)).map((entry) => <article className="integration-card" key={entry.id}><Badge kind={entry.active ? 'ok' : undefined}>{entry.active ? 'Aktiviert' : `${entry.required.length} Integrationen`}</Badge><h3>{entry.title}</h3><p>{entry.description}</p><div className="faint">{entry.skills.length} passende Skills · Rollen und Freigaben je Server</div><div className="integration-card-footer"><button className="btn small primary" onClick={() => setBundleId(entry.id)}>Paket öffnen</button></div></article>)}
      </div>{data && <p className="faint">Katalog {data.version}. Neue Skills werden erst nach Aktivierung ausgewählt. Konten und Dienstkontingente werden beim jeweiligen Anbieter verwaltet.</p>}
    </div>
  </>
}

function BundleDetails({ bundle, catalog, onBack, onSetup, onReload, optional, onOptional }: { bundle: WorkflowBundle & { active: boolean }; catalog: IntegrationCatalog; onBack: () => void; onSetup: (id: string) => void; onReload: () => Promise<void>; optional: string[]; onOptional: (optional: string[]) => void }) {
  const ready = (id: string) => catalog.jobs.find((job) => job.presetId === id)?.phase === 'ready' && Boolean(catalog.presets.find((entry) => entry.id === id)?.serverId)
  const row = (id: string, extra: boolean) => { const preset = catalog.presets.find((entry) => entry.id === id)!; return <div className="integration-bundle-row" key={id}>{extra ? <label className="row"><input type="checkbox" checked={optional.includes(id)} onChange={(event) => onOptional(event.target.checked ? [...optional, id] : optional.filter((entry) => entry !== id))} />{preset.title}</label> : <strong>{preset.title}</strong>}<span className="spacer" /><Badge kind={ready(id) ? 'ok' : undefined}>{ready(id) ? 'Bereit' : 'Einrichtung nötig'}</Badge><button className="btn small" disabled={!preset.platforms.includes(catalog.platform)} onClick={() => onSetup(id)}>Einrichten</button></div> }
  return <><PanelHeader title={bundle.title}><button className="icon-btn" aria-label="Zurück zum Katalog" onClick={onBack}><ArrowLeft size={16} /></button></PanelHeader><div className="panel-body stack integration-catalog"><p>{bundle.description}</p><h3>Benötigte Integrationen</h3>{bundle.required.map((id) => row(id, false))}{Boolean(bundle.optional.length) && <><h3>Optionale Dienste</h3>{bundle.optional.map((id) => row(id, true))}</>}<div className="card stack"><strong>Beispielaufgabe</strong><p>{bundle.example}</p><span className="faint">Vorgeschlagene Rollen: lokale Coder und Chat / Premium-Orchestrator.</span></div><h3>Passende Skills</h3><p>{bundle.skills.map((id) => catalog.skills.find((skill) => skill.id === id)?.title ?? id).join(' · ')}</p><p className="faint">Aktiviert werden Skills mit ausgewählten Integrationen. Vorhandene Rollen und Freigaben bleiben erhalten.</p><div className="row"><AsyncButton className="btn primary" disabled={![...bundle.required, ...optional].every(ready)} onClick={async () => { await api.post(`/integrations/bundles/${enc(bundle.id)}/activate`, { optional }); await onReload() }}>{bundle.active ? 'Paketauswahl aktualisieren' : 'Paket aktivieren'}</AsyncButton>{bundle.active && <AsyncButton onClick={async () => { await api.del(`/integrations/bundles/${enc(bundle.id)}`); await onReload() }}>Paketzuordnung entfernen</AsyncButton>}</div><span className="faint">Zuerst benötigte Integrationen einrichten. Beim Entfernen einer Paketzuordnung bleiben Server, Skills und Freigaben erhalten.</span></div></>
}
