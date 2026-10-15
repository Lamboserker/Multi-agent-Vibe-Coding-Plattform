import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquarePlus, RotateCcw, Send, X } from 'lucide-react'
import * as actions from '../../lib/actions'
import { shallowEqual } from '../../lib/store/core'
import { useAppState, useSessionState } from '../../lib/store'
import type { PendingMessage } from '../../lib/stores'
import type { ChatMessage, CostMode } from '../../lib/types'
import { AsyncButton, Badge, Markdown, PanelHeader, Spinner, StatusDot } from '../common'
import { WorkflowPanel } from '../workflow/WorkflowPanel'

const EMPTY_DRAFT = { text: '', mode: 'task' as const, autoRun: false }

export function ChatPanel() {
  const project = useAppState((state) => state.project)
  const costMode = useAppState((state) => state.settings?.costMode)
  const sessionId = useAppState((state) => state.workspace.activeSessionId)
  const chatView = useAppState((state) => state.workspace.chatView ?? 'workflow')
  const storedDraft = useAppState((state) => state.workspace.composer[actions.composerKey(state.workspace.activeSessionId)]) ?? EMPTY_DRAFT
  const { active, pending, task, execution } = useSessionState((state) => ({ active: state.active, pending: state.pending, task: state.task, execution: state.execution }), shallowEqual)
  const [text, setText] = useState(storedDraft.text)
  const endRef = useRef<HTMLDivElement>(null)
  const syncTimer = useRef<number | undefined>(undefined)

  // The composer text is a persisted draft per session: switching sessions or views keeps it.
  // Drafts prepared elsewhere (editor AI, context, task from a problem) replace the text as well;
  // the user's own typing is not echoed back.
  const ownDraft = useRef(storedDraft.text)
  useEffect(() => {
    ownDraft.current = storedDraft.text
    setText(storedDraft.text)
    // only when another session is shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  useEffect(() => {
    if (storedDraft.text === ownDraft.current) return
    // a pending (older) debounced write of the user's typing must not overwrite the new draft
    if (syncTimer.current !== undefined) window.clearTimeout(syncTimer.current)
    ownDraft.current = storedDraft.text
    setText(storedDraft.text)
  }, [storedDraft.text])
  const updateText = (value: string) => {
    ownDraft.current = value
    setText(value)
    if (syncTimer.current !== undefined) window.clearTimeout(syncTimer.current)
    syncTimer.current = window.setTimeout(() => {
      syncTimer.current = undefined
      actions.setComposerDraft(sessionId, { text: value })
    }, 250)
  }
  useEffect(() => () => window.clearTimeout(syncTimer.current), [])
  useEffect(() => {
    actions.registerComposerFlush(() => {
      if (syncTimer.current === undefined) return
      window.clearTimeout(syncTimer.current)
      syncTimer.current = undefined
      actions.setComposerDraft(sessionId, { text: ownDraft.current })
    })
    return () => actions.registerComposerFlush(undefined)
  }, [sessionId])

  const older = useSessionState((state) => state.older)
  const messages = useMemo(() => {
    if (active?.id !== sessionId || !active) return []
    const loaded = older?.sessionId === active.id ? older.messages : []
    const ids = new Set(active.messages.map((message) => message.id))
    return [...loaded.filter((message) => !ids.has(message.id)), ...active.messages]
  }, [active, older, sessionId])
  const hasOlder = Boolean(active && active.id === sessionId && (older && older.sessionId === active.id ? older.hasMore : active.hasMore))
  const sessionPending = pending.filter((message) => (message.sessionId ?? undefined) === sessionId || (!message.sessionId && !sessionId))
  const pendingAsk = Boolean(active?.recovery?.pendingAsk)

  useEffect(() => {
    if (chatView === 'history') endRef.current?.scrollIntoView({ block: 'end' })
  // follow new messages at the end; loading older pages in front does not jump
  }, [messages.at(-1)?.id, sessionPending.length, pendingAsk, chatView])

  const finishedTask = task && (['completed', 'cancelled'].includes(task.status) || execution?.status === 'applied')
  const sending = sessionPending.some((message) => message.status === 'sending')

  const send = () => {
    const content = text.trim()
    if (!content || !project || sending) return
    if (syncTimer.current !== undefined) window.clearTimeout(syncTimer.current)
    ownDraft.current = ''
    setText('')
    void actions.sendMessage(content, storedDraft.mode, storedDraft.autoRun)
  }

  return (
    <aside className="chat-panel" data-testid="chat-panel">
      <PanelHeader title={active?.title && sessionId ? active.title : 'Neue Sitzung'}>
        {active && sessionId ? <StatusDot status={active.status === 'active' ? 'ok' : active.status} /> : null}
        <button className="icon-btn" title="Neue Sitzung" aria-label="Neue Sitzung" onClick={() => actions.newSession()}>
          <MessageSquarePlus size={16} />
        </button>
      </PanelHeader>
      <div className="session-tabs" role="tablist" aria-label="Sitzungsansicht" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 'workflow' : event.key === 'End' ? 'history' : chatView === 'workflow' ? 'history' : 'workflow'
        actions.updateWorkspace({ chatView: next })
        requestAnimationFrame(() => document.getElementById(next === 'workflow' ? 'workflow-tab' : 'history-tab')?.focus())
      }}>
        <button id="workflow-tab" role="tab" tabIndex={chatView === 'workflow' ? 0 : -1} aria-selected={chatView === 'workflow'} aria-controls="workflow-view" onClick={() => actions.updateWorkspace({ chatView: 'workflow' })}>
          Arbeitsablauf {execution?.status === 'awaiting_approval' ? <Badge kind="warn">Freigabe</Badge> : null}
        </button>
        <button id="history-tab" role="tab" tabIndex={chatView === 'history' ? 0 : -1} aria-selected={chatView === 'history'} aria-controls="history-view" onClick={() => actions.updateWorkspace({ chatView: 'history' })}>
          Verlauf {pendingAsk ? <Spinner /> : null}
        </button>
      </div>
      <div id="workflow-view" role="tabpanel" aria-labelledby="workflow-tab" className="workflow-scroll" style={{ display: chatView === 'workflow' ? 'block' : 'none' }}>
        <WorkflowPanel key={task?.id ?? 'new'} />
      </div>
      <div id="history-view" role="tabpanel" aria-labelledby="history-tab" className="chat-messages" data-testid="chat-messages" style={{ display: chatView === 'history' ? 'flex' : 'none' }}>
        {!project ? <div className="empty">Öffne zuerst ein Projekt.</div> : null}
        {project && !messages.length && !sessionPending.length ? (
          <div className="msg system">
            Beschreibe eine Coding-Aufgabe. Der Orchestrator analysiert das Repository, zerlegt die Aufgabe und delegiert Teilaufgaben an lokale Modelle; schwierige oder riskante Teile übernimmt er selbst. Alle Änderungen entstehen in isolierten Worktrees und werden erst nach deiner Freigabe übernommen.
            {'\n\n'}Mit „Frage“ kannst du Architektur besprechen oder Code erklären lassen, ohne etwas auszuführen. Die Sitzung bleibt erhalten, auch wenn du die Ansicht wechselst oder die App neu startest.
          </div>
        ) : null}
        {hasOlder ? (
          <div style={{ textAlign: 'center' }}>
            <AsyncButton className="btn small ghost" onClick={() => actions.loadOlderMessages()}>Ältere Nachrichten laden</AsyncButton>
          </div>
        ) : null}
        {messages.map((message) => <Message key={message.id} message={message} />)}
        {sessionPending.map((message) => <PendingBubble key={message.clientId} message={message} />)}
        {pendingAsk ? (
          <div className="msg system row">
            <Spinner /> Orchestrator antwortet …
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <div className="row">
          <div className="segmented">
            <button className={storedDraft.mode === 'task' ? 'active' : ''} onClick={() => { actions.setComposerDraft(sessionId, { mode: 'task' }); actions.updateWorkspace({ chatView: 'workflow' }) }}>
              Aufgabe
            </button>
            <button className={storedDraft.mode === 'ask' ? 'active' : ''} onClick={() => { actions.setComposerDraft(sessionId, { mode: 'ask' }); actions.updateWorkspace({ chatView: 'history' }) }}>
              Frage
            </button>
          </div>
          <span className="spacer" />
          <select className="select" style={{ width: 'auto', padding: '2px 6px' }} value={costMode} onChange={(event) => void actions.updateSettings({ costMode: event.target.value as CostMode })} title="Kostenmodus">
            <option value="cheapest">Cheapest</option>
            <option value="balanced">Balanced</option>
            <option value="quality">Quality</option>
          </select>
        </div>
        <textarea
          id="chat-input"
          className="textarea"
          rows={4}
          placeholder={storedDraft.mode === 'task' ? (task && !finishedTask && !execution ? 'Ergänzung zur Aufgabe … (Strg+Enter)' : 'Was soll umgesetzt werden? (Strg+Enter)') : 'Frage zum Projekt … (Strg+Enter)'}
          value={text}
          disabled={!project}
          onChange={(event) => updateText(event.target.value)}
          onBlur={() => actions.setComposerDraft(sessionId, { text })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div className="row">
          {storedDraft.mode === 'task' ? (
            <label className="row muted" style={{ gap: 5, fontSize: 12 }}>
              <input type="checkbox" checked={storedDraft.autoRun} onChange={(event) => actions.setComposerDraft(sessionId, { autoRun: event.target.checked })} /> Plan direkt ausführen
            </label>
          ) : (
            <span className="faint" style={{ fontSize: 12 }}>Nutzt den Orchestrator (Abonnement)</span>
          )}
          <span className="spacer" />
          <button className="btn primary" disabled={!text.trim() || !project || sending} onClick={send}>
            {sending ? <Spinner /> : <Send size={14} />} Senden
          </button>
        </div>
      </div>
    </aside>
  )
}
const WHO: Record<ChatMessage['role'], string> = { user: 'Du', assistant: 'Orchestrator', agent: 'Agenten', system: 'System' }

const Message = memo(function Message({ message }: { message: ChatMessage }) {
  return (
    <div className={`msg ${message.role}`} data-role={message.role}>
      {message.role !== 'user' ? <div className="who">{WHO[message.role]}</div> : null}
      {message.role === 'user' ? message.content : <Markdown text={message.content} />}
    </div>
  )
})

/** A message that is not yet confirmed as stored (or failed to send). */
function PendingBubble({ message }: { message: PendingMessage }) {
  return (
    <div className={`msg user ${message.status === 'failed' ? 'failed' : 'pending'}`} data-testid="pending-message">
      {message.content}
      <div className="msg-state">
        {message.status === 'sending' ? (
          <>
            <Spinner /> wird gespeichert …
          </>
        ) : (
          <>
            <span className="error-text">Nicht gesendet{message.error ? `: ${message.error}` : ''}</span>
            <button className="btn small" onClick={() => void actions.retryPending(message.clientId)}>
              <RotateCcw size={12} /> Erneut senden
            </button>
            <button className="icon-btn" title="Verwerfen (Text zurück ins Eingabefeld)" onClick={() => actions.discardPending(message.clientId)}>
              <X size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
