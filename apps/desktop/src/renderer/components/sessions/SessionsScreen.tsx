import { useEffect, useState } from 'react'
import { Archive, ArrowRight, Download, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react'
import * as actions from '../../lib/actions'
import { api, enc, errorMessage } from '../../lib/api'
import { runStatusLabel } from '../../lib/engine-text'
import { TONE } from '../../lib/leitstand'
import { shallowEqual } from '../../lib/store/core'
import { useAppState, useSessionState } from '../../lib/store'
import type { SessionDetail, SessionSummary, UsageSummary } from '../../lib/types'
import { Confirm, Spinner } from '../common'
import { sessionTone } from '../shell/Shell'
import { Seg, StatTile } from '../ui'

type Filter = 'all' | 'active' | 'done'
interface SearchHit { messageId: string; sessionId: string; sessionTitle?: string; role: string; createdAt: string; excerpt: string }

const STATUS_LABEL: Record<string, string> = { active: 'aktiv', idle: 'inaktiv', running: 'läuft', paused: 'pausiert', interrupted: 'unterbrochen', completed: 'abgeschlossen', failed: 'fehlgeschlagen', archived: 'archiviert' }

export function when(value: string) {
  const date = new Date(value)
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000)
  if (minutes < 1) return 'gerade eben'
  if (minutes < 60) return `vor ${minutes} Min.`
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return `heute, ${date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (date.toDateString() === yesterday.toDateString()) return 'gestern'
  return date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + `, ${date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`
}

export function SessionsScreen() {
  const project = useAppState((state) => state.project)
  const activeSessionId = useAppState((state) => state.workspace.activeSessionId)
  const { list, listLoaded, includeArchived } = useSessionState((state) => ({ list: state.list, listLoaded: state.listLoaded, includeArchived: state.includeArchived }), shallowEqual)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>()
  const [selectedId, setSelectedId] = useState<string | undefined>(activeSessionId)
  const shown = list.filter((session) => filter === 'all' || (filter === 'active' ? ['running', 'paused', 'interrupted', 'active'].includes(session.status) : ['completed', 'failed'].includes(session.status)))
  const selected = list.find((session) => session.id === selectedId) ?? shown[0]

  useEffect(() => {
    if (!query.trim()) return setHits(undefined)
    const timer = window.setTimeout(() => {
      if (!project) return
      void api.get<SearchHit[]>(`/projects/${project.id}/session-search?q=${enc(query.trim())}`).then(setHits).catch((error: unknown) => actions.notify(errorMessage(error), 'error'))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query, project])

  return (
    <div className="sessions">
      <div className="sessions-list">
        <div className="stack" style={{ padding: '16px 16px 10px', gap: 10 }}>
          <div className="row">
            <strong style={{ fontSize: 16 }}>Sitzungen</strong>
            <span className="spacer" />
            <button className="btn small primary" onClick={() => actions.newSession()}>
              <Plus size={13} /> Neu
            </button>
          </div>
          <label className="search-box">
            <Search size={14} />
            <input placeholder="Chat-Verläufe durchsuchen …" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Chat-Verläufe durchsuchen" />
          </label>
          <div className="row" style={{ gap: 8 }}>
            <Seg size="sm" label="Filter" value={filter} onChange={setFilter} options={[{ id: 'all', label: 'Alle' }, { id: 'active', label: 'Aktiv' }, { id: 'done', label: 'Abgeschlossen' }]} />
            <span className="spacer" />
            <label className="row faint" style={{ gap: 4, fontSize: 11.5 }}>
              <input type="checkbox" checked={includeArchived} onChange={(event) => actions.setIncludeArchived(event.target.checked)} /> Archiv
            </label>
          </div>
        </div>
        <div className="sessions-scroll">
          {!project ? <div className="faint" style={{ padding: 12 }}>Kein Projekt geöffnet.</div> : !listLoaded ? <div style={{ padding: 12 }}><Spinner /></div> : null}
          {hits ? (
            <>
              <div className="faint" style={{ padding: '4px 12px', fontSize: 12 }}>{hits.length} Treffer</div>
              {hits.map((hit) => (
                <button key={hit.messageId} className="session-row" onClick={() => setSelectedId(hit.sessionId)}>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span className="truncate" style={{ fontWeight: 500 }}>{hit.sessionTitle ?? 'Sitzung'}</span>
                    <span className="faint" style={{ fontSize: 11.5, whiteSpace: 'normal' }}>{hit.excerpt}</span>
                  </span>
                </button>
              ))}
            </>
          ) : shown.map((session) => (
            <button key={session.id} className={`session-row ${selected?.id === session.id ? 'on' : ''}`} onClick={() => setSelectedId(session.id)}>
              <span className="tone-dot" style={{ width: 8, height: 8, marginTop: 6, background: TONE[sessionTone(session)].color }} />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="row" style={{ gap: 6 }}>
                  <span className="truncate" style={{ fontWeight: 500, flex: 1 }}>{session.title || 'Sitzung'}</span>
                  {session.pinned ? <Pin size={12} className="faint" /> : null}
                  {session.id === activeSessionId ? <span className="chip" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>offen</span> : null}
                </span>
                <span className="faint" style={{ fontSize: 11.5 }}>
                  {STATUS_LABEL[session.status] ?? session.status} · {session.taskCount ? `${session.taskCount} Aufgabe${session.taskCount === 1 ? '' : 'n'}` : 'Gespräch'} · {when(session.lastActivityAt)}
                </span>
              </span>
            </button>
          ))}
          {project && listLoaded && !shown.length && !hits ? <div className="faint" style={{ padding: 12 }}>Keine Sitzungen.</div> : null}
        </div>
      </div>
      <div className="sessions-detail">{selected ? <SessionDetailView key={selected.id} summary={selected} /> : <div className="screen-empty"><div className="muted">Wähle links eine Sitzung.</div></div>}</div>
    </div>
  )
}

function SessionDetailView({ summary }: { summary: SessionSummary }) {
  const [detail, setDetail] = useState<SessionDetail>()
  const [usage, setUsage] = useState<UsageSummary | null>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    let cancelled = false
    void api.get<SessionDetail>(`/sessions/${summary.id}?limit=200`).then((result) => {
      if (cancelled) return
      setDetail(result)
      const execution = result.tasks.find((task) => task.execution)?.execution
      if (!execution) return setUsage(null)
      void api.get<UsageSummary>(`/usage?executionId=${execution.id}`).then((value) => !cancelled && setUsage(value)).catch(() => !cancelled && setUsage(null))
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [summary.id, summary.lastActivityAt])
  const tone = sessionTone(summary)
  const latest = detail?.tasks[0]
  const localTokens = usage ? usage.local.inputTokens + usage.local.outputTokens : 0
  const allTokens = usage ? localTokens + usage.premium.inputTokens + usage.premium.outputTokens : 0
  const timeline = (detail?.messages ?? []).filter((message) => message.role !== 'agent' || message.metadata?.kind === 'run_summary').slice(-14)
  const run = (action: () => Promise<unknown>) => () => void action().catch((error: unknown) => actions.notify(errorMessage(error), 'error'))
  return (
    <div className="session-detail">
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span className="stage-label" style={{ color: TONE[tone].color }}><span className="tone-dot" style={{ width: 7, height: 7, background: TONE[tone].color }} />{STATUS_LABEL[summary.status] ?? summary.status}</span>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>{summary.title || 'Sitzung'}</div>
          <div className="muted">{when(summary.lastActivityAt)} · {detail ? `${detail.tasks.length} Aufgabe(n) · ${detail.messageCount ?? detail.messages.length} Nachrichten` : '…'}</div>
        </div>
        <button className="btn primary" onClick={() => { void actions.selectSession(summary.id); actions.setScreen('leitstand') }}>
          Im Leitstand öffnen <ArrowRight size={14} />
        </button>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn small" onClick={run(() => actions.updateSession(summary.id, { pinned: !summary.pinned }))}>{summary.pinned ? <PinOff size={12} /> : <Pin size={12} />} {summary.pinned ? 'Lösen' : 'Anheften'}</button>
        <button className="btn small" onClick={run(() => actions.updateSession(summary.id, { archived: !summary.archivedAt }))}><Archive size={12} /> {summary.archivedAt ? 'Wiederherstellen' : 'Archivieren'}</button>
        <button className="btn small" onClick={run(() => actions.exportSession(summary.id, 'md'))}><Download size={12} /> Markdown</button>
        <button className="btn small" onClick={run(() => actions.exportSession(summary.id, 'json'))}><Download size={12} /> JSON</button>
        <button className="btn small danger" onClick={() => setConfirmDelete(true)}><Trash2 size={12} /> Löschen</button>
      </div>
      <div className="grid-3">
        <StatTile label="Aufgaben" value={detail ? detail.tasks.length : '–'} detail={latest ? latest.title.slice(0, 60) : 'nur Gespräch'} />
        <StatTile label="Tokens lokal" value={usage === undefined ? '…' : allTokens ? `${Math.round((localTokens / allTokens) * 100)} %` : '–'} detail={allTokens ? `${(allTokens / 1000).toFixed(1).replace('.', ',')}k Tokens im letzten Lauf` : 'kein Lauf gemessen'} />
        <StatTile label="Ergebnis" value={<span style={{ fontSize: 15 }}>{latest?.execution ? runStatusLabel(latest.execution.status) : latest ? 'geplant' : 'Nur Gespräch'}</span>} />
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <div className="eyebrow">Verlauf</div>
        {!detail ? <Spinner /> : timeline.length ? timeline.map((message) => (
          <div key={message.id} className="timeline-row">
            <span className="mono faint" style={{ fontSize: 11, width: 44, paddingTop: 2, flex: 'none' }}>{new Date(message.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
            <span className="faint" style={{ width: 82, flex: 'none', fontSize: 12 }}>{({ user: 'Du', assistant: 'Orchestrator', agent: 'Agenten', system: 'System' } as Record<string, string>)[message.role]}</span>
            <span style={{ textWrap: 'pretty', whiteSpace: 'pre-wrap' }}>{message.content.length > 280 ? `${message.content.slice(0, 280)} …` : message.content}</span>
          </div>
        )) : <div className="faint">Noch keine Nachrichten.</div>}
      </div>
      {confirmDelete ? (
        <Confirm title="Sitzung löschen?" danger confirmLabel="Löschen" onCancel={() => setConfirmDelete(false)} onConfirm={() => { setConfirmDelete(false); run(() => actions.deleteSession(summary.id))() }}>
          Chat-Verlauf und Aufgaben dieser Sitzung werden dauerhaft gelöscht. Eine Sitzung mit laufender Arbeit musst du vorher abbrechen oder archivieren.
        </Confirm>
      ) : null}
    </div>
  )
}
