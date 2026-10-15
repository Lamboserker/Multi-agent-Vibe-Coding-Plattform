import { useEffect, useState } from 'react'
import { ArrowLeft, Plus } from 'lucide-react'
import { notify } from '../../lib/actions'
import { api, enc, errorMessage } from '../../lib/api'
import { useVisibleLoader } from '../../lib/hooks'
import { useAppState } from '../../lib/store'
import { useStore } from '../../lib/store/core'
import { pluginStore } from '../../lib/stores'
import type { InstalledModel } from '../../lib/types'
import { AsyncButton, Badge, Confirm, Empty, Spinner } from '../common'

export interface AgentProfile {
  id: string
  name: string
  description: string
  role: string
  projectId: string | null
  model: string | null
  categories: string[]
  skills: string[]
  mcpServers: string[]
  pluginTools: boolean
  escalation: 'premium' | 'local' | 'none'
  maxSteps: number | null
  maxRepairs: number | null
  maxContextTokens?: number | null
  permissions?: { read?: boolean; write?: boolean; externalTools?: boolean }
  resources?: { timeoutMs?: number; maxFiles?: number; maxWriteBytes?: number; maxOutputTokens?: number }
  instructions: string
  enabled: boolean
  priority: number
  template: string | null
}

const ESCALATION: Record<AgentProfile['escalation'], string> = { premium: 'bis zum Premium-Orchestrator', local: 'nur zu stärkeren lokalen Modellen', none: 'keine Eskalation' }

/** Shared list of agent profiles for the current project (global + project agents). */
export function useAgentProfiles() {
  const projectId = useAppState((state) => state.project?.id)
  const revision = useStore(pluginStore, (state) => state.revision)
  const loader = useVisibleLoader(() => api.get<AgentProfile[]>(`/agents${projectId ? `?projectId=${enc(projectId)}` : ''}`), [projectId], 10_000)
  useEffect(() => {
    if (revision) void loader.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])
  return loader
}

/** Agent manager: profiles with model, skills, MCP servers, plugin tools, limits and escalation. */
export function AgentProfilesView() {
  const projectId = useAppState((state) => state.project?.id)
  const agents = useAgentProfiles()
  const templates = useVisibleLoader(() => api.get<Array<AgentProfile & { id: string }>>('/agents/templates'), [], 600_000)
  const [editing, setEditing] = useState<AgentProfile | 'new'>()

  if (editing) return <AgentEditor agent={editing === 'new' ? undefined : editing} onDone={() => { setEditing(undefined); void agents.reload() }} />

  const fromTemplate = async (template: string) => {
    const agent = await api.post<AgentProfile>('/agents', { template, projectId: null })
    notify(`${agent.name} angelegt.`, 'success')
    await agents.reload()
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="faint" style={{ fontSize: 12 }}>
        Beim Planen erhält jede Teilaufgabe den passendsten Agenten (Kategorie oder Stichworte in Titel, Beschreibung und Dateien; Projekt-Agenten vor globalen). Der Agent bestimmt Modell, Skills, MCP-Server, Plugin-Werkzeuge, Grenzen und Eskalation; in der Planansicht lässt er sich je Teilaufgabe ändern. Abhängige Teilaufgaben erhalten eine kompakte Übergabe (Dateien + Zusammenfassung) ihrer Vorgänger.
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn small primary" onClick={() => setEditing('new')}>
          <Plus size={13} /> Neuer Agent
        </button>
      </div>
      {agents.loading && !agents.data ? <Spinner /> : null}
      {(agents.data ?? []).map((agent) => (
        <button key={agent.id} className="plugin-item" onClick={() => setEditing(agent)}>
          <div className="row" style={{ gap: 6 }}>
            <strong>{agent.name}</strong>
            {agent.projectId ? <Badge kind="accent">{agent.projectId === projectId ? 'dieses Projekt' : 'anderes Projekt'}</Badge> : <Badge>alle Projekte</Badge>}
            <span className="spacer" />
            <Badge kind={agent.enabled ? 'ok' : undefined}>{agent.enabled ? 'aktiv' : 'aus'}</Badge>
          </div>
          <div className="muted plugin-description">{agent.description || agent.categories.join(', ')}</div>
          <div className="faint" style={{ fontSize: 11.5 }}>
            Modell: {agent.model ?? 'Router'} · Eskalation: {ESCALATION[agent.escalation]}
            {agent.skills.length ? ` · Skills: ${agent.skills.join(', ')}` : ''}
          </div>
        </button>
      ))}
      {!agents.loading && !(agents.data ?? []).length ? <Empty>Noch keine Agenten. Ohne Agenten entscheidet der Router allein.</Empty> : null}
      <div className="section-title">Vorlagen</div>
      {(templates.data ?? []).map((template) => (
        <div key={template.id} className="card row" style={{ gap: 8 }}>
          <div className="stack" style={{ gap: 2, flex: 1 }}>
            <strong>{template.name}</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {template.description}
            </span>
          </div>
          <AsyncButton className="btn small" onClick={() => fromTemplate(template.id)}>
            Anlegen
          </AsyncButton>
        </div>
      ))}
    </div>
  )
}

function AgentEditor({ agent, onDone }: { agent?: AgentProfile; onDone: () => void }) {
  const projectId = useAppState((state) => state.project?.id)
  const models = useVisibleLoader(() => api.get<InstalledModel[]>('/local-models/installed').catch(() => [] as InstalledModel[]), [], 60_000)
  const skills = useVisibleLoader(() => api.get<Array<{ name: string; enabled: boolean }>>(`/skills${projectId ? `?projectId=${enc(projectId)}` : ''}`), [projectId], 60_000)
  const servers = useVisibleLoader(() => api.get<Array<{ id: string; name: string; enabled: boolean }>>('/mcp/servers'), [], 60_000)
  const [form, setForm] = useState({
    name: agent?.name ?? '',
    description: agent?.description ?? '',
    scope: agent?.projectId ? 'project' : 'all',
    model: agent?.model ?? '',
    categories: (agent?.categories ?? []).join(', '),
    skills: agent?.skills ?? [],
    mcpServers: agent?.mcpServers ?? ['*'],
    pluginTools: agent?.pluginTools ?? true,
    escalation: agent?.escalation ?? 'premium',
    maxSteps: agent?.maxSteps ? String(agent.maxSteps) : '',
    maxRepairs: agent?.maxRepairs !== null && agent?.maxRepairs !== undefined ? String(agent.maxRepairs) : '',
    instructions: agent?.instructions ?? '',
    enabled: agent?.enabled ?? true,
    priority: String(agent?.priority ?? 0),
    maxContextTokens: String(agent?.maxContextTokens ?? ''),
    allowRead: agent?.permissions?.read ?? true,
    allowWrite: agent?.permissions?.write ?? true,
    allowTools: agent?.permissions?.externalTools ?? true,
    timeoutSeconds: String(agent?.resources?.timeoutMs ? agent.resources.timeoutMs / 1000 : ''),
    maxFiles: String(agent?.resources?.maxFiles ?? ''),
    maxWriteBytes: String(agent?.resources?.maxWriteBytes ?? ''),
    maxOutputTokens: String(agent?.resources?.maxOutputTokens ?? ''),
  })
  const [remove, setRemove] = useState(false)
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }))
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value])

  const save = async () => {
    const payload = {
      name: form.name,
      description: form.description,
      projectId: form.scope === 'project' ? (agent?.projectId ?? projectId ?? null) : null,
      model: form.model || null,
      categories: form.categories.split(',').map((entry) => entry.trim()).filter(Boolean),
      skills: form.skills,
      mcpServers: form.mcpServers,
      pluginTools: form.pluginTools,
      escalation: form.escalation,
      maxSteps: form.maxSteps ? Number(form.maxSteps) : null,
      maxRepairs: form.maxRepairs ? Number(form.maxRepairs) : null,
      instructions: form.instructions,
      enabled: form.enabled,
      priority: Number(form.priority) || 0,
      maxContextTokens: form.maxContextTokens ? Number(form.maxContextTokens) : null,
      permissions: { read: form.allowRead, write: form.allowWrite, externalTools: form.allowTools },
      resources: { ...(form.timeoutSeconds ? { timeoutMs: Number(form.timeoutSeconds) * 1000 } : {}), ...(form.maxFiles ? { maxFiles: Number(form.maxFiles) } : {}), ...(form.maxWriteBytes ? { maxWriteBytes: Number(form.maxWriteBytes) } : {}), ...(form.maxOutputTokens ? { maxOutputTokens: Number(form.maxOutputTokens) } : {}) },
    }
    if (agent) await api.patch(`/agents/${enc(agent.id)}`, payload)
    else await api.post('/agents', payload)
    notify(`${form.name} gespeichert.`, 'success')
    onDone()
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row">
        <button className="icon-btn" title="Zurück" aria-label="Zurück zur Agentenliste" onClick={onDone}>
          <ArrowLeft size={14} />
        </button>
        <strong>{agent ? agent.name : 'Neuer Agent'}</strong>
      </div>
      <label className="stack" style={{ gap: 3 }}>
        <span>Name</span>
        <input className="input" value={form.name} onChange={(event) => set({ name: event.target.value })} />
      </label>
      <label className="stack" style={{ gap: 3 }}>
        <span>Beschreibung</span>
        <input className="input" value={form.description} onChange={(event) => set({ description: event.target.value })} />
      </label>
      <label className="stack" style={{ gap: 3 }}>
        <span>Gilt für</span>
        <select className="select" value={form.scope} onChange={(event) => set({ scope: event.target.value })}>
          <option value="all">alle Projekte</option>
          <option value="project" disabled={!projectId && !agent?.projectId}>
            nur dieses Projekt
          </option>
        </select>
      </label>
      <label className="stack" style={{ gap: 3 }}>
        <span>Zuständig für (Kategorien/Stichwörter, kommagetrennt)</span>
        <input className="input" value={form.categories} placeholder="z. B. frontend, komponente, css" onChange={(event) => set({ categories: event.target.value })} />
      </label>
      <label className="stack" style={{ gap: 3 }}>
        <span>Modell</span>
        <select className="select" value={form.model} onChange={(event) => set({ model: event.target.value })}>
          <option value="">Router entscheidet (nach Komplexität und Rollen)</option>
          {(models.data ?? []).map((model) => (
            <option key={model.name} value={model.name}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
      <div className="stack" style={{ gap: 3 }}>
        <span>Skills {form.skills.length ? '' : '(keine Auswahl = alle dem Coder zugewiesenen)'}</span>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {(skills.data ?? []).filter((skill) => skill.enabled).map((skill) => (
            <label key={skill.name} className="row">
              <input type="checkbox" checked={form.skills.includes(skill.name)} onChange={() => set({ skills: toggle(form.skills, skill.name) })} /> {skill.name}
            </label>
          ))}
        </div>
      </div>
      <div className="stack" style={{ gap: 3 }}>
        <span>MCP-Server</span>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="row">
            <input type="checkbox" checked={form.mcpServers.includes('*')} onChange={(event) => set({ mcpServers: event.target.checked ? ['*'] : [] })} /> alle zugewiesenen
          </label>
          {(servers.data ?? []).map((server) => (
            <label key={server.id} className="row">
              <input type="checkbox" disabled={form.mcpServers.includes('*')} checked={form.mcpServers.includes('*') || form.mcpServers.includes(server.id)} onChange={() => set({ mcpServers: toggle(form.mcpServers.filter((entry) => entry !== '*'), server.id) })} /> {server.name}
            </label>
          ))}
        </div>
      </div>
      <label className="row">
        <input type="checkbox" checked={form.pluginTools} onChange={(event) => set({ pluginTools: event.target.checked })} /> Plugin-Werkzeuge (ohne Seiteneffekte) verwenden
      </label>
      <label className="stack"><span>Maximaler Kontext (Tokens)</span><input className="input" type="number" min={1024} value={form.maxContextTokens} onChange={(event) => set({ maxContextTokens: event.target.value })} /></label>
      <div className="row">
        <label><input type="checkbox" checked={form.allowRead} onChange={(event) => set({ allowRead: event.target.checked })} /> Dateien lesen</label>
        <label><input type="checkbox" checked={form.allowWrite} onChange={(event) => set({ allowWrite: event.target.checked })} /> Dateien schreiben</label>
        <label><input type="checkbox" checked={form.allowTools} onChange={(event) => set({ allowTools: event.target.checked })} /> Externe Werkzeuge</label>
      </div>
      <label className="stack"><span>Zeitlimit (Sekunden)</span><input className="input" type="number" min={1} value={form.timeoutSeconds} onChange={(event) => set({ timeoutSeconds: event.target.value })} /></label>
      <label className="stack"><span>Maximal geänderte Dateien</span><input className="input" type="number" min={1} max={40} value={form.maxFiles} onChange={(event) => set({ maxFiles: event.target.value })} /></label>
      <label className="stack"><span>Maximale Dateigröße (Bytes)</span><input className="input" type="number" min={1024} value={form.maxWriteBytes} onChange={(event) => set({ maxWriteBytes: event.target.value })} /></label>
      <label className="stack"><span>Maximale Ausgabe (Tokens)</span><input className="input" type="number" min={128} value={form.maxOutputTokens} onChange={(event) => set({ maxOutputTokens: event.target.value })} /></label>
      <label className="stack" style={{ gap: 3 }}>
        <span>Eskalation bei Fehlschlag</span>
        <select className="select" value={form.escalation} onChange={(event) => set({ escalation: event.target.value as AgentProfile['escalation'] })}>
          <option value="premium">bis zum Premium-Orchestrator (Standard)</option>
          <option value="local">nur zu stärkeren lokalen Modellen (keine Premium-Kosten)</option>
          <option value="none">keine Eskalation</option>
        </select>
      </label>
      <div className="row" style={{ gap: 10 }}>
        <label className="stack" style={{ gap: 3, flex: 1 }}>
          <span>Max. Schritte</span>
          <input className="input" type="number" min={2} max={60} placeholder="16" value={form.maxSteps} onChange={(event) => set({ maxSteps: event.target.value })} />
        </label>
        <label className="stack" style={{ gap: 3, flex: 1 }}>
          <span>Max. Reparaturen</span>
          <input className="input" type="number" min={0} max={5} placeholder="Einstellung" value={form.maxRepairs} onChange={(event) => set({ maxRepairs: event.target.value })} />
        </label>
        <label className="stack" style={{ gap: 3, flex: 1 }}>
          <span>Priorität</span>
          <input className="input" type="number" min={-100} max={100} value={form.priority} onChange={(event) => set({ priority: event.target.value })} />
        </label>
      </div>
      <label className="stack" style={{ gap: 3 }}>
        <span>Rollenanweisung (wird dem Agenten mitgegeben)</span>
        <textarea className="textarea" rows={5} value={form.instructions} onChange={(event) => set({ instructions: event.target.value })} />
      </label>
      <label className="row">
        <input type="checkbox" checked={form.enabled} onChange={(event) => set({ enabled: event.target.checked })} /> aktiv
      </label>
      <div className="row" style={{ gap: 6 }}>
        <AsyncButton className="btn small primary" disabled={!form.name.trim()} onClick={save}>
          Speichern
        </AsyncButton>
        {agent ? (
          <button className="btn small danger" onClick={() => setRemove(true)}>
            Löschen
          </button>
        ) : null}
      </div>
      {remove && agent ? (
        <Confirm
          title={`${agent.name} löschen?`}
          danger
          confirmLabel="Löschen"
          onCancel={() => setRemove(false)}
          onConfirm={() => {
            setRemove(false)
            void api
              .del(`/agents/${enc(agent.id)}`)
              .then(onDone)
              .catch((error: unknown) => notify(errorMessage(error), 'error'))
          }}
        >
          Geplante Teilaufgaben mit diesem Agenten werden wieder automatisch zugeordnet.
        </Confirm>
      ) : null}
    </div>
  )
}

/** Agent choice for one planned subtask (plan view). */
export function AgentSwitcher({ subtaskId, agentId, disabled, onChanged }: { subtaskId: string; agentId?: string | null; disabled: boolean; onChanged: () => void }) {
  const agents = useAgentProfiles()
  return (
    <div className="row">
      <span className="muted" style={{ whiteSpace: 'nowrap' }}>Agent:</span>
      <select
        className="select"
        disabled={disabled}
        value={agentId ?? ''}
        onChange={async (event) => {
          try {
            await api.post(`/subtasks/${subtaskId}/agent`, { agentId: event.target.value || null })
            onChanged()
          } catch (error) {
            notify(errorMessage(error), 'error')
          }
        }}
      >
        <option value="">Kein Agentenprofil (nur Router)</option>
        {(agents.data ?? []).filter((agent) => agent.enabled).map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
    </div>
  )
}
