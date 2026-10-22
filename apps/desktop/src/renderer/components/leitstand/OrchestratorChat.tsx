import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, CheckSquare, GitPullRequestArrow, Hammer, MessageCircleQuestion, Palette, RotateCcw, Sparkles, Square, Users, X } from 'lucide-react'
import * as actions from '../../lib/actions'
import { api } from '../../lib/api'
import { composerOrchestrator, duoAnswer, duoCard, orchestratorTitle } from '../../lib/duo'
import { useVisibleLoader } from '../../lib/hooks'
import { DESIGN_TYPE_LABEL, milestones, TONE, type AgentCard, type StageInfo } from '../../lib/leitstand'
import { parseUnifiedDiff } from '../../lib/diff'
import { shallowEqual } from '../../lib/store/core'
import { useAppState, useSessionState } from '../../lib/store'
import type { ComposerDraft, PendingMessage } from '../../lib/stores'
import type { ChatMessage, CostMode, DesignMode, ExecutionRun, OrchestratorChoice, OrchestratorOverview, ReviewSummary, RunEvent, Subtask, Task } from '../../lib/types'
import { DESIGN_MODES, designModeOf } from '../../lib/workflow'
import { AsyncButton, Markdown, Spinner } from '../common'
import { PlanningProgress } from '../workflow/PlanningProgress'
import { designAction } from '../../lib/workflow-actions'
import { Chip, Seg } from '../ui'

const EMPTY_DRAFT: ComposerDraft = { text: '', mode: 'task', autoRun: false }
const time = (value: string) => new Date(value).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })

type Entry =
  | { kind: 'message'; at: string; message: ChatMessage }
  | { kind: 'milestone'; at: string; key: string; text: string; tone: keyof typeof TONE }

export function OrchestratorChat({ task, execution, events, subtasks, cards, stage }: { task?: Task; execution?: ExecutionRun; events: RunEvent[]; subtasks: Subtask[]; cards: AgentCard[]; stage: StageInfo }) {
  const project = useAppState((state) => state.project)
  const { costMode, orchestrator, orchestratorMode, duoLead } = useAppState((state) => ({ costMode: state.settings?.costMode, orchestrator: state.settings?.orchestrator, orchestratorMode: state.settings?.orchestratorMode, duoLead: state.settings?.duoLead }), shallowEqual)
  // which CLIs are connected (cached status in the runtime; the composer offers only those)
  const { data: overview } = useVisibleLoader(() => api.get<OrchestratorOverview>('/orchestrator'), [orchestrator, orchestratorMode], 60_000)
  const sessionId = useAppState((state) => state.workspace.activeSessionId)
  const storedDraft = useAppState((state) => state.workspace.composer[actions.composerKey(state.workspace.activeSessionId)]) ?? EMPTY_DRAFT
  const { active, pending, older } = useSessionState((state) => ({ active: state.active, pending: state.pending, older: state.older }), shallowEqual)
  const [text, setText] = useState(storedDraft.text)
  const endRef = useRef<HTMLDivElement>(null)
  const syncTimer = useRef<number | undefined>(undefined)

  // The composer text is a persisted draft per session; drafts prepared elsewhere replace it.
  const ownDraft = useRef(storedDraft.text)
  useEffect(() => {
    ownDraft.current = storedDraft.text
    setText(storedDraft.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  useEffect(() => {
    if (storedDraft.text === ownDraft.current) return
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

  const messages = useMemo(() => {
    if (active?.id !== sessionId || !active) return []
    const loaded = older?.sessionId === active.id ? older.messages : []
    const ids = new Set(active.messages.map((message) => message.id))
    return [...loaded.filter((message) => !ids.has(message.id)), ...active.messages]
  }, [active, older, sessionId])
  const hasOlder = Boolean(active && active.id === sessionId && (older && older.sessionId === active.id ? older.hasMore : active.hasMore))
  const sessionPending = pending.filter((message) => (message.sessionId ?? undefined) === sessionId || (!message.sessionId && !sessionId))
  const pendingAsk = Boolean(active?.recovery?.pendingAsk)
  const sending = sessionPending.some((message) => message.status === 'sending')

  // chat messages and short agent updates of the current run, in time order
  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = messages.map((message) => ({ kind: 'message', at: message.createdAt, message }))
    for (const milestone of milestones(events, subtasks)) list.push({ kind: 'milestone', ...milestone })
    return list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  }, [messages, events, subtasks])

  // the draft message the user decides on right now (older drafts are history)
  const reviewDraftId = useMemo(() => (stage.state === 'design_review' && task ? [...messages].reverse().find((message) => message.taskId === task.id && message.metadata?.kind === 'design_draft')?.id : undefined), [messages, stage.state, task])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [entries.length, sessionPending.length, pendingAsk, stage.state])

  const send = () => {
    const content = text.trim()
    if (!content || !project || sending) return
    if (syncTimer.current !== undefined) window.clearTimeout(syncTimer.current)
    ownDraft.current = ''
    setText('')
    void actions.sendMessage(content, storedDraft.mode, storedDraft.autoRun, designModeOf(storedDraft.mode, storedDraft.designMode), choice.send)
  }

  const choice = composerOrchestrator(overview, { orchestrator: orchestrator ?? null, orchestratorMode: orchestratorMode ?? 'single' }, storedDraft.orchestrator)
  const orchestratorName = orchestrator || orchestratorMode === 'duo' ? orchestratorTitle({ orchestrator: orchestrator ?? null, orchestratorMode: orchestratorMode ?? 'single', duoLead: duoLead ?? 'claude-code' }, execution) : 'nicht verbunden'
  const placeholder = storedDraft.mode === 'ask' ? 'Frage zum Projekt … (Strg+Enter)' : stage.state === 'design_review' ? '„passt“ gibt das Design frei – oder beschreibe Änderungen … (Strg+Enter)' : stage.state === 'draft' || stage.state === 'done' ? 'Was soll umgesetzt werden? (Strg+Enter)' : 'Ergänzung zur Aufgabe … (Strg+Enter)'

  return (
    <aside className="ls-chat chat-panel" data-testid="chat-panel">
      <div className="ls-chat-head">
        <div className="kind-icon" style={{ width: 28, height: 28, borderRadius: 9, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          <Sparkles size={15} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, minWidth: 0, flex: 1 }}>
          <strong style={{ fontSize: 13.5 }}>Orchestrator</strong>
          <span className="faint truncate" style={{ fontSize: 11.5 }}>{orchestratorName} · über dein Abo</span>
        </div>
        <Seg size="sm" label="Kostenmodus" value={(costMode ?? 'balanced') as CostMode} onChange={(value) => void actions.updateSettings({ costMode: value })} options={[{ id: 'cheapest', label: 'Cheapest', title: 'Möglichst alles lokal' }, { id: 'balanced', label: 'Balanced', title: 'Lokal zuerst, riskante Teile an Premium' }, { id: 'quality', label: 'Quality', title: 'Premium plant ausführlicher und reviewt' }]} />
      </div>
      <div className="ls-chat-body chat-messages" data-testid="chat-messages">
        {!project ? <div className="chat-note">Öffne zuerst über den Projektknopf oben links ein Projekt.</div> : null}
        {project && !messages.length && !sessionPending.length ? (
          <div className="chat-note">
            Beschreibe eine Coding-Aufgabe. Der Orchestrator analysiert das Repository, zerlegt die Aufgabe und delegiert Teilaufgaben an lokale Modelle; schwierige oder riskante Teile übernimmt er selbst. Alle Änderungen entstehen in isolierten Worktrees und werden erst nach deiner Freigabe übernommen.
            {'\n\n'}Mit „Frage“ besprichst du Architektur oder lässt Code erklären, ohne etwas auszuführen.
          </div>
        ) : null}
        {hasOlder ? (
          <div style={{ textAlign: 'center' }}>
            <AsyncButton className="btn small ghost" onClick={() => actions.loadOlderMessages()}>Ältere Nachrichten laden</AsyncButton>
          </div>
        ) : null}
        {entries.map((entry) =>
          entry.kind === 'milestone' ? (
            <div key={`m-${entry.at}-${entry.key}-${entry.text}`} className="chat-milestone">
              <Chip tone={entry.tone}>{entry.key}</Chip>
              <span>{entry.text}</span>
            </div>
          ) : (
            <Message key={entry.message.id} message={entry.message} task={task} execution={execution} cards={cards} approval={stage.state === 'approval'} designReview={entry.message.id === reviewDraftId} />
          ),
        )}
        {sessionPending.map((message) => <PendingBubble key={message.clientId} message={message} />)}
        {(stage.state === 'planning' || stage.state === 'designing') && task ? (
          <div style={{ paddingLeft: 34 }}>
            <PlanningProgress task={task} />
          </div>
        ) : null}
        {pendingAsk ? (
          <div className="chat-milestone">
            <Spinner /> Orchestrator antwortet …
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
      <div className="ls-composer">
        <div className="composer-box" style={{ boxShadow: stage.state === 'draft' && project ? 'var(--glow)' : 'none' }}>
          <textarea
            id="chat-input"
            rows={3}
            placeholder={placeholder}
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
          {choice.options.length && choice.value ? (
            <div className="row" style={{ gap: 8 }} data-testid="orchestrator-choice">
              <span className="faint row" style={{ gap: 5, fontSize: 11.5 }} title="Wer diesen Auftrag bearbeitet; „Beide“ lässt Claude Code und Codex parallel arbeiten und abgleichen">
                <Users size={12} /> Orchestrator
              </span>
              <Seg size="sm" label="Orchestrator" value={choice.value} onChange={(value: OrchestratorChoice) => actions.setComposerDraft(sessionId, { orchestrator: value })} options={choice.options} />
            </div>
          ) : null}
          {storedDraft.mode === 'task' ? (
            <div className="row" style={{ gap: 8 }} data-testid="design-mode">
              <span className="faint row" style={{ gap: 5, fontSize: 11.5 }} title="Entwurf von Tokens, Komponenten und einer Vorschau, den du vor der Planung freigibst">
                <Palette size={12} /> Design-Phase
              </span>
              <Seg size="sm" label="Design-Phase" value={storedDraft.designMode ?? 'auto'} onChange={(designMode: DesignMode) => actions.setComposerDraft(sessionId, { designMode })} options={DESIGN_MODES} />
            </div>
          ) : null}
          <div className="row" style={{ gap: 8 }}>
            <Seg size="sm" label="Art der Nachricht" value={storedDraft.mode} onChange={(mode) => actions.setComposerDraft(sessionId, { mode })} options={[{ id: 'task', label: 'Aufgabe', icon: Hammer }, { id: 'ask', label: 'Frage', icon: MessageCircleQuestion }]} />
            {storedDraft.mode === 'task' ? (
              <button className="toggle-link" style={{ color: storedDraft.autoRun ? 'var(--accent)' : 'var(--faint)' }} aria-pressed={storedDraft.autoRun} onClick={() => actions.setComposerDraft(sessionId, { autoRun: !storedDraft.autoRun })} title="Startet die Ausführung, sobald der Plan steht">
                {storedDraft.autoRun ? <CheckSquare size={13} /> : <Square size={13} />}
                Plan direkt ausführen
              </button>
            ) : (
              <span className="faint" style={{ fontSize: 11.5 }}>Nutzt den Orchestrator (Abo)</span>
            )}
            <span className="spacer" />
            <button className="send-btn" title="Senden (Strg+Enter)" aria-label="Senden" disabled={!text.trim() || !project || sending} onClick={send}>
              {sending ? <Spinner /> : <ArrowUp size={16} strokeWidth={2.4} />}
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

const Message = memo(function Message({ message, task, execution, cards, approval, designReview }: { message: ChatMessage; task?: Task; execution?: ExecutionRun; cards: AgentCard[]; approval: boolean; designReview?: boolean }) {
  if (message.role === 'user') return <div className="chat-user" data-role="user">{message.content}</div>
  const kind = message.metadata?.kind
  if (message.role === 'system' || (message.role === 'agent' && kind === 'execution_started')) return <div className="chat-note" data-role={message.role}>{message.content}</div>
  const isPlan = kind === 'task_plan' && task?.plans?.some((plan) => plan.id === message.metadata.taskPlanId) && task.plans[0]?.id === message.metadata.taskPlanId
  const isSummary = kind === 'run_summary' && execution && message.metadata.executionId === execution.id
  const card = kind === 'duo_reconciled' ? duoCard(message.metadata) : undefined
  const answers = kind === 'answer' ? duoAnswer(message) : undefined
  return (
    <div className="chat-orch" data-role={message.role}>
      <div className="kind-icon" style={{ width: 24, height: 24, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent)', flex: 'none' }}>
        <Sparkles size={13} />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="faint" style={{ fontSize: 11.5 }}>{message.role === 'agent' ? 'Agenten' : 'Orchestrator'} · {time(message.createdAt)}</div>
        {card ? <DuoReconciledCard card={card} /> : answers ? <DuoAnswers answer={answers} /> : <Markdown text={message.content} />}
        {isPlan && cards.length ? (
          <div className="plan-card">
            {cards.map((card) => (
              <button key={card.id} className="plan-row" onClick={() => actions.setSelectedSubtask(card.id)} title={card.goal}>
                <span className="mono faint" style={{ fontSize: 11, minWidth: 22, whiteSpace: 'nowrap' }}>{card.key}</span>
                <span className="truncate" style={{ flex: 1 }}>{card.title}</span>
                <Chip tone={card.tone}>{card.short}</Chip>
              </button>
            ))}
          </div>
        ) : null}
        {isSummary && approval ? <ApprovalCard execution={execution} /> : null}
        {kind === 'design_draft' && designReview ? <DesignDraftCard message={message} /> : null}
      </div>
    </div>
  )
})

/** Duo mode: what both orchestrators proposed for a phase and how it was reconciled. */
function DuoReconciledCard({ card }: { card: NonNullable<ReturnType<typeof duoCard>> }) {
  return (
    <div className="duo-card" data-testid="duo-reconciled">
      <div className="row" style={{ gap: 8 }}>
        <Users size={15} style={{ color: 'var(--accent)' }} />
        <strong>Duo-Abgleich · {card.phase}</strong>
        <span className="spacer" />
        <Chip tone={card.fallback ? 'tool' : 'accent'}>{card.fallback ? 'Fallback' : card.result}</Chip>
      </div>
      <div className="duo-columns">
        {card.columns.map((column) => (
          <div key={column.provider} className="duo-column">
            <span className="duo-column-head">{column.name}</span>
            <span className={column.summary ? undefined : 'faint'}>{column.summary ?? 'kein Vorschlag'}</span>
          </div>
        ))}
      </div>
      {card.notes.length ? (
        <div className="stack" style={{ gap: 4 }}>
          <span className="duo-column-head">Abgleich</span>
          <ul className="duo-notes">{card.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
        </div>
      ) : null}
      {card.fallback ? <span className="muted" style={{ fontSize: 12 }}>⚠ {card.fallback}</span> : <span className="faint" style={{ fontSize: 11.5 }}>Ergebnis: {card.result}</span>}
    </div>
  )
}

/** Duo chat answer: both answers labelled side by side (stacked when narrow). */
function DuoAnswers({ answer }: { answer: NonNullable<ReturnType<typeof duoAnswer>> }) {
  return (
    <div className="stack" style={{ gap: 8 }} data-testid="duo-answer">
      <div className="duo-columns">
        {answer.answers.map((entry) => (
          <div key={entry.provider} className="duo-column">
            <span className="duo-column-head">{entry.name}</span>
            <Markdown text={entry.text} />
          </div>
        ))}
      </div>
      {answer.fallback ? <span className="muted" style={{ fontSize: 12 }}>⚠ {answer.fallback}</span> : null}
    </div>
  )
}

function ApprovalCard({ execution }: { execution: ExecutionRun }) {
  const files = parseUnifiedDiff(execution.finalDiff)
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const deleted = files.reduce((sum, file) => sum + file.deleted, 0)
  const review = execution.review as ReviewSummary
  return (
    <div className="approval-card">
      <div className="row" style={{ gap: 8 }}>
        <GitPullRequestArrow size={16} style={{ color: 'var(--accent)' }} />
        <strong>
          {files.length} Datei{files.length === 1 ? '' : 'en'} · +{added} −{deleted}
        </strong>
        <span className="spacer" />
        {review?.result ? <span className="mono" style={{ fontSize: 11, color: review.result.verdict === 'approve' ? 'var(--ok)' : 'var(--tool)' }}>Review {review.result.score}/100</span> : null}
      </div>
      <button className="btn primary" style={{ justifyContent: 'center' }} onClick={() => actions.setScreen('review')}>
        Prüfen und freigeben
      </button>
    </div>
  )
}

/** The draft the user decides on right now: a shortcut to the approval next to the review in the Leitstand. */
function DesignDraftCard({ message }: { message: ChatMessage }) {
  const version = Number(message.metadata.version) || undefined
  const type = String(message.metadata.designType ?? '')
  const taskId = message.taskId
  return (
    <div className="approval-card" data-testid="design-draft-card">
      <div className="row" style={{ gap: 8 }}>
        <Palette size={16} style={{ color: 'var(--accent)' }} />
        <strong>Design-Entwurf{version ? ` ${version}` : ''}</strong>
        <span className="spacer" />
        {type ? <Chip tone="accent">{DESIGN_TYPE_LABEL[type] ?? type}</Chip> : null}
      </div>
      <span className="muted" style={{ fontSize: 12 }}>Vorschau, Tokens und Komponenten stehen im Leitstand.</span>
      {taskId ? (
        <AsyncButton className="btn primary big" onClick={() => designAction(taskId, 'approve')}>
          Design freigeben
        </AsyncButton>
      ) : null}
    </div>
  )
}

function PendingBubble({ message }: { message: PendingMessage }) {
  return (
    <div className={`chat-user ${message.status === 'failed' ? 'failed' : 'pending'}`} data-testid="pending-message">
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
