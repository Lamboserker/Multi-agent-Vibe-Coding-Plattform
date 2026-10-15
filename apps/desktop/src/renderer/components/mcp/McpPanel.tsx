import { useEffect, useState } from 'react'
import { ArrowLeft, Plus, RefreshCw, Upload } from 'lucide-react'
import { notify } from '../../lib/actions'
import { api, bridge, enc, errorMessage } from '../../lib/api'
import { useVisibleLoader } from '../../lib/hooks'
import { useAppState } from '../../lib/store'
import { useStore } from '../../lib/store/core'
import { pluginStore } from '../../lib/stores'
import { AsyncButton, Badge, Confirm, Empty, PanelHeader, Spinner, StatusDot } from '../common'
import { RolePicker } from '../skills/SkillsPanel'

type Policy = 'allow' | 'confirm' | 'off'

interface McpTool {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
  policy: Policy
}

interface McpServer {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command: string | null
  args: string[]
  env: Record<string, string>
  secretEnv: string[]
  cwd: string | null
  url: string | null
  headers: Record<string, string>
  secretHeaders: Array<{ header: string; secret: string; prefix?: string }>
  oauth?: { enabled?: boolean; clientId?: string; scope?: string }
  enabled: boolean
  timeoutMs: number
  toolPolicies: Record<string, Policy>
  defaultPolicy: Policy
  agents: string[]
  status: string
  lastError: string | null
  connection: { kind: string; connectedAt: string; lastUsed: string } | null
  tools: McpTool[] | null
  toolsAt: string | null
}

interface McpDetails extends McpServer {
  logs: Array<{ at: string; level: string; message: string }>
}

const POLICY_LABEL: Record<Policy, string> = { allow: 'Agenten erlaubt', confirm: 'nur mit Bestätigung', off: 'aus' }
const statusDot = (server: McpServer) => (server.status === 'connected' ? 'ok' : server.status === 'error' ? 'error' : server.status === 'connecting' ? 'running' : '')

const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
const pairs = (text: string, separator: string) => Object.fromEntries(lines(text).filter((line) => line.includes(separator)).map((line) => [line.slice(0, line.indexOf(separator)).trim(), line.slice(line.indexOf(separator) + separator.length).trim()]))

export function McpPanel() {
  const projectId = useAppState((state) => state.project?.id)
  const revision = useStore(pluginStore, (state) => state.revision)
  const servers = useVisibleLoader(() => api.get<McpServer[]>('/mcp/servers'), [])
  const discovered = useVisibleLoader(() => (projectId ? api.get<Array<{ file: string; servers: string[]; json: string }>>(`/mcp/discover?projectId=${enc(projectId)}`) : Promise.resolve([])), [projectId], 60_000)
  const [selected, setSelected] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState<string>()

  useEffect(() => {
    if (revision) void servers.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  if (creating) return <ServerForm onDone={(id) => { setCreating(false); void servers.reload(); if (id) setSelected(id) }} />
  if (selected) return <ServerDetail id={selected} onBack={() => { setSelected(undefined); void servers.reload() }} />

  const runImport = async (json: string) => {
    const results = await api.post<Array<{ name: string; ok: boolean; error?: string; secretsStored?: string[] }>>('/mcp/import', { json })
    const failed = results.filter((result) => !result.ok)
    notify(`${results.length - failed.length} Server importiert (deaktiviert – bitte prüfen und aktivieren)${failed.length ? `; Fehler: ${failed.map((result) => `${result.name}: ${result.error}`).join('; ')}` : ''}.`, failed.length ? 'error' : 'success')
    setImporting(undefined)
    await servers.reload()
  }

  return (
    <>
      <PanelHeader title="MCP-Server">
        <button className="icon-btn" title="Aktualisieren" onClick={() => void servers.reload()}>
          <RefreshCw size={14} />
        </button>
      </PanelHeader>
      <div className="panel-body stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small primary" onClick={() => setCreating(true)}>
            <Plus size={13} /> Server hinzufügen
          </button>
          <button className="btn small" onClick={() => setImporting('')}>
            <Upload size={13} /> JSON importieren
          </button>
        </div>
        {(discovered.data ?? []).filter((entry) => entry.servers.length).map((entry) => (
          <div key={entry.file} className="callout">
            Im Projekt gefunden: <code>{entry.file}</code> mit {entry.servers.join(', ')}.{' '}
            <button className="btn small" onClick={() => setImporting(entry.json)}>
              Prüfen und importieren
            </button>
            <div className="faint" style={{ fontSize: 11.5 }}>Konfigurationen aus einem Repository werden nie automatisch gestartet.</div>
          </div>
        ))}
        {servers.loading && !servers.data ? <Spinner /> : null}
        {servers.error ? <div className="callout error">{servers.error}</div> : null}
        <div className="stack" style={{ gap: 6 }}>
          {(servers.data ?? []).map((server) => (
            <button key={server.id} className="plugin-item" onClick={() => setSelected(server.id)}>
              <div className="row" style={{ gap: 6 }}>
                <StatusDot status={statusDot(server)} />
                <strong>{server.name}</strong>
                <Badge>{server.transport === 'stdio' ? 'stdio' : 'HTTP'}</Badge>
                <span className="spacer" />
                {server.tools ? <span className="faint">{server.tools.length} Werkzeuge</span> : null}
                <Badge kind={server.enabled ? (server.status === 'error' ? 'error' : 'ok') : undefined}>{server.enabled ? server.status : 'deaktiviert'}</Badge>
              </div>
              <div className="muted plugin-description truncate">{server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.url}</div>
              {server.lastError && server.status === 'error' ? <div className="plugin-error">{server.lastError}</div> : null}
            </button>
          ))}
          {!servers.loading && !(servers.data ?? []).length ? <Empty>Noch keine MCP-Server. Server hinzufügen oder eine Konfiguration (z. B. aus Claude Desktop) importieren.</Empty> : null}
        </div>
      </div>
      {importing !== undefined ? (
        <ImportDialog initial={importing} onCancel={() => setImporting(undefined)} onImport={(json) => void runImport(json).catch((error: unknown) => notify(errorMessage(error), 'error'))} />
      ) : null}
    </>
  )
}

function ImportDialog({ initial, onCancel, onImport }: { initial: string; onCancel: () => void; onImport: (json: string) => void }) {
  const [json, setJson] = useState(initial || '{\n  "mcpServers": {\n    \n  }\n}')
  return (
    <Confirm title="MCP-Konfiguration importieren" confirmLabel="Importieren" onCancel={onCancel} onConfirm={() => onImport(json)}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="muted">Format wie in Claude Desktop / Claude Code (<code>mcpServers</code>). Zugangsdaten in Umgebungsvariablen und Headern werden verschlüsselt gespeichert; importierte Server starten deaktiviert.</div>
        <textarea className="textarea mono" rows={14} style={{ minWidth: 480 }} value={json} onChange={(event) => setJson(event.target.value)} />
      </div>
    </Confirm>
  )
}

function ServerForm({ server, onDone }: { server?: McpServer; onDone: (id?: string) => void }) {
  const [transport, setTransport] = useState<'stdio' | 'http'>(server?.transport ?? 'stdio')
  const [name, setName] = useState(server?.name ?? '')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState((server?.args ?? []).join('\n'))
  const [env, setEnv] = useState(Object.entries(server?.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'))
  const [secretEnv, setSecretEnv] = useState((server?.secretEnv ?? []).join(', '))
  const [cwd, setCwd] = useState(server?.cwd ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [headers, setHeaders] = useState(Object.entries(server?.headers ?? {}).map(([key, value]) => `${key}: ${value}`).join('\n'))
  const [authHeader, setAuthHeader] = useState(server?.secretHeaders.some((entry) => entry.header.toLowerCase() === 'authorization') ?? false)
  const [timeout, setTimeoutSeconds] = useState(String(Math.round((server?.timeoutMs ?? 60_000) / 1000)))
  const [defaultPolicy, setDefaultPolicy] = useState<Policy>(server?.defaultPolicy ?? 'confirm')

  const save = async () => {
    const payload = {
      name,
      transport,
      command: transport === 'stdio' ? command.trim() : '',
      args: transport === 'stdio' ? lines(args) : [],
      env: transport === 'stdio' ? pairs(env, '=') : {},
      secretEnv: transport === 'stdio' ? secretEnv.split(',').map((entry) => entry.trim()).filter(Boolean) : [],
      cwd: transport === 'stdio' ? cwd.trim() : '',
      url: transport === 'http' ? url.trim() : '',
      headers: transport === 'http' ? pairs(headers, ':') : {},
      secretHeaders: transport === 'http' && authHeader ? [{ header: 'Authorization', secret: 'token', prefix: 'Bearer ' }] : [],
      timeoutMs: Math.max(1, Number(timeout) || 60) * 1000,
      defaultPolicy,
    }
    const saved = server ? await api.patch<McpServer>(`/mcp/servers/${enc(server.id)}`, payload) : await api.post<McpServer>('/mcp/servers', payload)
    notify(`${saved.name} gespeichert.`, 'success')
    onDone(saved.id)
  }

  return (
    <>
      <PanelHeader title={server ? `${server.name} bearbeiten` : 'MCP-Server hinzufügen'}>
        <button className="icon-btn" title="Abbrechen" aria-label="Zurück zur Liste" onClick={() => onDone()}>
          <ArrowLeft size={14} />
        </button>
      </PanelHeader>
      <div className="panel-body stack" style={{ gap: 10 }}>
        <label className="stack" style={{ gap: 3 }}>
          <span>Name</span>
          <input className="input" value={name} placeholder="z. B. github" onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="stack" style={{ gap: 3 }}>
          <span>Transport</span>
          <select className="select" value={transport} onChange={(event) => setTransport(event.target.value as 'stdio' | 'http')}>
            <option value="stdio">stdio (lokaler Prozess)</option>
            <option value="http">HTTP (Streamable HTTP, Fallback SSE)</option>
          </select>
        </label>
        {transport === 'stdio' ? (
          <>
            <label className="stack" style={{ gap: 3 }}>
              <span>Befehl</span>
              <input className="input mono" value={command} placeholder="npx" onChange={(event) => setCommand(event.target.value)} />
            </label>
            <label className="stack" style={{ gap: 3 }}>
              <span>Argumente (eins pro Zeile)</span>
              <textarea className="textarea mono" rows={3} value={args} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Projekte'} onChange={(event) => setArgs(event.target.value)} />
            </label>
            <label className="stack" style={{ gap: 3 }}>
              <span>Umgebungsvariablen (NAME=Wert, nicht geheim)</span>
              <textarea className="textarea mono" rows={2} value={env} onChange={(event) => setEnv(event.target.value)} />
            </label>
            <label className="stack" style={{ gap: 3 }}>
              <span>Geheime Umgebungsvariablen (Namen, kommagetrennt)</span>
              <input className="input mono" value={secretEnv} placeholder="GITHUB_TOKEN" onChange={(event) => setSecretEnv(event.target.value)} />
              <span className="faint" style={{ fontSize: 11.5 }}>Werte setzen Sie nach dem Speichern; sie werden verschlüsselt abgelegt.</span>
            </label>
            <label className="stack" style={{ gap: 3 }}>
              <span>Arbeitsordner (optional)</span>
              <input className="input mono" value={cwd} onChange={(event) => setCwd(event.target.value)} />
            </label>
          </>
        ) : (
          <>
            <label className="stack" style={{ gap: 3 }}>
              <span>URL</span>
              <input className="input mono" value={url} placeholder="https://example.com/mcp" onChange={(event) => setUrl(event.target.value)} />
            </label>
            <label className="stack" style={{ gap: 3 }}>
              <span>Header (Name: Wert, nicht geheim)</span>
              <textarea className="textarea mono" rows={2} value={headers} onChange={(event) => setHeaders(event.target.value)} />
            </label>
            <label className="row">
              <input type="checkbox" checked={authHeader} onChange={(event) => setAuthHeader(event.target.checked)} /> Authentifizierung mit Bearer-Token (verschlüsselt gespeichert)
            </label>
          </>
        )}
        <div className="row" style={{ gap: 10 }}>
          <label className="stack" style={{ gap: 3, width: 140 }}>
            <span>Timeout (s)</span>
            <input className="input" type="number" min={1} value={timeout} onChange={(event) => setTimeoutSeconds(event.target.value)} />
          </label>
          <label className="stack" style={{ gap: 3, flex: 1 }}>
            <span>Standard für neue Werkzeuge</span>
            <select className="select" value={defaultPolicy} onChange={(event) => setDefaultPolicy(event.target.value as Policy)}>
              <option value="confirm">nur mit Bestätigung (empfohlen)</option>
              <option value="allow">Agenten dürfen sie nutzen</option>
              <option value="off">aus</option>
            </select>
          </label>
        </div>
        <div>
          <AsyncButton className="btn primary small" disabled={!name.trim() || (transport === 'stdio' ? !command.trim() : !url.trim())} onClick={save}>
            Speichern
          </AsyncButton>
        </div>
      </div>
    </>
  )
}

function ServerDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const revision = useStore(pluginStore, (state) => state.revision)
  const server = useVisibleLoader(() => api.get<McpDetails>(`/mcp/servers/${enc(id)}`), [id], 5000)
  const [editing, setEditing] = useState(false)
  const [remove, setRemove] = useState(false)
  const [secretNames, setSecretNames] = useState<string[]>([])
  const [secretInput, setSecretInput] = useState<Record<string, string>>({})
  const [trying, setTrying] = useState<McpTool>()
  const [result, setResult] = useState<{ tool: string; text: string; isError: boolean; durationMs: number; fullText?: string }>()

  useEffect(() => {
    if (revision) void server.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])
  const refreshSecrets = () =>
    void bridge()
      .secrets.names(`mcp:${id}`)
      .then((value) => setSecretNames(value.names))
      .catch(() => undefined)
  useEffect(refreshSecrets, [id])

  const data = server.data
  if (editing && data) return <ServerForm server={data} onDone={() => { setEditing(false); void server.reload() }} />
  const patch = (body: Record<string, unknown>) => api.patch(`/mcp/servers/${enc(id)}`, body).then(() => server.reload())
  const secrets = data ? [...data.secretEnv.map((name) => ({ name, label: `Umgebungsvariable ${name}` })), ...data.secretHeaders.map((entry) => ({ name: entry.secret, label: `Header ${entry.header}${entry.prefix ? ` (${entry.prefix.trim()} …)` : ''}` }))] : []

  return (
    <>
      <PanelHeader title={data?.name ?? 'MCP-Server'}>
        <button className="icon-btn" title="Zurück zur Liste" aria-label="Zurück zur Liste" onClick={onBack}>
          <ArrowLeft size={14} />
        </button>
      </PanelHeader>
      <div className="panel-body stack" style={{ gap: 12 }}>
        {!data ? (
          server.error ? <div className="callout error">{server.error}</div> : <Spinner />
        ) : (
          <>
            <div className="stack" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 6 }}>
                <StatusDot status={statusDot(data)} />
                <span>{data.enabled ? data.status : 'deaktiviert'}</span>
                {data.connection ? <span className="faint">über {data.connection.kind}</span> : null}
                <span className="spacer" />
                <label className="row">
                  <input type="checkbox" checked={data.enabled} onChange={(event) => { server.setData({ ...data, enabled: event.target.checked }); void patch({ enabled: event.target.checked }).catch((error: unknown) => notify(errorMessage(error), 'error')) }} /> aktiviert
                </label>
              </div>
              <code className="truncate">{data.transport === 'stdio' ? `${data.command} ${data.args.join(' ')}` : data.url}</code>
              {data.lastError && data.status === 'error' ? <div className="callout error">{data.lastError}</div> : null}
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <AsyncButton
                  className="btn small primary"
                  disabled={!data.enabled}
                  onClick={async () => {
                    const test = await api.post<{ ms: number; kind: string }>(`/mcp/servers/${enc(id)}/test`)
                    notify(`Verbunden (${test.kind}), Antwortzeit ${test.ms} ms.`, 'success')
                    await server.reload()
                  }}
                >
                  Verbindung testen
                </AsyncButton>
                {data.transport === 'http' ? <>
                  <label className="row"><input type="checkbox" checked={data.oauth?.enabled === true} onChange={(event) => void api.patch(`/mcp/servers/${enc(id)}`, { oauth: { ...data.oauth, enabled: event.target.checked } }).then(() => server.reload()).catch((error) => notify(errorMessage(error), 'error'))} /> OAuth</label>
                  {data.oauth?.enabled ? <>
                    <AsyncButton className="btn small" onClick={async () => {
                      const result = await api.post<{ authorized: boolean; authorizationUrl?: string }>(`/mcp/servers/${enc(id)}/oauth/login`)
                      if (result.authorizationUrl) await bridge().shell.openExternal(result.authorizationUrl)
                      notify(result.authorized ? 'OAuth verbunden.' : 'Anmeldung im Browser geöffnet.', 'success')
                      await server.reload()
                    }}>OAuth anmelden</AsyncButton>
                    <AsyncButton className="btn small" onClick={() => api.post(`/mcp/servers/${enc(id)}/oauth/logout`).then(() => server.reload())}>OAuth abmelden</AsyncButton>
                  </> : null}
                </> : null}
                {data.connection ? (
                  <AsyncButton className="btn small" onClick={() => api.post(`/mcp/servers/${enc(id)}/disconnect`).then(() => server.reload())}>
                    Trennen
                  </AsyncButton>
                ) : null}
                <button className="btn small" onClick={() => setEditing(true)}>
                  Bearbeiten
                </button>
                <button className="btn small danger" onClick={() => setRemove(true)}>
                  Entfernen
                </button>
              </div>
            </div>

            {secrets.length ? (
              <div className="card stack">
                <div className="section-title">Zugangsdaten (verschlüsselt)</div>
                {secrets.map((secret) => (
                  <label key={secret.name} className="stack" style={{ gap: 3 }}>
                    <span>{secret.label}</span>
                    <div className="row" style={{ gap: 6 }}>
                      <input className="input" type="password" autoComplete="off" placeholder={secretNames.includes(secret.name) ? '•••••••• (gespeichert)' : 'nicht gesetzt'} value={secretInput[secret.name] ?? ''} onChange={(event) => setSecretInput({ ...secretInput, [secret.name]: event.target.value })} />
                      <AsyncButton
                        className="btn small"
                        disabled={!secretInput[secret.name]}
                        onClick={async () => {
                          await bridge().secrets.set(`mcp:${id}`, secret.name, secretInput[secret.name]!)
                          setSecretInput({ ...secretInput, [secret.name]: '' })
                          refreshSecrets()
                          // the next use reconnects with the new value
                          await api.post(`/mcp/servers/${enc(id)}/disconnect`)
                        }}
                      >
                        Speichern
                      </AsyncButton>
                    </div>
                  </label>
                ))}
              </div>
            ) : null}

            <div className="card stack">
              <div className="section-title">Agenten</div>
              <RolePicker value={data.agents} onChange={(agents) => void patch({ agents }).catch((error: unknown) => notify(errorMessage(error), 'error'))} />
              <div className="faint" style={{ fontSize: 11.5 }}>Autonome Agenten erhalten nur Werkzeuge mit „Agenten erlaubt“ (max. 24, die zur Aufgabe passendsten). Werkzeuge mit Bestätigung rufen nur Sie hier auf.</div>
            </div>

            <div className="card stack">
              <div className="row">
                <div className="section-title">Werkzeuge{data.tools ? ` (${data.tools.length})` : ''}</div>
                <span className="spacer" />
                {data.toolsAt ? <span className="faint">Stand {new Date(data.toolsAt).toLocaleString('de-DE')}</span> : null}
              </div>
              {!data.tools ? (
                <div className="muted">Noch nicht abgefragt – „Verbindung testen“ lädt die Werkzeugliste.</div>
              ) : (
                <div className="plugin-table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Werkzeug</th>
                        <th>Freigabe</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.tools.map((tool) => (
                        <tr key={tool.name}>
                          <td>
                            <code>{tool.name}</code> {tool.annotations?.readOnlyHint ? <Badge kind="ok">liest nur</Badge> : null} {tool.annotations?.destructiveHint ? <Badge kind="error">verändert/löscht</Badge> : null}
                            <div className="muted" style={{ fontSize: 12 }}>
                              {tool.description}
                            </div>
                          </td>
                          <td>
                            <select className="select" value={tool.policy} onChange={(event) => { const policy = event.target.value as Policy; server.setData({ ...data, toolPolicies: { ...data.toolPolicies, [tool.name]: policy }, tools: data.tools!.map((entry) => (entry.name === tool.name ? { ...entry, policy } : entry)) }); void patch({ toolPolicies: { ...data.toolPolicies, [tool.name]: policy } }).catch((error: unknown) => notify(errorMessage(error), 'error')) }}>
                              {(['allow', 'confirm', 'off'] as const).map((policy) => (
                                <option key={policy} value={policy}>
                                  {POLICY_LABEL[policy]}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <button className="btn small" disabled={tool.policy === 'off'} onClick={() => setTrying(tool)}>
                              Ausprobieren
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {result ? (
                <div className="plugin-result stack" style={{ gap: 4 }}>
                  <div className="row">
                    <strong>{result.tool}</strong>
                    <Badge kind={result.isError ? 'error' : 'ok'}>{result.isError ? 'Fehler' : 'ok'}</Badge>
                    <span className="faint">{result.durationMs} ms</span>
                    {result.fullText ? <span className="faint">gekürzt: {result.text.length.toLocaleString()} von {result.fullText.length.toLocaleString()} Zeichen</span> : null}
                    <span className="spacer" />
                    {result.fullText ? (
                      <AsyncButton className="btn small" onClick={async () => { const saved = await bridge().dialog.saveText(`${result.tool}-ergebnis.txt`, result.fullText!); if (saved) notify(`Vollständiges Ergebnis gespeichert: ${saved}`, 'success') }}>
                        Vollständig speichern…
                      </AsyncButton>
                    ) : null}
                    <button className="btn small ghost" onClick={() => setResult(undefined)}>
                      Schließen
                    </button>
                  </div>
                  <pre className="pre">{result.text || '(keine Ausgabe)'}</pre>
                </div>
              ) : null}
            </div>

            <details className="card">
              <summary className="section-title">Protokoll ({data.logs.length})</summary>
              <pre className="pre" style={{ marginTop: 8 }}>
                {data.logs
                  .slice(-150)
                  .map((line) => `${line.at.slice(11, 19)} ${line.level.padEnd(6)} ${line.message}`)
                  .join('\n') || '(leer)'}
              </pre>
            </details>
          </>
        )}
      </div>
      {trying ? <TryTool serverId={id} tool={trying} onClose={() => setTrying(undefined)} onResult={(value) => setResult({ tool: trying.name, ...value })} /> : null}
      {remove && data ? (
        <Confirm
          title={`${data.name} entfernen?`}
          confirmLabel="Entfernen"
          danger
          onCancel={() => setRemove(false)}
          onConfirm={() => {
            setRemove(false)
            void api
              .del(`/mcp/servers/${enc(id)}`)
              .then(onBack)
              .catch((error: unknown) => notify(errorMessage(error), 'error'))
          }}
        >
          Die Konfiguration wird gelöscht; gespeicherte Zugangsdaten bleiben im Tresor, bis Sie sie überschreiben.
        </Confirm>
      ) : null}
    </>
  )
}

/** Manual tool call: arguments as JSON, always confirmed by the user. */
function TryTool({ serverId, tool, onClose, onResult }: { serverId: string; tool: McpTool; onClose: () => void; onResult: (result: { text: string; isError: boolean; durationMs: number; fullText?: string }) => void }) {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>
  const [json, setJson] = useState(JSON.stringify(Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, schema.type === 'number' || schema.type === 'integer' ? 0 : schema.type === 'boolean' ? false : ''])), null, 2))
  const [busy, setBusy] = useState(false)
  return (
    <Confirm
      title={`${tool.name} aufrufen`}
      confirmLabel={busy ? 'Läuft …' : 'Aufrufen'}
      danger={Boolean(tool.annotations?.destructiveHint)}
      onCancel={onClose}
      onConfirm={() => {
        if (busy) return
        let args: unknown
        try {
          args = JSON.parse(json)
        } catch {
          notify('Die Argumente sind kein gültiges JSON.', 'error')
          return
        }
        setBusy(true)
        void api
          .post<{ text: string; isError: boolean; durationMs: number; fullText?: string }>(`/mcp/servers/${enc(serverId)}/tools/${enc(tool.name)}/call`, { args })
          .then((value) => {
            onResult(value)
            onClose()
          })
          .catch((error: unknown) => notify(errorMessage(error), 'error'))
          .finally(() => setBusy(false))
      }}
    >
      <div className="stack" style={{ gap: 6 }}>
        <div className="muted">{tool.description}</div>
        {tool.annotations?.destructiveHint ? <div className="callout warn">Dieses Werkzeug kann Daten verändern oder löschen.</div> : null}
        <textarea className="textarea mono" rows={8} style={{ minWidth: 420 }} value={json} onChange={(event) => setJson(event.target.value)} />
        <details>
          <summary className="faint">Schema</summary>
          <pre className="pre">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
        </details>
      </div>
    </Confirm>
  )
}
