import { useEffect, useState } from 'react'
import { ArrowLeft, FolderInput, Plus, RefreshCw } from 'lucide-react'
import { notify } from '../../lib/actions'
import { api, bridge, enc, errorMessage } from '../../lib/api'
import { useVisibleLoader } from '../../lib/hooks'
import { useAppState } from '../../lib/store'
import { useStore } from '../../lib/store/core'
import { pluginStore } from '../../lib/stores'
import { AsyncButton, Badge, Confirm, Empty, PanelHeader, Spinner } from '../common'
import { IntegrationsPanel } from '../integrations/IntegrationsPanel'

interface Skill {
  key: string
  source: 'builtin' | 'user' | 'project'
  location: string
  name: string
  description: string
  triggers: string[]
  tools?: string[]
  allowedActions?: string[]
  resources?: string[]
  testTask?: string
  bodyChars: number
  files: string[]
  scripts: string[]
  scriptsHash?: string
  scriptsApproved: boolean
  enabled: boolean
  agents: string[]
  error?: string
  editable: boolean
}

interface SkillDetails extends Skill {
  body: string
}

const SOURCE_LABEL: Record<Skill['source'], string> = { builtin: 'App', user: 'Benutzer', project: 'Projekt' }
export const ROLES: Array<{ id: string; label: string }> = [
  { id: 'planner', label: 'Planer (Premium)' },
  { id: 'coder', label: 'Lokale Coder-Agenten' },
  { id: 'chat', label: 'Chat-Fragen' },
  { id: 'designer', label: 'Designer (Premium)' },
]

/** Role checkboxes ("*" = all roles); updates immediately, the saved value follows. */
export function RolePicker({ value: saved, onChange: save }: { value: string[]; onChange: (agents: string[]) => void }) {
  const [value, setValue] = useState(saved)
  useEffect(() => setValue(saved), [saved])
  const onChange = (agents: string[]) => {
    setValue(agents)
    save(agents)
  }
  const all = value.includes('*')
  return (
    <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
      <label className="row">
        <input type="checkbox" checked={all} onChange={(event) => onChange(event.target.checked ? ['*'] : ROLES.map((role) => role.id))} /> Alle Agenten
      </label>
      {ROLES.map((role) => (
        <label key={role.id} className="row">
          <input
            type="checkbox"
            disabled={all}
            checked={all || value.includes(role.id)}
            onChange={(event) => onChange(event.target.checked ? [...value.filter((entry) => entry !== '*'), role.id] : value.filter((entry) => entry !== role.id))}
          />{' '}
          {role.label}
        </label>
      ))}
    </div>
  )
}

export function SkillsPanel() {
  const projectId = useAppState((state) => state.project?.id)
  const revision = useStore(pluginStore, (state) => state.revision)
  const skills = useVisibleLoader(() => api.get<Skill[]>(`/skills${projectId ? `?projectId=${enc(projectId)}` : ''}`), [projectId])
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState(false)
  const [source, setSource] = useState('')
  const [selected, setSelected] = useState<string>()
  const [builder, setBuilder] = useState<{ initial?: SkillDetails } | null>(null)
  const [preview, setPreview] = useState('')
  const [previewResult, setPreviewResult] = useState<{ inlined: string[]; indexed: string[] }>()

  useEffect(() => {
    if (revision) void skills.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  if (builder) return <SkillBuilder initial={builder.initial} projectId={projectId} onDone={(key) => { setBuilder(null); void skills.reload(); if (key) setSelected(key) }} />
  if (selected) return <SkillDetail skillKey={selected} onBack={() => { setSelected(undefined); void skills.reload() }} onEdit={(initial) => setBuilder({ initial })} />
  if (catalog) return <IntegrationsPanel initialTab="skills" onBack={() => { setCatalog(false); void skills.reload() }} />

  const visible = (skills.data ?? []).filter((skill) => (!source || skill.source === source) && (!query || `${skill.name} ${skill.description} ${skill.triggers.join(' ')}`.toLowerCase().includes(query.toLowerCase())))
  return (
    <>
      <PanelHeader title="Skills">
        <button className="btn small primary" onClick={() => setCatalog(true)}>Integrationskatalog</button>
        <button className="icon-btn" title="Aktualisieren" onClick={() => void skills.reload()}>
          <RefreshCw size={14} />
        </button>
      </PanelHeader>
      <div className="panel-body stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small primary" onClick={() => setBuilder({})}>
            <Plus size={13} /> Neuer Skill
          </button>
          <AsyncButton
            className="btn small"
            onClick={async () => {
              const folder = await bridge().dialog.openFolder('Skill-Ordner (mit SKILL.md) wählen')
              if (!folder) return
              const skill = await api.post<Skill>('/skills/import', { folder })
              notify(`Skill ${skill.name} importiert.`, 'success')
              await skills.reload()
              setSelected(skill.key)
            }}
          >
            <FolderInput size={13} /> Importieren
          </AsyncButton>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <input className="input" placeholder="Suchen …" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select className="select" style={{ width: 150 }} value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="">Alle Quellen</option>
            <option value="builtin">App</option>
            <option value="user">Benutzer</option>
            <option value="project">Projekt</option>
          </select>
        </div>
        <div className="faint" style={{ fontSize: 11.5 }}>
          Skills werden automatisch gefunden: mitgelieferte, eigene (Benutzer) und im Projekt unter <code>.multi-ai-coder/skills</code> oder <code>.claude/skills</code>. Agenten erhalten passende Skills vollständig, alle anderen nur als Liste zum Nachladen.
        </div>
        {skills.loading && !skills.data ? <Spinner /> : null}
        {skills.error ? <div className="callout error">{skills.error}</div> : null}
        <div className="stack" style={{ gap: 6 }}>
          {visible.map((skill) => (
            <button key={skill.key} className="plugin-item" onClick={() => setSelected(skill.key)}>
              <div className="row" style={{ gap: 6 }}>
                <strong>{skill.name}</strong>
                <Badge>{SOURCE_LABEL[skill.source]}</Badge>
                <span className="spacer" />
                {skill.scripts.length ? <Badge kind={skill.scriptsApproved ? 'ok' : 'warn'}>{skill.scriptsApproved ? 'Skripte erlaubt' : 'Skripte gesperrt'}</Badge> : null}
                <Badge kind={skill.error ? 'error' : skill.enabled ? 'ok' : undefined}>{skill.error ? 'fehlerhaft' : skill.enabled ? 'aktiv' : 'aus'}</Badge>
              </div>
              <div className="muted plugin-description">{skill.error ?? skill.description}</div>
              {skill.triggers.length ? <div className="faint" style={{ fontSize: 11.5 }}>Auslöser: {skill.triggers.join(', ')}</div> : null}
            </button>
          ))}
          {!visible.length && !skills.loading ? <Empty>Keine Skills gefunden.</Empty> : null}
        </div>
        <div className="card stack">
          <div className="section-title">Vorschau: Welche Skills bekommt ein Agent?</div>
          <div className="row" style={{ gap: 6 }}>
            <input className="input" placeholder="Aufgabe, z. B. „Tests für den Login ergänzen“" value={preview} onChange={(event) => setPreview(event.target.value)} />
            <AsyncButton className="btn small" disabled={!preview.trim()} onClick={async () => setPreviewResult(await api.get(`/skills/preview?role=coder&goal=${enc(preview)}${projectId ? `&projectId=${enc(projectId)}` : ''}`))}>
              Prüfen
            </AsyncButton>
          </div>
          {previewResult ? (
            <div className="stack" style={{ gap: 2 }}>
              <div>Vollständig im Kontext: {previewResult.inlined.join(', ') || '–'}</div>
              <div className="muted">Zum Nachladen angeboten: {previewResult.indexed.join(', ') || '–'}</div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

interface SkillTestResult {
  ok: boolean
  role: string
  selection: 'inlined' | 'offered' | 'not_selected'
  score: number
  missingResources: string[]
  missingTools: string[]
  unknownActions: string[]
  prompt: string
}

function SkillDetail({ skillKey, onBack, onEdit }: { skillKey: string; onBack: () => void; onEdit: (skill: SkillDetails) => void }) {
  const projectId = useAppState((state) => state.project?.id)
  const [projectScope, setProjectScope] = useState(Boolean(projectId))
  const skill = useVisibleLoader(() => api.get<SkillDetails>(`/skills/${enc(skillKey)}${projectScope && projectId ? `?projectId=${enc(projectId)}` : ''}`), [skillKey, projectId, projectScope], 5000)
  const [scriptText, setScriptText] = useState<Record<string, string>>({})
  const [approve, setApprove] = useState(false)
  const [remove, setRemove] = useState(false)
  const [testResult, setTestResult] = useState<SkillTestResult>()
  const data = skill.data

  const loadScripts = async () => {
    if (!data) return
    const texts: Record<string, string> = {}
    for (const script of data.scripts) {
      // the bridge parses JSON-looking bodies; show the file text either way
      const value = await api.get<unknown>(`/skills/${enc(skillKey)}/files?path=${enc(script)}`)
      texts[script] = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    }
    setScriptText(texts)
  }

  return (
    <>
      <PanelHeader title={data?.name ?? 'Skill'}>
        <button className="icon-btn" title="Zurück zur Liste" aria-label="Zurück zur Liste" onClick={onBack}>
          <ArrowLeft size={14} />
        </button>
      </PanelHeader>
      <div className="panel-body stack" style={{ gap: 12 }}>
        {!data ? (
          skill.error ? <div className="callout error">{skill.error}</div> : <Spinner />
        ) : (
          <>
            <div className="stack" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 6 }}>
                <Badge>{SOURCE_LABEL[data.source]}</Badge>
                <span className="faint">{data.location}</span>
                <span className="spacer" />
                <label className="row">
                  <input type="checkbox" checked={data.enabled} onChange={(event) => { skill.setData({ ...data, enabled: event.target.checked }); void api.patch(`/skills/${enc(skillKey)}`, { enabled: event.target.checked, projectId: projectScope ? projectId : undefined }).then(() => skill.reload()).catch((error: unknown) => notify(errorMessage(error), 'error')) }} /> aktiv
                </label>
                {projectId ? <label className="row"><input type="checkbox" checked={projectScope} onChange={(event) => setProjectScope(event.target.checked)} /> Nur dieses Projekt</label> : null}
              </div>
              <div>{data.description}</div>
              {data.triggers.length ? <div className="faint">Auslöser: {data.triggers.join(', ')}</div> : null}
              <div className="row" style={{ gap: 6 }}>
                <AsyncButton className="btn small" onClick={async () => {
                  const folder = await bridge().dialog.openFolder('Skill exportieren: Zielordner')
                  if (!folder) return
                  const result = await api.post<{ folder: string; files: number }>(`/skills/${enc(skillKey)}/export`, { folder })
                  notify(`${result.files} Dateien nach ${result.folder} exportiert.`, 'success')
                }}>Exportieren</AsyncButton>
                {data.testTask ? (
                  <AsyncButton className="btn small" title="Prüft ohne Modellaufruf, ob der Skill für seine Testaufgabe ausgewählt würde und ob Ressourcen, Tools und Aktionen verfügbar sind." onClick={async () => setTestResult(await api.post<SkillTestResult>(`/skills/${enc(skillKey)}/test`, { projectId: projectScope ? projectId : undefined }))}>
                    Testaufgabe prüfen
                  </AsyncButton>
                ) : null}
                {data.editable ? (
                  <button className="btn small" onClick={() => onEdit(data)}>
                    Bearbeiten
                  </button>
                ) : (
                  <button className="btn small" onClick={() => onEdit({ ...data, key: '', source: 'user', editable: true })}>
                    Als eigenen Skill kopieren
                  </button>
                )}
                {data.editable ? (
                  <button className="btn small danger" onClick={() => setRemove(true)}>
                    Löschen
                  </button>
                ) : null}
              </div>
            </div>
            {testResult ? (
              <div className="card stack" style={{ gap: 6 }}>
                <div className="row" style={{ gap: 6 }}>
                  <div className="section-title">Testaufgabe</div>
                  <Badge kind={testResult.ok ? 'ok' : 'error'}>{testResult.ok ? 'bestanden' : 'Probleme'}</Badge>
                  <span className="spacer" />
                  <button className="btn small ghost" onClick={() => setTestResult(undefined)}>Schließen</button>
                </div>
                <div>
                  Rolle {testResult.role}: {testResult.selection === 'inlined' ? 'Anweisungen werden direkt mitgegeben' : testResult.selection === 'offered' ? 'wird zum Laden angeboten (load_skill)' : 'wird für diese Aufgabe nicht ausgewählt – Auslöser/Beschreibung prüfen'} (Relevanz {testResult.score})
                </div>
                {testResult.missingResources.length ? <div className="callout error">Fehlende Ressourcen im Skill-Ordner: {testResult.missingResources.join(', ')}</div> : null}
                {testResult.missingTools.length ? <div className="callout error">Für die Rolle nicht verfügbare Tools: {testResult.missingTools.join(', ')}</div> : null}
                {testResult.unknownActions.length ? <div className="callout error">Erlaubte Aktionen ohne passendes Skript: {testResult.unknownActions.join(', ')}</div> : null}
                {testResult.prompt ? <details><summary className="faint">Kontext für den Agenten</summary><pre className="pre">{testResult.prompt}</pre></details> : null}
              </div>
            ) : null}
            <div className="card stack">
              <div className="section-title">Zugewiesen an</div>
              <RolePicker value={data.agents} onChange={(agents) => void api.patch(`/skills/${enc(skillKey)}`, { agents }).then(() => skill.reload()).catch((error: unknown) => notify(errorMessage(error), 'error'))} />
            </div>
            {data.scripts.length ? (
              <div className="card stack">
                <div className="section-title">Skripte</div>
                <div>{data.scripts.join(', ')}</div>
                {data.scriptsApproved ? (
                  <div className="row" style={{ gap: 6 }}>
                    <Badge kind="ok">genehmigt</Badge>
                    <AsyncButton className="btn small" onClick={() => api.post(`/skills/${enc(skillKey)}/revoke-scripts`).then(() => skill.reload())}>
                      Genehmigung entziehen
                    </AsyncButton>
                  </div>
                ) : (
                  <>
                    <div className="callout warn">Skripte laufen erst nach Ihrer ausdrücklichen Genehmigung (ohne Shell, mit Zeitlimit, im Arbeitsordner der Aufgabe). Jede Änderung an einem Skript hebt die Genehmigung auf.</div>
                    <div>
                      <AsyncButton
                        className="btn small"
                        onClick={async () => {
                          await loadScripts()
                          setApprove(true)
                        }}
                      >
                        Skripte prüfen und genehmigen …
                      </AsyncButton>
                    </div>
                  </>
                )}
              </div>
            ) : null}
            {data.files.filter((file) => !file.startsWith('scripts/')).length ? (
              <div className="faint">Dateien: {data.files.filter((file) => !file.startsWith('scripts/')).join(', ')}</div>
            ) : null}
            <div className="card stack">
              <div className="section-title">Anweisungen ({data.bodyChars} Zeichen)</div>
              <pre className="pre plugin-markdown">{data.body}</pre>
            </div>
          </>
        )}
      </div>
      {approve && data ? (
        <Confirm
          title={`Skripte von ${data.name} genehmigen`}
          confirmLabel="Genehmigen"
          onCancel={() => setApprove(false)}
          onConfirm={() => {
            setApprove(false)
            void api
              .post(`/skills/${enc(skillKey)}/approve-scripts`, { hash: data.scriptsHash })
              .then(() => skill.reload())
              .catch((error: unknown) => notify(errorMessage(error), 'error'))
          }}
        >
          <div className="stack" style={{ gap: 6, maxHeight: '60vh', overflow: 'auto' }}>
            <div>Agenten dürfen diese Skripte danach ausführen:</div>
            {Object.entries(scriptText).map(([file, text]) => (
              <div key={file}>
                <strong>{file}</strong>
                <pre className="pre">{text}</pre>
              </div>
            ))}
          </div>
        </Confirm>
      ) : null}
      {remove && data ? (
        <Confirm
          title={`${data.name} löschen?`}
          confirmLabel="Löschen"
          danger
          onCancel={() => setRemove(false)}
          onConfirm={() => {
            setRemove(false)
            void api
              .del(`/skills/${enc(skillKey)}`)
              .then(onBack)
              .catch((error: unknown) => notify(errorMessage(error), 'error'))
          }}
        >
          Der Ordner {data.location}/{data.name} wird gelöscht.
        </Confirm>
      ) : null}
    </>
  )
}

const TEMPLATE = `# Titel

Wann dieser Skill gilt und was der Agent tun soll:

1. …
2. …
`

function SkillBuilder({ initial, projectId, onDone }: { initial?: SkillDetails; projectId?: string; onDone: (key?: string) => void }) {
  const editing = Boolean(initial?.key)
  const [scope, setScope] = useState<'user' | 'project'>(initial?.source === 'project' ? 'project' : 'user')
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [triggers, setTriggers] = useState(initial?.triggers.join(', ') ?? '')
  const [body, setBody] = useState(initial?.body ?? TEMPLATE)
  const [tools, setTools] = useState(initial?.tools?.join('\n') ?? '')
  const [allowedActions, setAllowedActions] = useState(initial?.allowedActions?.join('\n') ?? '')
  const [resources, setResources] = useState(initial?.resources?.join('\n') ?? '')
  const [testTask, setTestTask] = useState(initial?.testTask ?? '')
  const nameValid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
  const save = async () => {
    const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)
    const payload = { name, description, triggers: triggers.split(',').map((entry) => entry.trim()).filter(Boolean), body, tools: lines(tools), allowedActions: lines(allowedActions), resources: lines(resources), testTask }
    const skill = editing ? await api.put<Skill>(`/skills/${enc(initial!.key)}`, payload) : await api.post<Skill>('/skills', { ...payload, scope, projectId: scope === 'project' ? projectId : undefined })
    notify(`Skill ${skill.name} gespeichert.`, 'success')
    onDone(skill.key)
  }
  return (
    <>
      <PanelHeader title={editing ? `${initial!.name} bearbeiten` : 'Neuer Skill'}>
        <button className="icon-btn" title="Abbrechen" aria-label="Zurück zur Liste" onClick={() => onDone()}>
          <ArrowLeft size={14} />
        </button>
      </PanelHeader>
      <div className="panel-body stack" style={{ gap: 10 }}>
        {!editing ? (
          <label className="stack" style={{ gap: 3 }}>
            <span>Speicherort</span>
            <select className="select" value={scope} onChange={(event) => setScope(event.target.value as 'user' | 'project')}>
              <option value="user">Benutzer (alle Projekte)</option>
              <option value="project" disabled={!projectId}>
                Projekt (.multi-ai-coder/skills, wird mit dem Repository geteilt)
              </option>
            </select>
          </label>
        ) : null}
        <label className="stack" style={{ gap: 3 }}>
          <span>Name</span>
          <input className="input" value={name} disabled={editing} placeholder="z. B. api-conventions" onChange={(event) => setName(event.target.value.toLowerCase())} />
          {name && !nameValid ? <span className="plugin-error">Kleinbuchstaben, Ziffern und „-“ (max. 64).</span> : null}
        </label>
        <label className="stack" style={{ gap: 3 }}>
          <span>Beschreibung</span>
          <textarea className="textarea" rows={2} value={description} placeholder="Was der Skill enthält und wann er gilt – Agenten sehen diesen Text in der Übersicht." onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="stack" style={{ gap: 3 }}>
          <span>Auslöser (Kommagetrennt)</span>
          <input className="input" value={triggers} placeholder="z. B. endpoint, rest, api" onChange={(event) => setTriggers(event.target.value)} />
          <span className="faint" style={{ fontSize: 11.5 }}>Kommen diese Wörter in einer Aufgabe vor, erhält der Agent den Skill vollständig.</span>
        </label>
        <label className="stack" style={{ gap: 3 }}>
          <span>Anweisungen (Markdown)</span>
          <textarea className="textarea mono" rows={16} value={body} onChange={(event) => setBody(event.target.value)} />
        </label>
        <label className="stack"><span>Werkzeuge (ein Name pro Zeile)</span><textarea className="textarea" rows={3} value={tools} onChange={(event) => setTools(event.target.value)} /></label>
        <label className="stack"><span>Erlaubte Aktionen: Skripte des Skills, die Agenten ausführen dürfen (eine pro Zeile, leer = alle freigegebenen)</span><textarea className="textarea" rows={3} value={allowedActions} onChange={(event) => setAllowedActions(event.target.value)} /></label>
        <label className="stack"><span>Ressourcen (relative Pfade oder Verweise, eine pro Zeile)</span><textarea className="textarea" rows={3} value={resources} onChange={(event) => setResources(event.target.value)} /></label>
        <label className="stack"><span>Testaufgabe</span><textarea className="textarea" rows={3} value={testTask} onChange={(event) => setTestTask(event.target.value)} /></label>
        <div className="row" style={{ gap: 6 }}>
          <AsyncButton className="btn primary small" disabled={!nameValid || !description.trim() || !body.trim()} onClick={save}>
            Speichern
          </AsyncButton>
          <span className="faint">Skripte und weitere Dateien legen Sie im Skill-Ordner ab (scripts/…).</span>
        </div>
      </div>
    </>
  )
}
