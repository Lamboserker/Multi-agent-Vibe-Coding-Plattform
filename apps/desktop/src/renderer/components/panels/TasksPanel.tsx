import { useState } from 'react'
import { Archive, ArchiveRestore, Download, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from 'lucide-react'
import * as actions from '../../lib/actions'
import { api, enc, errorMessage } from '../../lib/api'
import { useAppState, useSessionState } from '../../lib/store'
import { shallowEqual } from '../../lib/store/core'
import type { SessionStatus, SessionSummary } from '../../lib/types'
import { Confirm, Empty, PanelHeader, PromptDialog, StatusDot } from '../common'

const STATUS_LABEL: Record<SessionStatus, string> = {
  active: 'aktiv',
  idle: 'inaktiv',
  running: 'läuft',
  paused: 'pausiert',
  interrupted: 'unterbrochen',
  completed: 'abgeschlossen',
  failed: 'fehlgeschlagen',
  archived: 'archiviert',
}

interface SearchHit {
  messageId: string
  sessionId: string
  sessionTitle?: string
  role: string
  createdAt: string
  excerpt: string
}

/** Sessions of the open project: persistent orchestrator conversations with their tasks and runs. */
export function TasksPanel() {
  const project = useAppState((state) => state.project)
  const activeSessionId = useAppState((state) => state.workspace.activeSessionId)
  const { list, listLoaded, includeArchived } = useSessionState((state) => ({ list: state.list, listLoaded: state.listLoaded, includeArchived: state.includeArchived }), shallowEqual)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>()
  const [renaming, setRenaming] = useState<SessionSummary>()
  const [deleting, setDeleting] = useState<SessionSummary>()

  const search = async () => {
    if (!project || !query.trim()) return setHits(undefined)
    try {
      setHits(await api.get<SearchHit[]>(`/projects/${project.id}/session-search?q=${enc(query.trim())}`))
    } catch (error) {
      actions.notify(errorMessage(error), 'error')
    }
  }
  const run = (action: () => Promise<unknown>) => () => void action().catch((error: unknown) => actions.notify(errorMessage(error), 'error'))

  return (
    <>
      <PanelHeader title="Sitzungen">
        <label className="row faint" style={{ gap: 4, fontSize: 11 }} title="Archivierte Sitzungen anzeigen">
          <input type="checkbox" checked={includeArchived} onChange={(event) => actions.setIncludeArchived(event.target.checked)} /> Archiv
        </label>
        <button
          className="icon-btn"
          title="Neue Sitzung (im Chat beschreiben)"
          aria-label="Neue Sitzung"
          onClick={() => {
            actions.newSession()
            document.getElementById('chat-input')?.focus()
          }}
        >
          <Plus size={16} />
        </button>
      </PanelHeader>
      <div style={{ padding: '8px 8px 0' }} className="row">
        <input className="input" placeholder="Chat-Verläufe durchsuchen …" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void search()} />
        <button className="icon-btn" onClick={() => void search()} title="Suchen" aria-label="Suchen">
          <Search size={15} />
        </button>
      </div>
      <div className="panel-body stack" style={{ gap: 4 }}>
        {!project ? <Empty>Kein Projekt geöffnet.</Empty> : null}
        {hits ? (
          <div className="stack" style={{ gap: 2 }}>
            <div className="row">
              <span className="faint">{hits.length} Treffer</span>
              <span className="spacer" />
              <button className="icon-btn" title="Suche schließen" onClick={() => setHits(undefined)}>
                <X size={13} />
              </button>
            </div>
            {hits.map((hit) => (
              <div key={hit.messageId} className="tree-item" style={{ flexDirection: 'column', alignItems: 'flex-start' }} onClick={() => void actions.selectSession(hit.sessionId)}>
                <strong className="truncate" style={{ maxWidth: '100%' }}>{hit.sessionTitle}</strong>
                <span className="faint" style={{ fontSize: 11 }}>{hit.excerpt}</span>
              </div>
            ))}
          </div>
        ) : null}
        {project && listLoaded && !list.length && !hits ? <Empty>Noch keine Sitzungen. Beschreibe im Chat rechts, was umgesetzt werden soll.</Empty> : null}
        {!hits &&
          list.map((session) => (
            <div key={session.id} className={`tree-item session-item ${session.id === activeSessionId ? 'selected' : ''}`} data-testid="session-item" data-session-id={session.id} onClick={() => void actions.selectSession(session.id)}>
              <div className="row">
                <StatusDot status={session.status === 'active' ? 'ok' : session.status} />
                {session.pinned ? <Pin size={11} className="faint" /> : null}
                <span className="truncate" style={{ flex: 1 }}>{session.title}</span>
                <span className="actions" onClick={(event) => event.stopPropagation()}>
                  <button className="icon-btn" title="Umbenennen" onClick={() => setRenaming(session)}>
                    <Pencil size={12} />
                  </button>
                  <button className="icon-btn" title={session.pinned ? 'Lösen' : 'Anheften'} onClick={run(() => actions.updateSession(session.id, { pinned: !session.pinned }))}>
                    {session.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                  </button>
                  <button className="icon-btn" title={session.archivedAt ? 'Wiederherstellen' : 'Archivieren'} onClick={run(() => actions.updateSession(session.id, { archived: !session.archivedAt }))}>
                    {session.archivedAt ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                  </button>
                  <button className="icon-btn" title="Als Markdown exportieren" onClick={run(() => actions.exportSession(session.id, 'md'))}>
                    <Download size={12} />
                  </button>
                  <button className="icon-btn" title="Löschen" onClick={() => setDeleting(session)}>
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
              <div className="row faint" style={{ fontSize: 11, paddingLeft: 16 }}>
                <span>{STATUS_LABEL[session.status] ?? session.status}</span>
                {session.taskCount ? <span>· {session.taskCount} Aufgabe(n)</span> : null}
                <span className="spacer" />
                <span>{new Date(session.lastActivityAt).toLocaleString()}</span>
              </div>
            </div>
          ))}
      </div>
      {renaming ? (
        <PromptDialog
          title="Sitzung umbenennen"
          initial={renaming.title}
          onCancel={() => setRenaming(undefined)}
          onSubmit={(title) => {
            const target = renaming
            setRenaming(undefined)
            run(() => actions.updateSession(target.id, { title }))()
          }}
        />
      ) : null}
      {deleting ? (
        <Confirm
          title="Sitzung löschen?"
          danger
          confirmLabel="Endgültig löschen"
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const target = deleting
            setDeleting(undefined)
            run(() => actions.deleteSession(target.id))()
          }}
        >
          Der Chat-Verlauf von „{deleting.title}“ wird gelöscht. Aufgaben und Ausführungen bleiben in der Nutzungsstatistik erhalten. Archivieren behält den Verlauf.
        </Confirm>
      ) : null}
    </>
  )
}
