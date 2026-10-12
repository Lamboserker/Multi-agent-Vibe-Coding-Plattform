import { memo, useEffect, useRef, useState } from 'react'
import { MessageSquarePlus, RotateCcw, Send, X } from 'lucide-react'
import * as actions from '../../lib/actions'
import { api } from '../../lib/api'
import { shallowEqual } from '../../lib/store/core'
import { useAppState, useSessionState } from '../../lib/store'
import type { PendingMessage } from '../../lib/stores'
import type { ChatMessage, CostMode, TaskPlan } from '../../lib/types'
import { AsyncButton, Badge, Markdown, PanelHeader, Spinner, StatusDot } from '../common'
import { AppliedBox, ApprovalBox } from './ApprovalBox'

const EMPTY_DRAFT = { text: '', mode: 'task' as const, autoRun: false }

export function ChatPanel() {
  const project = useAppState((state) => state.project)
  const costMode = useAppState((state) => state.settings?.costMode)
  const sessionId = useAppState((state) => state.workspace.activeSessionId)
  const storedDraft = useAppState((state) => state.workspace.composer[actions.composerKey(state.workspace.activeSessionId)]) ?? EMPTY_DRAFT
  const { active, pending, task, execution } = useSessionState((state) => ({ active: state.active, pending: state.pending, task: state.task, execution: state.execution }), shallowEqual)
  const [text, setText] = useState(storedDraft.text)
  const [replanOpen, setReplanOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const syncTimer = useRef<number | undefined>(undefined)

  // The composer text is a persisted draft per session: switching sessions or views keeps it.
  useEffect(() => {
    setText(storedDraft.text)
    // only when another session is shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  const updateText = (value: string) => {
    setText(value)
    if (syncTimer.current !== undefined) window.clearTimeout(syncTimer.current)
    syncTimer.current = window.setTimeout(() => actions.setComposerDraft(sessionId, { text: value }), 250)
  }
  useEffect(() => () => window.clearTimeout(syncTimer.current), [])

  const messages = active?.id === sessionId ? active?.messages ?? [] : []
  const sessionPending = pending.filter((message) => (message.sessionId ?? undefined) === sessionId || (!message.sessionId && !sessionId))
  const pendingAsk = Boolean(active?.recovery?.pendingAsk)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, sessionPending.length, execution?.status, pendingAsk])

  const plan: TaskPlan | undefined = task?.plans?.[0]
  const awaitingPlan = task && task.subtasks.length > 0 && !execution && ['planned', 'awaiting_plan_approval'].includes(task.currentStep)
  const planning = task?.currentStep === 'planning'
  const planInterrupted = task?.currentStep === 'plan_interrupted'
  const finishedTask = task && (['completed', 'cancelled'].includes(task.status) || execution?.status === 'applied')
  const sending = sessionPending.some((message) => message.status === 'sending')

  const send = () => {
    const content = text.trim()
    if (!content || !project || sending) return
    if (syncTimer.current !== undefined) window.clearTimeout(syncTimer.current)
    setText('')
    void actions.sendMessage(content, storedDraft.mode, storedDraft.autoRun)
  }

  return (
    <aside className="chat-panel" data-testid="chat-panel">
      <PanelHeader title={active?.title && sessionId ? active.title : 'Neue Sitzung'}>
        {active && sessionId ? <StatusDot status={active.status === 'active' ? 'ok' : active.status} /> : null}
        {execution ? (
          <button className="btn small ghost" onClick={() => actions.setSideView('agents')}>
            <StatusDot status={execution.status} /> Agenten
          </button>
        ) : null}
        <button className="icon-btn" title="Neue Sitzung" aria-label="Neue Sitzung" onClick={() => actions.newSession()}>
          <MessageSquarePlus size={16} />
        </button>
      </PanelHeader>
      <div className="chat-messages" data-testid="chat-messages">
        {!project ? <div className="empty">Öffne zuerst ein Projekt.</div> : null}
        {project && !messages.length && !sessionPending.length ? (
          <div className="msg system">
            Beschreibe eine Coding-Aufgabe. Der Orchestrator analysiert das Repository, zerlegt die Aufgabe und delegiert Teilaufgaben an lokale Modelle; schwierige oder riskante Teile übernimmt er selbst. Alle Änderungen entstehen in isolierten Worktrees und werden erst nach deiner Freigabe übernommen.
            {'\n\n'}Mit „Frage“ kannst du Architektur besprechen oder Code erklären lassen, ohne etwas auszuführen. Die Sitzung bleibt erhalten, auch wenn du die Ansicht wechselst oder die App neu startest.
          </div>
        ) : null}
        {active?.hasMore ? <div className="faint" style={{ textAlign: 'center', fontSize: 11 }}>Ältere Nachrichten: im Sitzungsexport</div> : null}
        {messages.map((message) => <Message key={message.id} message={message} />)}
        {sessionPending.map((message) => <PendingBubble key={message.clientId} message={message} />)}
        {pendingAsk ? (
          <div className="msg system row">
            <Spinner /> Orchestrator antwortet …
          </div>
        ) : null}
        {planning ? (
          <div className="msg system row">
            <Spinner /> Plan wird erstellt …
          </div>
        ) : null}
        {planInterrupted && sessionId ? (
          <div className="callout warn stack">
            Die Planung wurde unterbrochen.
            <AsyncButton className="btn small" onClick={() => actions.retryPlan(sessionId)}>
              <RotateCcw size={13} /> Erneut planen
            </AsyncButton>
          </div>
        ) : null}
        {awaitingPlan && plan ? (
          <div className="card stack">
            <div className="row">
              <strong>Modellzuordnung</strong>
              <span className="spacer" />
              <Badge kind={plan.source === 'deterministic-fallback' ? 'warn' : 'premium'}>{plan.source === 'deterministic-fallback' ? 'Fallback-Plan' : plan.source}</Badge>
            </div>
            {task!.subtasks.map((subtask) => (
              <div key={subtask.id} className="row" style={{ fontSize: 12 }}>
                <span className="mono faint">{subtask.key}</span>
                <span className="truncate" style={{ flex: 1 }}>{subtask.title}</span>
                <Badge kind={subtask.selectedModelClass === 'premium_llm' ? 'premium' : subtask.selectedModelClass === 'local_llm' ? 'local' : 'error'}>
                  {subtask.selectedModelName ?? (subtask.selectedModelClass === 'no_llm' ? 'blockiert' : '?')}
                </Badge>
              </div>
            ))}
            {plan.dag?.warnings?.length ? plan.dag.warnings.map((warning, index) => <div key={index} className="callout warn">{warning}</div>) : null}
            <div className="row wrap">
              <AsyncButton className="btn primary" onClick={async () => { await api.post(`/tasks/${task!.id}/execute`); await actions.reloadTask(); void actions.loadActivity() }}>
                Ausführung starten
              </AsyncButton>
              <button className="btn" onClick={() => setReplanOpen((open) => !open)}>
                Neu planen
              </button>
            </div>
            {replanOpen ? (
              <div className="stack">
                <textarea className="textarea" rows={2} placeholder="Was soll am Plan anders sein?" value={feedback} onChange={(event) => setFeedback(event.target.value)} />
                <AsyncButton className="btn" disabled={!feedback.trim()} onClick={async () => { await api.post(`/tasks/${task!.id}/plan-with-orchestrator`, { feedback }); setFeedback(''); setReplanOpen(false); await actions.reloadTask() }}>
                  Mit Feedback neu planen
                </AsyncButton>
              </div>
            ) : null}
          </div>
        ) : null}
        {execution && ['pending', 'running', 'integrating', 'paused'].includes(execution.status) ? (
          <div className="msg system row" data-testid="run-running">
            <Spinner /> Ausführung {execution.status === 'paused' ? 'pausiert' : 'läuft'} – Details in der Agentenansicht.
          </div>
        ) : null}
        {execution?.status === 'awaiting_approval' ? <ApprovalBox execution={execution} /> : null}
        {execution?.status === 'applied' ? <AppliedBox execution={execution} /> : null}
        {execution && ['failed', 'interrupted'].includes(execution.status) ? (
          <div className={`callout ${execution.status === 'interrupted' ? 'warn' : 'error'} stack`}>
            {execution.status === 'interrupted' ? 'Die Ausführung wurde unterbrochen (App beendet oder Laufzeit neu gestartet). Bereits integrierte Teilaufgaben bleiben erhalten und werden beim Fortsetzen nicht erneut ausgeführt.' : execution.errorMessage ?? 'Die Ausführung ist fehlgeschlagen.'}
            {execution.integrationBranch ? (
              <AsyncButton className="btn small" onClick={async () => { await api.post(`/executions/${execution.id}/continue`); await actions.reloadExecution(); void actions.loadActivity() }}>
                <RotateCcw size={13} /> Ausführung fortsetzen
              </AsyncButton>
            ) : task ? (
              // interrupted before anything was integrated: nothing to resume, the plan can run again
              <AsyncButton className="btn small" onClick={async () => { await api.post(`/tasks/${task.id}/execute`); await actions.reloadTask(); void actions.loadActivity() }}>
                <RotateCcw size={13} /> Erneut ausführen
              </AsyncButton>
            ) : null}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <div className="row">
          <div className="segmented">
            <button className={storedDraft.mode === 'task' ? 'active' : ''} onClick={() => actions.setComposerDraft(sessionId, { mode: 'task' })}>
              Aufgabe
            </button>
            <button className={storedDraft.mode === 'ask' ? 'active' : ''} onClick={() => actions.setComposerDraft(sessionId, { mode: 'ask' })}>
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
