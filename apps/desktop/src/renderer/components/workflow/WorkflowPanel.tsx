import { useEffect, useState } from 'react'
import { CirclePause, CirclePlay, RotateCcw } from 'lucide-react'
import * as actions from '../../lib/actions'
import { useExecution } from '../../lib/execution'
import { useAppState, useSessionState } from '../../lib/store'
import { workflowState, type WorkflowPhase } from '../../lib/workflow'
import { controlRun, replanTask, startTask, useWorkflowBusy } from '../../lib/workflow-actions'
import { AsyncButton, Badge, Spinner } from '../common'
import { AppliedBox, ApprovalBox } from './ApprovalBox'
import { PlanningProgress } from './PlanningProgress'
import { SubtaskDetails } from './SubtaskDetails'
import { localizeEngineText } from '../../lib/engine-text'

const STEPS: Array<{ id: WorkflowPhase; label: string }> = [
  { id: 'task', label: 'Aufgabe' }, { id: 'plan', label: 'Plan' }, { id: 'execution', label: 'Ausführung' }, { id: 'approval', label: 'Freigabe' },
]

export function WorkflowPanel() {
  const { task, execution: selectedExecution, selectedSubtaskId } = useExecution()
  const execution = selectedExecution?.taskId === task?.id ? selectedExecution : undefined
  const project = useAppState((state) => state.project)
  const sessionId = useAppState((state) => state.workspace.activeSessionId)
  const view = useAppState((state) => state.workspace.chatView ?? 'workflow')
  const pending = useSessionState((state) => state.pending).filter((entry) => entry.mode === 'task' && (entry.sessionId ?? undefined) === sessionId)
  const sending = pending.some((entry) => entry.status === 'sending')
  const current = workflowState(task, execution)
  const plan = task?.plans?.[0]
  const [replanOpen, setReplanOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const busyTask = useWorkflowBusy(`task:${task?.id}`)
  const busyRun = useWorkflowBusy(`execution:${execution?.id}`)
  const busy = busyTask || busyRun || sending
  const stepIndex = STEPS.findIndex((step) => step.id === current.phase)
  const subtasks = execution?.task?.subtasks ?? task?.subtasks ?? []
  const completed = subtasks.filter((entry) => entry.status === 'completed').length
  const blocked = subtasks.filter((entry) => !entry.fastPath && (entry.selectedModelClass === 'no_llm' || entry.status === 'blocked')).length
  const showDetails = current.state !== 'draft' && current.state !== 'planning' && current.state !== 'plan_error'
  useEffect(() => {
    if (selectedSubtaskId && view === 'workflow') {
      const frame = requestAnimationFrame(() => document.getElementById(`workflow-subtask-${selectedSubtaskId}`)?.scrollIntoView({ block: 'nearest' }))
      return () => cancelAnimationFrame(frame)
    }
  }, [selectedSubtaskId, view])

  return (
    <section className="workflow-panel" data-testid="workflow" data-phase={current.phase} data-state={current.state} tabIndex={-1} aria-label="Zentraler Arbeitsablauf">
      <ol className="workflow-steps" aria-label="Arbeitsschritte">
        {STEPS.map((step, index) => <li key={step.id} aria-current={step.id === current.phase ? 'step' : undefined} className={index < stepIndex || current.state === 'done' ? 'complete' : step.id === current.phase ? 'current' : ''}>
          <span>{index < stepIndex || current.state === 'done' ? '✓' : index + 1}</span>{step.label}
        </li>)}
      </ol>
      <h3 className="workflow-title">{current.label}</h3>
      {task ? <div className="workflow-goal">{task.userPrompt}</div> : <p className="muted">{project ? 'Beschreibe unten deine Aufgabe. Prüfe anschließend den Plan, starte die Ausführung und übernimm die geprüften Änderungen hier.' : 'Öffne zuerst ein Projekt, um eine Aufgabe zu starten.'}</p>}
      {sending ? <div className="row"><Spinner /> Aufgabe wird vorbereitet …</div> : null}
      {pending.filter((entry) => entry.status === 'failed').map((entry) => <div key={entry.clientId} className="callout error stack">
        <span>Aufgabe nicht gesendet: {entry.error}</span>
        <AsyncButton onClick={() => actions.retryPending(entry.clientId)}>Erneut senden</AsyncButton>
        <button className="btn small" onClick={() => actions.discardPending(entry.clientId)}>Zurück zum Entwurf</button>
      </div>)}
      {current.state === 'planning' && task ? <PlanningProgress task={task} /> : null}
      {current.state === 'plan_error' && task ? <div className="callout warn stack">
        <span>{task.currentStep === 'plan_interrupted' ? 'Die Planung wurde unterbrochen.' : 'Die Planung ist fehlgeschlagen. Details findest du im Verlauf.'}</span>
        <AsyncButton disabled={busy} onClick={() => replanTask(task.id)}><RotateCcw size={13} /> Erneut planen</AsyncButton>
      </div> : null}
      {current.state === 'ready' && task ? <div className="stack">
        <div className="muted">Prüfe die Teilaufgaben und ihre Zuordnung. Mit „Ausführung starten“ gibst du diesen Plan frei.</div>
        {blocked ? <div className="callout warn">{blocked} Teilaufgabe(n) ohne ausführbare Zuordnung. Wähle in den Plandetails ein verfügbares Modell oder plane neu.</div> : null}
        <div className="row wrap">
          <AsyncButton className="btn primary" disabled={busy || blocked > 0} onClick={() => startTask(task.id)}>Ausführung starten</AsyncButton>
          <button className="btn" disabled={busy} onClick={() => setReplanOpen((open) => !open)}>Neu planen</button>
        </div>
        {replanOpen ? <div className="stack">
          <textarea className="textarea" rows={2} aria-label="Feedback zum Plan" placeholder="Was soll am Plan anders sein?" value={feedback} onChange={(event) => setFeedback(event.target.value)} />
          <AsyncButton disabled={busy || !feedback.trim()} onClick={async () => { await replanTask(task.id, feedback); setFeedback(''); setReplanOpen(false) }}>Mit Feedback neu planen</AsyncButton>
        </div> : null}
      </div> : null}
      {execution && ['running', 'paused'].includes(current.state) ? <div className="stack" data-testid="run-running">
        <div className="row">{current.state === 'paused' ? <CirclePause size={14} /> : <Spinner />} {completed} von {subtasks.length} Teilaufgaben abgeschlossen</div>
        <div className="row wrap">
          {execution.status === 'running' ? <AsyncButton disabled={busy} title="Laufende Agenten beenden ihre Aufgabe." onClick={() => controlRun(execution, 'pause')}><CirclePause size={14} /> Pausieren</AsyncButton> : null}
          {execution.status === 'paused' ? <AsyncButton className="btn primary" disabled={busy} onClick={() => controlRun(execution, 'resume')}><CirclePlay size={14} /> Fortsetzen</AsyncButton> : null}
          <AsyncButton className="btn danger" disabled={busy} onClick={() => controlRun(execution, 'cancel')}>Ausführung abbrechen</AsyncButton>
        </div>
        <div className="muted">Änderungen entstehen im getrennten Arbeitsbereich. Danach kannst du sie hier prüfen und freigeben.</div>
      </div> : null}
      {execution && (current.state === 'recoverable' || current.state === 'cancelled') ? <div className="callout warn stack">
        <span>{execution.status === 'interrupted' ? 'Bereits integrierte Teilaufgaben bleiben beim Fortsetzen erhalten.' : execution.errorMessage ?? 'Du kannst die Ausführung erneut starten.'}</span>
        {execution.integrationBranch && current.state === 'recoverable' ? <AsyncButton className="btn primary" disabled={busy} onClick={() => controlRun(execution, 'continue')}><RotateCcw size={13} /> Ausführung fortsetzen</AsyncButton> : task ? <AsyncButton className="btn primary" disabled={busy} onClick={() => startTask(task.id)}>Erneut ausführen</AsyncButton> : null}
      </div> : null}
      {current.state === 'approval' && execution ? <ApprovalBox execution={execution} /> : null}
      {current.state === 'done' && execution ? <div className="stack">
        <div className="callout ok">{localizeEngineText(execution.summary) || 'Die Ausführung ist abgeschlossen.'}</div>
        <AppliedBox execution={execution} />
        <button className="btn primary" onClick={() => actions.newSession()}>Neue Aufgabe</button>
      </div> : null}
      {showDetails && task ? <details className="workflow-details" open={current.state === 'ready' || Boolean(selectedSubtaskId)}>
        <summary>Plan und Teilaufgaben · {subtasks.length}</summary>
        <div className="stack">
          {plan ? <><div>{plan.summary}</div><Badge kind={plan.source === 'deterministic-fallback' ? 'warn' : undefined}>{plan.source === 'fast-path' ? 'Fast Path (ohne Premium-Planung)' : plan.source === 'deterministic-fallback' ? 'Fallback-Plan' : plan.source}</Badge></> : null}
          {plan?.dag?.warnings?.map((warning, index) => <div key={index} className="callout warn">{warning}</div>)}
          {subtasks.map((subtask) => <SubtaskDetails key={subtask.id} subtask={subtask} runs={(execution?.agentRuns ?? []).filter((run) => run.subtaskId === subtask.id)} execution={execution} />)}
        </div>
      </details> : null}
      {execution ? <div className="workflow-detail-links">
        <button className="btn small" onClick={() => actions.setSideView('agents')}>Agentenübersicht</button>
        <button className="btn small" onClick={() => { actions.setBottomTab('logs'); actions.setBottomOpen(true) }}>Live-Protokoll</button>
        <button className="btn small" onClick={() => { actions.setBottomTab('run'); actions.setBottomOpen(true) }}>Laufdetails</button>
      </div> : null}
    </section>
  )
}
