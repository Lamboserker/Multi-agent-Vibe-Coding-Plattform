import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, FolderInput, GitBranch, RefreshCw } from 'lucide-react'
import type { CommandResult, PluginPermissions, ViewAction, ViewNode } from '@multi-ai-coder/plugin-sdk'
import { composerKey, notify, setComposerDraft } from '../../lib/actions'
import { api, bridge, enc, errorMessage } from '../../lib/api'
import { useVisibleLoader } from '../../lib/hooks'
import { useStore } from '../../lib/store/core'
import { appStore, pluginStore } from '../../lib/stores'
import { AsyncButton, Badge, Confirm, Empty, PanelHeader, Spinner, StatusDot } from '../common'
import { PluginView } from './PluginView'

interface Setting {
  key: string
  title: string
  type: 'string' | 'number' | 'boolean' | 'secret' | 'select'
  description?: string
  default?: string | number | boolean
  options?: string[]
}

interface PluginSummary {
  id: string
  name: string
  version: string
  description: string
  publisher?: string
  categories: string[]
  source: 'builtin' | 'folder' | 'git'
  sourceRef?: string | null
  trust: 'trusted' | 'untrusted'
  enabled: boolean
  status: string
  lastError?: string | null
  permissions: PluginPermissions
  granted: PluginPermissions
  missingGrants: string[]
  contributes: {
    commands?: Array<{ id: string; title: string; description?: string; confirm?: string }>
    views?: Array<{ id: string; title: string }>
    settings?: Setting[]
    agentTools?: Array<{ name: string; description: string; sideEffects?: boolean }>
    hooks?: string[]
    contextProviders?: Array<{ id: string; title: string }>
  }
  settings: Record<string, unknown>
  registrations: { commands: string[]; views: string[]; tools: string[]; hooks: string[]; contextProviders: string[]; contributions: Array<{ kind: string; id: string }> } | null
  metrics: { rssMb: number; heapMb: number; cpuMs: number; at: string } | null
}

interface PluginDetails extends PluginSummary {
  logs: Array<{ at: string; level: string; message: string }>
}

interface CatalogEntry {
  id: string
  name: string
  version: string
  description: string
  categories: string[]
  source: string
  gitUrl?: string
  installedVersion?: string
  updateAvailable: boolean
}

const STATUS: Record<string, string> = { active: 'aktiv', installed: 'installiert', disabled: 'deaktiviert', error: 'Fehler', crashed: 'abgestürzt' }

/** Human-readable list of what a permission set allows. */
function describePermissions(permissions: PluginPermissions, trusted: boolean): string[] {
  const lines: string[] = []
  for (const host of permissions.network ?? []) lines.push(host === '*' ? 'Netzwerk: beliebige Hosts (HTTP über die App)' : `Netzwerk: ${host}`)
  if (permissions.fs === 'project-read') lines.push('Dateien des geöffneten Projekts lesen')
  if (permissions.fs === 'project-write') lines.push('Dateien des geöffneten Projekts lesen und schreiben')
  for (const binary of permissions.processes ?? []) lines.push(`Programm starten: ${binary}`)
  for (const secret of permissions.secrets ?? []) lines.push(`Geheimnis lesen: ${secret}`)
  if (permissions.native) lines.push(trusted ? 'Direkter Netzwerk- und Prozesszugriff (ohne Sandbox)' : 'Direkter Netzwerk- und Prozesszugriff – wird für Fremd-Plugins nicht gewährt (bleibt in der Sandbox)')
  return lines
}

export function PluginsPanel() {
  const revision = useStore(pluginStore, (state) => state.revision)
  const [tab, setTab] = useState<'installed' | 'available'>('installed')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState<string>()
  const [gitUrl, setGitUrl] = useState('')
  const [downgrade, setDowngrade] = useState<{ folder?: string; gitUrl?: string; message: string }>()
  const list = useVisibleLoader(() => api.get<PluginSummary[]>('/plugins'), [])
  const catalog = useVisibleLoader(() => api.get<{ entries: CatalogEntry[] }>('/plugins/catalog'), [])

  useEffect(() => {
    if (revision) {
      void list.reload()
      void catalog.reload()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  const categories = useMemo(() => [...new Set([...(list.data ?? []).flatMap((plugin) => plugin.categories), ...(catalog.data?.entries ?? []).flatMap((entry) => entry.categories)])].sort(), [list.data, catalog.data])
  const matches = (entry: { name: string; description: string; categories: string[] }) => (!query || `${entry.name} ${entry.description}`.toLowerCase().includes(query.toLowerCase())) && (!category || entry.categories.includes(category))

  const install = async (input: { folder?: string; gitUrl?: string; allowDowngrade?: boolean }) => {
    try {
      const plugin = await api.post<PluginSummary>('/plugins/install', input)
      notify(`${plugin.name} ${plugin.version} installiert${plugin.enabled ? ' und aktiviert' : ' – zum Aktivieren Berechtigungen prüfen'}.`, 'success')
      setSelected(plugin.id)
      setTab('installed')
      void list.reload()
    } catch (error) {
      const message = errorMessage(error)
      if (/Version conflict/.test(message)) setDowngrade({ ...input, message })
      else throw error
    }
  }

  if (selected) return <PluginDetail id={selected} revision={revision} onBack={() => setSelected(undefined)} onChanged={() => void list.reload()} />

  return (
    <>
      <PanelHeader title="Erweiterungen">
        <button className="icon-btn" title="Aktualisieren" onClick={() => void Promise.all([list.reload(), catalog.reload()])}>
          <RefreshCw size={14} />
        </button>
      </PanelHeader>
      <div className="panel-body stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 6 }}>
          <button className={`btn small ${tab === 'installed' ? 'primary' : ''}`} onClick={() => setTab('installed')}>
            Installiert ({list.data?.length ?? 0})
          </button>
          <button className={`btn small ${tab === 'available' ? 'primary' : ''}`} onClick={() => setTab('available')}>
            Verfügbar
          </button>
          <span className="spacer" />
          <AsyncButton
            className="btn small"
            title="Plugin aus einem lokalen Ordner installieren"
            onClick={async () => {
              const folder = await bridge().dialog.openFolder('Plugin-Ordner wählen')
              if (folder) await install({ folder })
            }}
          >
            <FolderInput size={13} /> Aus Ordner
          </AsyncButton>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <input className="input" placeholder="Suchen …" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select className="select" style={{ width: 170 }} value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">Alle Kategorien</option>
            {categories.map((entry) => (
              <option key={entry}>{entry}</option>
            ))}
          </select>
        </div>

        {tab === 'installed' ? (
          list.loading && !list.data ? (
            <Spinner />
          ) : list.error ? (
            <div className="callout error">{list.error}</div>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              {(list.data ?? []).filter(matches).map((plugin) => (
                <button key={plugin.id} className="plugin-item" onClick={() => setSelected(plugin.id)}>
                  <div className="row" style={{ gap: 6 }}>
                    <StatusDot status={plugin.status === 'active' ? 'ok' : plugin.status === 'error' || plugin.status === 'crashed' ? 'error' : plugin.enabled ? 'running' : ''} />
                    <strong>{plugin.name}</strong>
                    <span className="faint">{plugin.version}</span>
                    <span className="spacer" />
                    <Badge kind={plugin.trust === 'trusted' ? 'ok' : 'warn'}>{plugin.trust === 'trusted' ? 'mitgeliefert' : 'Fremd-Plugin'}</Badge>
                    <Badge kind={plugin.status === 'active' ? 'ok' : plugin.status === 'error' || plugin.status === 'crashed' ? 'error' : undefined}>{STATUS[plugin.status] ?? plugin.status}</Badge>
                  </div>
                  <div className="muted plugin-description">{plugin.description}</div>
                  {plugin.lastError && plugin.status !== 'active' ? <div className="plugin-error">{plugin.lastError}</div> : null}
                </button>
              ))}
              {!(list.data ?? []).filter(matches).length ? <Empty>Keine Erweiterungen gefunden.</Empty> : null}
            </div>
          )
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <div className="card stack">
              <div className="section-title">Aus Git installieren</div>
              <div className="row" style={{ gap: 6 }}>
                <input className="input" placeholder="https://github.com/…/plugin.git" value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} />
                <AsyncButton className="btn small" disabled={!gitUrl.trim()} onClick={() => install({ gitUrl: gitUrl.trim() })}>
                  <GitBranch size={13} /> Installieren
                </AsyncButton>
              </div>
              <div className="faint" style={{ fontSize: 11.5 }}>
                Fremd-Plugins werden nur kopiert (keine Installationsskripte), auf Integrität geprüft und laufen isoliert. Sie bleiben deaktiviert, bis Sie ihre Berechtigungen bestätigen.
              </div>
            </div>
            {(catalog.data?.entries ?? []).filter(matches).map((entry) => (
              <div key={`${entry.source}:${entry.id}`} className="card stack" style={{ gap: 4 }}>
                <div className="row" style={{ gap: 6 }}>
                  <strong>{entry.name}</strong>
                  <span className="faint">{entry.version}</span>
                  <span className="spacer" />
                  {entry.installedVersion ? <Badge kind="ok">installiert {entry.installedVersion}</Badge> : null}
                  {entry.updateAvailable ? <Badge kind="accent">Update</Badge> : null}
                </div>
                <div className="muted">{entry.description}</div>
                <div className="row" style={{ gap: 6 }}>
                  {entry.categories.map((name) => (
                    <Badge key={name}>{name}</Badge>
                  ))}
                  <span className="spacer" />
                  {entry.installedVersion ? (
                    <button className="btn small" onClick={() => setSelected(entry.id)}>
                      Details
                    </button>
                  ) : entry.gitUrl ? (
                    <AsyncButton className="btn small primary" onClick={() => install({ gitUrl: entry.gitUrl })}>
                      Installieren
                    </AsyncButton>
                  ) : null}
                </div>
              </div>
            ))}
            <div className="faint" style={{ fontSize: 11.5 }}>
              Marktplatz: weitere Quellen (z. B. ein Plugin-Verzeichnis) liefern Einträge im selben Format; heute werden mitgelieferte Plugins und Einträge aus plugins/catalog.json angezeigt.
            </div>
          </div>
        )}
      </div>
      {downgrade ? (
        <Confirm
          title="Ältere Version installieren?"
          confirmLabel="Downgrade installieren"
          danger
          onCancel={() => setDowngrade(undefined)}
          onConfirm={() => {
            const input = downgrade
            setDowngrade(undefined)
            void install({ folder: input.folder, gitUrl: input.gitUrl, allowDowngrade: true }).catch((error: unknown) => notify(errorMessage(error), 'error'))
          }}
        >
          {downgrade.message}
        </Confirm>
      ) : null}
    </>
  )
}

function PluginDetail({ id, revision, onBack, onChanged }: { id: string; revision: number; onBack: () => void; onChanged: () => void }) {
  const details = useVisibleLoader(() => api.get<PluginDetails>(`/plugins/${enc(id)}`), [id], 5000)
  const [grantDialog, setGrantDialog] = useState(false)
  const [uninstall, setUninstall] = useState(false)
  const [secrets, setSecrets] = useState<{ available: boolean; names: string[] }>({ available: true, names: [] })

  useEffect(() => {
    if (revision) void details.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])
  useEffect(() => {
    void bridge()
      .secrets.names(`plugin:${id}`)
      .then(setSecrets)
      .catch(() => undefined)
  }, [id])

  const plugin = details.data
  if (!plugin) {
    return (
      <>
        <PanelHeader title="Erweiterung">
          <button className="icon-btn" title="Zurück" onClick={onBack}>
            <ArrowLeft size={14} />
          </button>
        </PanelHeader>
        <div className="panel-body">{details.error ? <div className="callout error">{details.error}</div> : <Spinner />}</div>
      </>
    )
  }

  const changed = async (work: Promise<unknown>) => {
    await work
    await details.reload()
    onChanged()
  }
  const trusted = plugin.trust === 'trusted'
  const requested = describePermissions(plugin.permissions ?? {}, trusted)

  return (
    <>
      <PanelHeader title={plugin.name}>
        <button className="icon-btn" title="Zurück zur Liste" aria-label="Zurück zur Liste" onClick={onBack}>
          <ArrowLeft size={14} />
        </button>
      </PanelHeader>
      <div className="panel-body stack" style={{ gap: 12 }}>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="faint">
              {plugin.version}
              {plugin.publisher ? ` · ${plugin.publisher}` : ''} · {plugin.source === 'builtin' ? 'mitgeliefert' : plugin.source === 'git' ? `Git: ${plugin.sourceRef}` : `Ordner: ${plugin.sourceRef}`}
            </span>
            <span className="spacer" />
            <Badge kind={trusted ? 'ok' : 'warn'}>{trusted ? 'vertrauenswürdig' : 'Fremd-Plugin (Sandbox)'}</Badge>
            <Badge kind={plugin.status === 'active' ? 'ok' : plugin.status === 'error' || plugin.status === 'crashed' ? 'error' : undefined}>{STATUS[plugin.status] ?? plugin.status}</Badge>
          </div>
          <div>{plugin.description}</div>
          {plugin.lastError && plugin.status !== 'active' ? <div className="callout error">{plugin.lastError}</div> : null}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {plugin.enabled ? (
              <AsyncButton className="btn small" onClick={() => changed(api.post(`/plugins/${enc(id)}/disable`))}>
                Deaktivieren
              </AsyncButton>
            ) : (
              <button className="btn small primary" onClick={() => setGrantDialog(true)}>
                Aktivieren …
              </button>
            )}
            {plugin.enabled && plugin.status !== 'active' ? (
              <AsyncButton className="btn small" onClick={() => changed(api.post(`/plugins/${enc(id)}/enable`, {}))}>
                Neu starten
              </AsyncButton>
            ) : null}
            {plugin.source !== 'builtin' ? (
              <>
                <AsyncButton className="btn small" onClick={() => changed(api.post(`/plugins/${enc(id)}/update`))}>
                  Aktualisieren
                </AsyncButton>
                <button className="btn small danger" onClick={() => setUninstall(true)}>
                  Deinstallieren
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="card stack" style={{ gap: 4 }}>
          <div className="section-title">Berechtigungen</div>
          {requested.length ? (
            requested.map((line) => <div key={line}>• {line}</div>)
          ) : (
            <div className="muted">Keine – das Plugin läuft vollständig in der Sandbox.</div>
          )}
          {plugin.enabled && plugin.missingGrants.length ? <div className="callout warn">Nicht gewährt: {plugin.missingGrants.join(', ')}</div> : null}
          {plugin.metrics ? (
            <div className="faint" style={{ fontSize: 11.5 }}>
              Prozess: {plugin.metrics.rssMb} MB Speicher, {Math.round(plugin.metrics.cpuMs / 1000)} s CPU
            </div>
          ) : null}
        </div>

        <PluginSettings plugin={plugin} secrets={secrets} onSecretsChanged={setSecrets} onSaved={() => void details.reload()} />

        {plugin.status === 'active'
          ? (plugin.contributes.views ?? []).map((view) => <PluginViewHost key={view.id} pluginId={id} viewId={view.id} title={view.title} revision={revision} />)
          : null}

        {(plugin.contributes.agentTools ?? []).length ? (
          <div className="card stack" style={{ gap: 4 }}>
            <div className="section-title">Agenten-Werkzeuge</div>
            {(plugin.contributes.agentTools ?? []).map((tool) => (
              <div key={tool.name}>
                <code>{tool.name}</code> {tool.sideEffects ? <Badge kind="warn">Seiteneffekte</Badge> : null} <span className="muted">– {tool.description}</span>
              </div>
            ))}
          </div>
        ) : null}

        {plugin.registrations?.contributions.length ? (
          <div className="card stack" style={{ gap: 4 }}>
            <div className="section-title">Weitere Erweiterungspunkte</div>
            {plugin.registrations.contributions.map((entry) => (
              <div key={`${entry.kind}:${entry.id}`}>
                {entry.kind}: {entry.id}
                <AsyncButton className="btn small" onClick={async () => {
                  await api.post(`/plugins/extensions/${enc(entry.kind)}/select`, { selected: { plugin: id, id: entry.id } })
                  notify(`${entry.kind}: ${entry.id} wird verwendet.`, 'success')
                }}>Verwenden</AsyncButton>
                <AsyncButton className="btn small" onClick={async () => {
                  await api.post(`/plugins/extensions/${enc(entry.kind)}/select`, { selected: null })
                  notify(`${entry.kind}: Standard wiederhergestellt.`, 'success')
                }}>Standard</AsyncButton>
              </div>
            ))}
          </div>
        ) : null}

        <details className="card">
          <summary className="section-title">Protokoll ({plugin.logs.length})</summary>
          <pre className="pre" style={{ marginTop: 8 }}>
            {plugin.logs
              .slice(-150)
              .map((line) => `${line.at.slice(11, 19)} ${line.level.padEnd(5)} ${line.message}`)
              .join('\n') || '(leer)'}
          </pre>
        </details>
      </div>

      {grantDialog ? (
        <Confirm
          title={`${plugin.name} aktivieren`}
          confirmLabel={requested.length ? 'Erlauben und aktivieren' : 'Aktivieren'}
          onCancel={() => setGrantDialog(false)}
          onConfirm={() => {
            setGrantDialog(false)
            void changed(api.post(`/plugins/${enc(id)}/enable`, { grant: plugin.permissions ?? {} })).catch((error: unknown) => notify(errorMessage(error), 'error'))
          }}
        >
          <div className="stack" style={{ gap: 6 }}>
            {requested.length ? (
              <>
                <div>Das Plugin erhält folgende Berechtigungen:</div>
                {requested.map((line) => (
                  <div key={line}>• {line}</div>
                ))}
              </>
            ) : (
              <div>Das Plugin benötigt keine Berechtigungen.</div>
            )}
            {!trusted ? <div className="callout warn">Fremd-Plugin: läuft in einem eigenen Prozess ohne direkten Datei-, Netzwerk- oder Prozesszugriff; jede Anfrage wird gegen diese Berechtigungen geprüft.</div> : null}
          </div>
        </Confirm>
      ) : null}
      {uninstall ? (
        <Confirm
          title={`${plugin.name} deinstallieren?`}
          confirmLabel="Deinstallieren"
          danger
          onCancel={() => setUninstall(false)}
          onConfirm={() => {
            setUninstall(false)
            void api
              .del(`/plugins/${enc(id)}`)
              .then(() => {
                onChanged()
                onBack()
              })
              .catch((error: unknown) => notify(errorMessage(error), 'error'))
          }}
        >
          Plugin-Dateien, Einstellungen und gespeicherte Daten des Plugins werden entfernt.
        </Confirm>
      ) : null}
    </>
  )
}

function PluginSettings({ plugin, secrets, onSecretsChanged, onSaved }: { plugin: PluginDetails; secrets: { available: boolean; names: string[] }; onSecretsChanged: (value: { available: boolean; names: string[] }) => void; onSaved: () => void }) {
  const declared = plugin.contributes.settings ?? []
  const [values, setValues] = useState<Record<string, unknown>>(plugin.settings)
  const [secretInput, setSecretInput] = useState<Record<string, string>>({})
  useEffect(() => setValues(plugin.settings), [plugin.settings])
  if (!declared.length) return null
  const scope = `plugin:${plugin.id}`
  const save = async () => {
    const changed = Object.fromEntries(declared.filter((setting) => setting.type !== 'secret' && values[setting.key] !== plugin.settings[setting.key]).map((setting) => [setting.key, values[setting.key]]))
    if (Object.keys(changed).length) await api.patch(`/plugins/${enc(plugin.id)}/settings`, { values: changed })
    for (const [name, value] of Object.entries(secretInput)) if (value) await bridge().secrets.set(scope, name, value)
    setSecretInput({})
    onSecretsChanged(await bridge().secrets.names(scope))
    notify('Einstellungen gespeichert.', 'success')
    onSaved()
  }
  return (
    <div className="card stack">
      <div className="section-title">Einstellungen</div>
      {declared.map((setting) => (
        <label key={setting.key} className="stack" style={{ gap: 3 }}>
          {setting.type === 'boolean' ? (
            <span className="row">
              <input type="checkbox" checked={Boolean(values[setting.key])} onChange={(event) => setValues({ ...values, [setting.key]: event.target.checked })} /> {setting.title}
            </span>
          ) : (
            <span>{setting.title}</span>
          )}
          {setting.type === 'secret' ? (
            <div className="row" style={{ gap: 6 }}>
              <input className="input" type="password" autoComplete="off" placeholder={secrets.names.includes(setting.key) ? '•••••••• (gespeichert)' : 'nicht gesetzt'} value={secretInput[setting.key] ?? ''} onChange={(event) => setSecretInput({ ...secretInput, [setting.key]: event.target.value })} />
              {secrets.names.includes(setting.key) ? (
                <AsyncButton
                  className="btn small"
                  onClick={async () => {
                    await bridge().secrets.delete(scope, setting.key)
                    onSecretsChanged(await bridge().secrets.names(scope))
                  }}
                >
                  Entfernen
                </AsyncButton>
              ) : null}
            </div>
          ) : setting.type === 'select' ? (
            <select className="select" value={String(values[setting.key] ?? setting.default ?? '')} onChange={(event) => setValues({ ...values, [setting.key]: event.target.value })}>
              {(setting.options ?? []).map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          ) : setting.type === 'boolean' ? null : (
            <input className="input" type={setting.type === 'number' ? 'number' : 'text'} value={String(values[setting.key] ?? '')} onChange={(event) => setValues({ ...values, [setting.key]: setting.type === 'number' ? Number(event.target.value) : event.target.value })} />
          )}
          {setting.description ? <span className="faint" style={{ fontSize: 11.5 }}>{setting.description}</span> : null}
        </label>
      ))}
      {!secrets.available && declared.some((setting) => setting.type === 'secret') ? <div className="callout warn">Verschlüsselter Speicher ist auf diesem System nicht verfügbar; Geheimnisse können nicht gespeichert werden.</div> : null}
      <div>
        <AsyncButton className="btn small primary" onClick={save}>
          Speichern
        </AsyncButton>
      </div>
    </div>
  )
}

interface ShownResult {
  at: number
  title?: string
  message?: string
  view?: ViewNode
}

/** One plugin view: rendered by the plugin process, actions call back into its commands. */
function PluginViewHost({ pluginId, viewId, title, revision }: { pluginId: string; viewId: string; title: string; revision: number }) {
  const [input, setInput] = useState<Record<string, unknown>>({})
  const view = useVisibleLoader(() => api.post<ViewNode>(`/plugins/${enc(pluginId)}/views/${enc(viewId)}`, { input }), [pluginId, viewId, JSON.stringify(input)], 60_000)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ShownResult[]>([])
  const [pending, setPending] = useState<ViewAction>()

  useEffect(() => {
    if (revision) void view.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  const run = async (action: ViewAction) => {
    setBusy(true)
    try {
      const result = await api.post<CommandResult>(`/plugins/${enc(pluginId)}/commands/${enc(action.command)}`, { args: { ...action.args, ...(action.confirm ? { confirmed: true } : {}) } })
      if (action.resultTarget === 'chat' && result.text) {
        const sessionId = appStore.get().workspace.activeSessionId
        const current = appStore.get().workspace.composer[composerKey(sessionId)]?.text ?? ''
        setComposerDraft(sessionId, { text: `${current ? `${current}\n\n` : ''}${result.text}` })
        notify(result.message ?? 'In den Chat übernommen.', 'success')
      } else if (result.message && !result.view) notify(result.message, 'success')
      if (result.reloadView) setInput(result.reloadView)
      if (result.view) setResults((current) => [{ at: Date.now(), title: result.title, message: result.message, view: result.view }, ...current].slice(0, 5))
      // state may have changed (e.g. a container was stopped): refresh the view
      if (!result.reloadView && action.resultTarget !== 'chat') void view.reload()
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const onAction = (action: ViewAction) => (action.confirm ? setPending(action) : void run(action))

  return (
    <div className="card stack plugin-view" data-plugin-view={`${pluginId}:${viewId}`}>
      <div className="row">
        <div className="section-title">{title}</div>
        <span className="spacer" />
        {busy || view.loading ? <Spinner /> : null}
        <button className="icon-btn" title="Neu laden" onClick={() => void view.reload()}>
          <RefreshCw size={13} />
        </button>
      </div>
      {results.map((result) => (
        <div key={result.at} className="plugin-result stack" style={{ gap: 6 }}>
          <div className="row">
            <strong>{result.title ?? 'Ergebnis'}</strong>
            {result.message ? <span className="muted">{result.message}</span> : null}
            <span className="spacer" />
            <button className="btn small ghost" onClick={() => setResults((current) => current.filter((entry) => entry.at !== result.at))}>
              Schließen
            </button>
          </div>
          {result.view ? <PluginView node={result.view} onAction={onAction} busy={busy} /> : null}
        </div>
      ))}
      {view.error ? <div className="callout error">{view.error}</div> : view.data ? <PluginView node={view.data} onAction={onAction} busy={busy} /> : <Spinner />}
      {pending ? (
        <Confirm
          title={pending.label}
          onCancel={() => setPending(undefined)}
          onConfirm={() => {
            const action = pending
            setPending(undefined)
            void run(action)
          }}
        >
          {pending.confirm}
        </Confirm>
      ) : null}
    </div>
  )
}
