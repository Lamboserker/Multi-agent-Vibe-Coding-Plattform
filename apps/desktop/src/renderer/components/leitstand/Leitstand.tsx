import { Fragment, useState } from 'react'
import { ArrowUpRight, Brain, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, CircleDashed, GitMerge, GitPullRequestArrow, LayoutGrid, MessageCircle, Orbit, Pause, Play, RotateCcw, Search, ShieldCheck, Sparkles, Square, Terminal, XCircle } from 'lucide-react'
import * as actions from '../../lib/actions'
import { api, errorMessage } from '../../lib/api'
import { openChangedFile } from '../../lib/agent-files'
import { formatClock, TONE, type AgentCard, type StageInfo, type Tone } from '../../lib/leitstand'
import { useAppState, useSessionState } from '../../lib/store'
import type { ExecutionRun, InstalledModel, ReviewSummary, ScheduleForecast, Subtask, Task, ValidationReport } from '../../lib/types'
import { useLoader } from '../../lib/hooks'
import { AgentSwitcher } from '../agents/AgentProfiles'
import { ProjectSetup } from '../panels/ProjectsPanel'
import { useLeitstand } from '../../lib/use-leitstand'
import { controlRun, discardRun, replanTask, startTask, useWorkflowBusy } from '../../lib/workflow-actions'
import { localizeEngineText } from '../../lib/engine-text'
import { AsyncButton, PromptDialog } from '../common'
import { Bar, Chip, Dot, Eyebrow, KindIcon, StatusPill } from '../ui'
import { OrchestratorChat } from './OrchestratorChat'

const SUGGESTIONS = ['Fehlende Tests für die zuletzt geänderten Module ergänzen', 'Flaky Tests finden und stabilisieren', 'TODO-Kommentare im Code abarbeiten']

type PipeState = 'pending' | 'running' | 'completed' | 'failed'
const PIPE_TONE: Record<PipeState, Tone> = { pending: 'faint', running: 'accent', completed: 'ok', failed: 'err' }

export function Leitstand() {
  const data = useLeitstand()
  const variant = useAppState((state) => state.ui.leitstandVariant)
  const { task, execution, stage, cards, subtasks, events } = data
  return (
    <div className="ls">
      <OrchestratorChat task={task} execution={execution} events={events} subtasks={subtasks} cards={cards} stage={stage} />
      <section className="ls-main" data-testid="workflow" data-state={stage.state} tabIndex={-1} aria-label="Leitstand">
        <RunHeader {...data} />
        <RunNotice stage={stage} execution={execution} />
        {variant === 'graph' ? <RunGraph {...data} /> : <RunTiles {...data} />}
      </section>
    </div>
  )
}

type Data = ReturnType<typeof useLeitstand>

/** Why a run did not finish – in words. (Git is set up by the app itself when a run starts.) */
function RunNotice({ stage, execution }: { stage: StageInfo; execution?: ExecutionRun }) {
  // a run the user ended shows no failure banner any more
  const failure = stage.state === 'recoverable' && execution?.errorMessage ? execution.errorMessage : undefined
  if (!failure) return null
  return (
    <div className="run-notice error" role="alert" data-testid="run-notice">
      <XCircle size={16} />
      <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>
        <strong>Die Ausführung ist fehlgeschlagen: </strong>
        {/could not be set up automatically/i.test(failure) ? `Git konnte in diesem Ordner nicht automatisch eingerichtet werden (${localizeEngineText(failure.replace(/^.*?: /, ''))}). Öffne den eigentlichen Projektordner statt eines Laufwerks oder des Benutzerordners.` : localizeEngineText(failure)}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header: stage, goal, steps, lifecycle controls
// ---------------------------------------------------------------------------

const STEPS: Array<{ label: string; phase: number }> = [
  { label: 'Aufgabe', phase: 0 },
  { label: 'Plan', phase: 1 },
  { label: 'Ausführung', phase: 2 },
  { label: 'Freigabe', phase: 3 },
]

function RunHeader({ task, execution, stage, cards, elapsedMs }: Data) {
  const busyTask = useWorkflowBusy(`task:${task?.id}`)
  const busyRun = useWorkflowBusy(`execution:${execution?.id}`)
  const busy = busyTask || busyRun
  const [replan, setReplan] = useState(false)
  const done = cards.filter((card) => card.status === 'completed').length
  const blocked = cards.filter((card) => card.kind === 'blocked').length
  const sessionTitle = useSessionState((state) => state.active?.title)
  // the session title is known before its task has loaded (restore after a reload)
  const title = sessionTitle || (task ? task.userPrompt.split('\n')[0]!.slice(0, 120) : 'Neue Sitzung')
  return (
    <div className="ls-head">
      <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span className="stage-label" style={{ color: TONE[stage.tone].color }}>
          <Dot tone={stage.tone} pulse={stage.state === 'running' || stage.state === 'planning'} />
          {stage.label}
        </span>
        <div className="ls-title truncate" data-testid="session-title">{title}</div>
        <div className="muted truncate" style={{ fontSize: 12.5 }} title={task?.userPrompt}>{task ? task.userPrompt : 'Beschreibe links im Chat, was umgesetzt werden soll.'}</div>
      </div>
      <ol className="step-track" aria-label="Arbeitsschritte">
        {STEPS.map((step, index) => {
          const isDone = step.phase < stage.phase || stage.phase === 4
          const current = step.phase === stage.phase || (stage.phase === 4 && step.phase === 3)
          return (
            <li key={step.label} aria-current={current ? 'step' : undefined}>
              <span className={`step ${current ? 'current' : ''} ${isDone ? 'done' : ''}`} title={step.label}>
                <span className="step-mark">{isDone ? '✓' : index + 1}</span>
                {current ? <span className="step-label">{step.label}</span> : null}
              </span>
              {index < STEPS.length - 1 ? <span className="step-line" /> : null}
            </li>
          )
        })}
      </ol>
      <div className="row" style={{ gap: 8, flex: 'none' }}>
        {stage.state === 'ready' && task ? (
          <>
            <button className="btn" disabled={busy} onClick={() => setReplan(true)}>Neu planen</button>
            <AsyncButton className="btn primary" disabled={busy || blocked > 0} title={blocked ? `${blocked} Teilaufgabe(n) ohne Zuordnung` : undefined} onClick={() => startTask(task.id)}>
              <Play size={14} /> Ausführung starten
            </AsyncButton>
          </>
        ) : null}
        {stage.state === 'plan_error' && task ? (
          <AsyncButton className="btn primary" disabled={busy} onClick={() => replanTask(task.id)}>
            <RotateCcw size={13} /> Erneut planen
          </AsyncButton>
        ) : null}
        {(stage.state === 'running' || stage.state === 'paused') && execution ? (
          <div className="row" style={{ gap: 8 }} data-testid="run-running">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 140 }}>
              <div className="row muted" style={{ justifyContent: 'space-between', fontSize: 11.5 }}>
                <span>{done} von {cards.length} fertig</span>
                <span className="mono">{formatClock(elapsedMs)}</span>
              </div>
              <Bar value={cards.length ? (done / cards.length) * 100 : 0} height={5} />
            </div>
            {execution.status === 'paused' ? (
              <AsyncButton className="hdr-icon" title="Fortsetzen" disabled={busy} onClick={() => controlRun(execution, 'resume')}>
                <Play size={15} />
              </AsyncButton>
            ) : (
              <AsyncButton className="hdr-icon" title="Pausieren – laufende Agenten beenden ihre Aufgabe" disabled={busy || execution.status !== 'running'} onClick={() => controlRun(execution, 'pause')}>
                <Pause size={15} />
              </AsyncButton>
            )}
            <AsyncButton className="hdr-icon danger" title="Ausführung abbrechen" disabled={busy} onClick={() => controlRun(execution, 'cancel')}>
              <Square size={13} />
            </AsyncButton>
          </div>
        ) : null}
        {(stage.state === 'recoverable' || stage.state === 'cancelled') && execution && task ? (
          <>
            {stage.state === 'recoverable' ? (
              <AsyncButton className="btn" disabled={busy} title="Beendet den Lauf und räumt seinen Arbeitsstand auf. Die Sitzung bleibt erhalten." onClick={() => discardRun(execution)}>
                <Square size={12} /> Lauf beenden
              </AsyncButton>
            ) : null}
            <button className="btn" disabled={busy} title="Plant die Aufgabe neu (optional mit deinem Hinweis), statt denselben Plan zu wiederholen" onClick={() => setReplan(true)}>Neu planen</button>
            {execution.integrationBranch && stage.state === 'recoverable' ? (
              <AsyncButton className="btn primary" disabled={busy} onClick={() => controlRun(execution, 'continue')}>
                <RotateCcw size={13} /> Ausführung fortsetzen
              </AsyncButton>
            ) : (
              <AsyncButton className="btn primary" disabled={busy} onClick={() => startTask(task.id)}>Erneut ausführen</AsyncButton>
            )}
          </>
        ) : null}
        {stage.state === 'approval' ? (
          <button className="btn primary" onClick={() => actions.setScreen('review')}>
            <GitPullRequestArrow size={14} /> Änderungen prüfen
          </button>
        ) : null}
        {stage.state === 'done' ? (
          <span className="row" style={{ gap: 6, color: 'var(--ok)', fontWeight: 500 }}>
            <CheckCircle2 size={15} /> {execution?.status === 'applied' ? 'Übernommen' : 'Abgeschlossen'}
          </span>
        ) : null}
      </div>
      {replan && task ? (
        <PromptDialog
          title="Neu planen – was soll anders sein?"
          placeholder="z. B. Tests in eine eigene Teilaufgabe, T3 lokal statt Premium …"
          onCancel={() => setReplan(false)}
          onSubmit={(feedback) => {
            setReplan(false)
            void replanTask(task.id, feedback).catch((error: unknown) => actions.notify(errorMessage(error), 'error'))
          }}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function orchestratorSummary(stage: StageInfo, cards: AgentCard[], execution?: ExecutionRun): string {
  const premium = cards.filter((card) => card.kind === 'premium' && card.active).map((card) => card.key)
  switch (stage.state) {
    case 'planning': return 'Analysiert Repository und plant …'
    case 'ready': return 'Plan wartet auf deine Freigabe'
    case 'running': return execution?.status === 'integrating' ? 'Integriert Ergebnisse, startet Review' : `Überwacht ${cards.filter((card) => card.active).length} Agent(en)${premium.length ? `, bearbeitet ${premium.join(', ')} selbst` : ''}`
    case 'paused': return 'Pausiert – laufende Agenten beenden ihre Aufgabe'
    case 'approval': return 'Review fertig, wartet auf dich'
    case 'done': return 'Lauf abgeschlossen'
    case 'plan_error': return 'Planung fehlgeschlagen'
    case 'recoverable': return execution?.status === 'failed' ? 'Lauf fehlgeschlagen' : 'Lauf unterbrochen – fortsetzbar'
    case 'cancelled': return 'Lauf abgebrochen'
    default: return 'Wartet auf eine Aufgabe'
  }
}

function pipelineStates(stage: StageInfo, execution?: ExecutionRun) {
  const review = execution?.review as ReviewSummary | undefined
  const validation = execution?.finalValidation as ValidationReport | undefined
  const finished = ['awaiting_approval', 'applied', 'completed'].includes(execution?.status ?? '')
  const integration: PipeState = execution?.status === 'integrating' ? 'running' : finished ? (validation?.ok === false ? 'failed' : 'completed') : execution?.status === 'failed' ? 'failed' : 'pending'
  const reviewState: PipeState = finished ? (review?.result?.verdict === 'reject' ? 'failed' : 'completed') : execution?.status === 'integrating' && validation?.results ? 'running' : 'pending'
  const approval: PipeState = stage.state === 'approval' ? 'running' : stage.state === 'done' ? 'completed' : 'pending'
  return { integration, review: reviewState, approval, reviewInfo: review, validation }
}

function SubtaskActions({ card, subtask, execution }: { card: AgentCard; subtask?: Subtask; execution?: ExecutionRun }) {
  const [hint, setHint] = useState(false)
  const { data: installed } = useLoader(() => api.get<InstalledModel[]>('/local-models/installed').catch(() => [] as InstalledModel[]), [])
  const canChangeModel = ['planned', 'queued', 'failed', 'cancelled', 'skipped', 'blocked'].includes(card.status) && card.kind !== 'tool'
  const premiumPlanned = card.kind === 'premium' && !card.escalated
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      <AsyncButton
        className="btn small"
        disabled={!canChangeModel || premiumPlanned}
        title={premiumPlanned ? 'Vom Router bereits Premium zugeordnet' : !canChangeModel ? 'Während der Agent arbeitet, ist das Modell fest' : undefined}
        onClick={async () => {
          await api.post(`/subtasks/${card.id}/model`, { model: card.escalated ? null : 'premium' })
          await actions.reloadTask()
        }}
      >
        <ArrowUpRight size={12} />
        {premiumPlanned ? 'Bereits Premium' : card.escalated ? 'Zurück zu lokal' : 'An Premium eskalieren'}
      </AsyncButton>
      <button className="btn small" onClick={() => setHint(true)}>
        <MessageCircle size={12} /> Hinweis geben
      </button>
      {subtask && ['failed', 'cancelled', 'skipped', 'blocked'].includes(subtask.status) ? (
        <AsyncButton className="btn small" onClick={async () => { await api.post(`/subtasks/${subtask.id}/retry`); actions.notify(`${subtask.key} wird erneut ausgeführt.`, 'info') }}>
          <RotateCcw size={12} /> Wiederholen
        </AsyncButton>
      ) : null}
      {subtask && execution && ['running', 'validating', 'repairing', 'queued'].includes(subtask.status) ? (
        <AsyncButton className="btn small danger" onClick={() => api.post(`/subtasks/${subtask.id}/cancel`)}>
          <Square size={11} /> Abbrechen
        </AsyncButton>
      ) : null}
      {subtask?.patchText ? (
        <button className="btn small" onClick={() => actions.openDiff({ title: `Patch ${subtask.key}`, path: `${subtask.key}.diff`, original: '', modified: subtask.patchText ?? '', source: { type: 'subtask-patch', taskId: subtask.taskId, subtaskId: subtask.id } })}>
          Patch ansehen
        </button>
      ) : null}
      {subtask && card.kind !== 'tool' ? (
        <div className="row" style={{ gap: 6, width: '100%' }}>
          <select
            className="select small"
            aria-label="Modell"
            disabled={!canChangeModel}
            value={subtask.manualModel ?? ''}
            onChange={(event) => void api.post(`/subtasks/${subtask.id}/model`, { model: event.target.value || null }).then(() => actions.reloadTask()).catch((error: unknown) => actions.notify(errorMessage(error), 'error'))}
          >
            <option value="">Modell: automatisch (Router)</option>
            <option value="premium">Premium-Orchestrator</option>
            {installed?.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}
          </select>
          <AgentSwitcher subtaskId={subtask.id} agentId={subtask.agentId} disabled={!['planned', 'queued'].includes(subtask.status)} onChanged={() => void actions.reloadTask()} />
        </div>
      ) : null}
      {hint ? (
        <PromptDialog
          title={`Hinweis an ${card.key}`}
          placeholder="z. B. Nutze die bestehende HttpError-Klasse, keine neue Abhängigkeit"
          onCancel={() => setHint(false)}
          onSubmit={async (text) => {
            setHint(false)
            try {
              const result = await api.post<{ message: string }>(`/subtasks/${card.id}/hint`, { text })
              actions.notify(result.message, 'success')
              await actions.reloadTask()
            } catch (error) {
              actions.notify(errorMessage(error), 'error')
            }
          }}
        />
      ) : null}
    </div>
  )
}

function CheckList({ card }: { card: AgentCard }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {card.checks.map((check) => {
        const Icon = check.state === 'ok' ? CheckCircle2 : check.state === 'fail' ? XCircle : CircleDashed
        return (
          <div key={check.label} className="row" style={{ gap: 8, fontSize: 12.5 }}>
            <Icon size={14} style={{ color: check.state === 'ok' ? 'var(--ok)' : check.state === 'fail' ? 'var(--err)' : 'var(--faint)' }} />
            <span style={{ flex: 1 }}>{check.label}</span>
            <span className="mono faint" style={{ fontSize: 11 }}>{check.detail}</span>
          </div>
        )
      })}
    </div>
  )
}

function FileList({ card, execution }: { card: AgentCard; execution?: ExecutionRun }) {
  if (!card.files.length) return <div className="faint" style={{ fontSize: 12 }}>Keine Dateien</div>
  return (
    <>
      {card.files.map((file) => (
        <button key={file.path} className="file-link mono" title={card.status === 'completed' ? 'Agenten-Version öffnen' : 'Im Code öffnen'} onClick={() => void (card.status === 'completed' ? openChangedFile(execution, file.path) : actions.openFile(file.path))}>
          <span className="truncate" style={{ flex: 1 }}>{file.path}</span>
          {file.added !== null ? <span style={{ color: 'var(--ok)' }}>+{file.added}</span> : <span className="faint">{file.status}</span>}
          {file.deleted ? <span style={{ color: 'var(--err)' }}>−{file.deleted}</span> : null}
        </button>
      ))}
    </>
  )
}

function Inspector({ card, execution, subtasks }: { card: AgentCard; execution?: ExecutionRun; subtasks: Subtask[] }) {
  const subtask = subtasks.find((entry) => entry.id === card.id)
  const hints = subtask?.acceptanceCriteria.filter((entry) => entry.startsWith('Hinweis vom Nutzer: ')) ?? []
  return (
    <div className="inspector">
      <div className="insp-col">
        <div className="row" style={{ gap: 8 }}>
          <KindIcon icon={card.icon} tone={card.tone} size={26} />
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, minWidth: 0 }}>
            <strong className="truncate">{card.key} · {card.agent}</strong>
            <span className="faint truncate" style={{ fontSize: 11.5 }} title={card.goal}>{card.title}</span>
          </div>
        </div>
        <div className="kv-grid">
          <span>Modell</span><span className="mono">{card.model}</span>
          <span>Rolle</span><span title={card.role}>{card.role}</span>
          <span>Worktree</span><span className="mono muted truncate" title={card.worktree}>{card.worktree ? card.worktree.split(/[\\/]/).slice(-3).join('/') : '–'}</span>
          <span>Tokens</span><span className="mono">{card.tokens ? `${(card.tokens / 1000).toFixed(1).replace('.', ',')}k${card.tokensMeasured ? '' : ' (teilw. geschätzt)'}` : '–'}</span>
          <span>Abhängig</span><span>{card.deps.length ? card.deps.join(', ') : '–'}</span>
          {card.wave !== undefined ? <><span>Prognose</span><span>Welle {card.wave + 1}{card.critical ? ' · kritischer Pfad' : ''}</span></> : null}
          {card.attempts > 1 ? <><span>Versuche</span><span style={{ color: 'var(--tool)' }}>{card.attempts}</span></> : null}
        </div>
        {hints.length ? <div className="faint" style={{ fontSize: 11.5 }}>{hints.length} Hinweis(e): {hints.map((entry) => entry.slice(20)).join(' · ')}</div> : null}
        <SubtaskActions card={card} subtask={subtask} execution={execution} />
      </div>
      <div className="insp-log">
        <div className="insp-log-head">
          <Terminal size={13} /> Live-Protokoll
          <span className="spacer" />
          <span className="mono" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, color: TONE[card.statusTone].color }}>{card.statusLabel}</span>
          <button className="hdr-icon tiny" title="Inspektor ausblenden" aria-label="Inspektor ausblenden" onClick={() => actions.setInspectorOpen(false)}>
            <ChevronDown size={14} />
          </button>
        </div>
        <div className="insp-log-body mono" data-testid="agent-log">
          {card.logs.length ? card.logs.map((line, index) => (
            <div key={index} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <span className="faint" style={{ flex: 'none' }}>{new Date(line.at).toLocaleTimeString('de-DE')}</span>
              <span style={{ color: TONE[line.tone].color, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{line.text}</span>
            </div>
          )) : <div className="faint">{card.waitDetail ?? 'Noch keine Ausgabe.'}</div>}
          {subtask?.errorMessage ? <div style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{subtask.errorMessage}</div> : null}
        </div>
      </div>
      <div className="insp-col" style={{ borderLeft: '1px solid var(--line)', borderRight: 'none' }}>
        <Eyebrow>Validierung</Eyebrow>
        <CheckList card={card} />
        <Eyebrow>Dateien</Eyebrow>
        <FileList card={card} execution={execution} />
      </div>
    </div>
  )
}

function ForecastStrip({ forecast }: { forecast: ScheduleForecast }) {
  const vram = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`
  return (
    <div className="forecast">
      <div className="row" style={{ gap: 8 }}>
        <Eyebrow>Ablaufprognose</Eyebrow>
        <span className="faint" style={{ fontSize: 11.5 }}>
          {forecast.waves.length} Welle{forecast.waves.length === 1 ? '' : 'n'} · bis zu {forecast.maxParallel} parallel · {forecast.slots.local} lokale{forecast.slots.local === 1 ? 'r' : ''} Slot{forecast.slots.local === 1 ? '' : 's'} · ≤ {formatClock(forecast.estimatedMs)} Min.{forecast.measuredDurations ? '' : ' (Schätzung ohne Messwerte)'}
        </span>
      </div>
      <div className="forecast-waves">
        {forecast.waves.map((wave) => (
          <div key={wave.index} className="forecast-wave" title={wave.localModels.length ? `Modelle: ${wave.localModels.join(', ')} · ${vram(wave.memoryBytes)}` : undefined}>
            <span className="mono faint" style={{ fontSize: 10.5 }}>W{wave.index + 1}</span>
            {wave.tasks.map((key) => (
              <Chip key={key} tone={forecast.tasks[key]?.critical ? 'accent' : 'muted'} title={forecast.tasks[key]?.detail}>{key}</Chip>
            ))}
            {wave.fitsVram === false ? <Chip tone="tool">CPU-Offload</Chip> : wave.memoryBytes ? <span className="mono faint" style={{ fontSize: 10.5 }}>{vram(wave.memoryBytes)}</span> : null}
          </div>
        ))}
      </div>
      {forecast.warnings.map((warning, index) => (
        <div key={index} style={{ fontSize: 12, color: 'var(--tool)' }}>{warning}</div>
      ))}
    </div>
  )
}

function DraftState() {
  const project = useAppState((state) => state.project)
  const sessionId = useAppState((state) => state.workspace.activeSessionId)
  return (
    <div className="ls-empty">
      <div className="empty-mark">
        <Orbit size={26} />
      </div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{project ? 'Was soll gebaut werden?' : 'Öffne ein Projekt'}</div>
      <div className="muted" style={{ textWrap: 'pretty' }}>
        {project ? 'Beschreibe die Aufgabe im Chat. Der Orchestrator zerlegt sie hier in Teilaufgaben und verteilt sie live auf lokale Modelle und Premium-Agenten.' : 'Öffne einen Projektordner. Git richtet die App selbst ein; die Ergebnisse jedes Laufs landen automatisch im Hauptbranch.'}
      </div>
      {project ? (
        <div className="row wrap" style={{ justifyContent: 'center', gap: 6, marginTop: 4 }}>
          {SUGGESTIONS.map((label) => (
            <button key={label} className="pill-btn" onClick={() => { actions.setComposerDraft(sessionId, { text: label, mode: 'task' }); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#chat-input')?.focus()) }}>
              {label}
            </button>
          ))}
        </div>
      ) : (
        <div style={{ width: 'min(420px, 100%)', textAlign: 'left' }}>
          <ProjectSetup />
        </div>
      )}
    </div>
  )
}

function PlanError({ task }: { task: Task }) {
  return (
    <div className="ls-empty">
      <XCircle size={28} style={{ color: 'var(--err)' }} />
      <div style={{ fontSize: 18, fontWeight: 600 }}>{task.currentStep === 'plan_interrupted' ? 'Die Planung wurde unterbrochen' : 'Die Planung ist fehlgeschlagen'}</div>
      <div className="muted">Details stehen im Chat. „Erneut planen“ startet sie neu – es wird nichts automatisch wiederholt.</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Variant A: flow graph
// ---------------------------------------------------------------------------

function RunGraph(data: Data) {
  const { task, execution, stage, cards, plan, forecast, selected, subtasks } = data
  const inspectorOpen = useAppState((state) => state.ui.inspectorOpen)
  const pre = stage.state === 'draft' || stage.state === 'planning' || stage.state === 'plan_error'
  const pipe = pipelineStates(stage, execution)
  return (
    <>
      <div className="graph-canvas">
        {stage.state === 'draft' ? <DraftState /> : stage.state === 'plan_error' && task ? <PlanError task={task} /> : (
          <div className="graph-row">
            <div className="node orch-node" style={{ borderColor: ['planning', 'running'].includes(stage.state) ? 'var(--accent)' : 'var(--line2)', boxShadow: ['planning', 'running'].includes(stage.state) ? 'var(--glow)' : 'none' }}>
              <div className="row" style={{ gap: 8 }}>
                <div className="kind-icon" style={{ width: 26, height: 26, background: 'var(--accent)', color: 'var(--on-accent)' }}><Sparkles size={14} /></div>
                <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}><strong>Orchestrator</strong><span className="faint" style={{ fontSize: 11 }}>plant, delegiert, prüft</span></div>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>{orchestratorSummary(stage, cards, execution)}</div>
              <OrchestratorUsage execution={execution} />
            </div>
            <span className="edge" />
            <div className="stack" style={{ gap: 12 }}>
              <MidNode icon={Search} label="Repository-Analyse" state={stage.state === 'planning' ? 'running' : 'completed'} sub={plan?.dag?.consideredFiles ? `${plan.dag.consideredFiles} Dateien · ~${((plan.dag.contextTokens ?? 0) / 1000).toFixed(1).replace('.', ',')}k Tokens` : stage.state === 'planning' ? 'liest Repository …' : 'Index und Kontext'} />
              <MidNode icon={Brain} label="Planung" state={pre ? 'running' : 'completed'} sub={pre ? 'Teilaufgaben werden geschnitten …' : plan?.source === 'fast-path' ? 'Fast Path (ohne Premium-Planung)' : `${plan?.source === 'deterministic-fallback' ? 'Fallback-Plan · ' : ''}${cards.length} Teilaufgabe(n) · ${cards.filter((card) => card.kind === 'premium').length} Premium`} />
            </div>
            <span className="edge" />
            <div className="agent-column">
              {stage.state === 'planning' ? [1, 2, 3].map((key) => <div key={key} className="skeleton" style={{ width: 310, height: 92 }} />) : null}
              {!pre ? cards.map((card) => <AgentNode key={card.id} card={card} selected={selected?.id === card.id} />) : null}
            </div>
            <span className="edge" />
            <div className="stack" style={{ gap: 12 }}>
              <EndNode icon={GitMerge} label="Integration" state={pipe.integration} sub={pipe.integration === 'completed' ? localizeEngineText(pipe.validation?.summary) || 'Ergebnisse zusammengeführt' : 'Ergebnisse zusammenführen'} />
              <EndNode icon={ShieldCheck} label="Finaler Review" state={pipe.review} sub={pipe.reviewInfo?.result ? `${pipe.reviewInfo.result.verdict} · ${pipe.reviewInfo.result.score}/100` : pipe.reviewInfo?.kind === 'deterministic' ? 'automatisch geprüft' : 'Premium-Review nach Risiko'} />
              <EndNode icon={GitPullRequestArrow} label="Freigabe" state={pipe.approval} hot={stage.state === 'approval'} sub={stage.state === 'approval' ? 'Klicken zum Prüfen' : stage.state === 'done' ? 'übernommen' : 'wartet auf Ergebnis'} onClick={stage.state === 'approval' ? () => actions.setScreen('review') : undefined} />
            </div>
          </div>
        )}
        {stage.state === 'ready' && forecast?.waves.length ? <ForecastStrip forecast={forecast} /> : null}
      </div>
      {!pre && selected ? (
        inspectorOpen ? <Inspector card={selected} execution={execution} subtasks={subtasks} /> : (
          <button className="insp-reopen" onClick={() => actions.setInspectorOpen(true)}>
            <ChevronUp size={14} /> {selected.key} · Details einblenden
          </button>
        )
      ) : null}
    </>
  )
}

function OrchestratorUsage({ execution }: { execution?: ExecutionRun }) {
  const premium = execution?.usage?.premium
  if (!premium) return null
  return (
    <div className="row mono faint" style={{ gap: 10, fontSize: 10.5 }}>
      <span>{premium.calls} Aufrufe</span>
      <span>{((premium.inputTokens + premium.outputTokens) / 1000).toFixed(1).replace('.', ',')}k Tok.</span>
    </div>
  )
}

function MidNode({ icon: Icon, label, state, sub }: { icon: typeof Search; label: string; state: PipeState; sub: string }) {
  return (
    <div className="node mid-node" style={{ borderColor: state === 'running' ? 'var(--accent)' : 'var(--line)' }}>
      <div className="row" style={{ gap: 7 }}>
        <Icon size={14} className="muted" />
        <span style={{ fontWeight: 500 }}>{label}</span>
        <span className="spacer" />
        <Dot tone={PIPE_TONE[state]} pulse={state === 'running'} />
      </div>
      <div className="faint" style={{ fontSize: 11.5 }}>{sub}</div>
    </div>
  )
}

function EndNode({ icon: Icon, label, state, sub, hot, onClick }: { icon: typeof Search; label: string; state: PipeState; sub: string; hot?: boolean; onClick?: () => void }) {
  return (
    <div className={`node end-node ${onClick ? 'clickable' : ''}`} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onClick={onClick} onKeyDown={(event) => onClick && event.key === 'Enter' && onClick()} style={{ background: hot ? 'var(--accent-soft)' : undefined, borderColor: hot || state === 'running' ? 'var(--accent)' : state === 'failed' ? 'var(--err)' : 'var(--line)', boxShadow: hot ? 'var(--glow)' : 'none' }}>
      <div className="row" style={{ gap: 7 }}>
        <Icon size={14} style={{ color: hot ? 'var(--accent)' : 'var(--muted)' }} />
        <span style={{ fontWeight: 500 }}>{label}</span>
        <span className="spacer" />
        <Dot tone={PIPE_TONE[state]} pulse={state === 'running'} />
      </div>
      <div className="faint truncate" style={{ fontSize: 11.5 }} title={sub}>{sub}</div>
    </div>
  )
}

function AgentNode({ card, selected }: { card: AgentCard; selected: boolean }) {
  return (
    <div
      className={`node agent-node ${selected ? 'selected' : ''}`}
      id={`workflow-subtask-${card.id}`}
      role="button"
      tabIndex={0}
      data-status={card.status}
      onClick={() => { actions.setSelectedSubtask(card.id); actions.setInspectorOpen(true) }}
      onKeyDown={(event) => event.key === 'Enter' && actions.setSelectedSubtask(card.id)}
      style={{ borderColor: selected ? 'var(--accent)' : card.active ? 'var(--line2)' : 'var(--line)' }}
    >
      <span className="stub left" />
      <span className="stub right" />
      <div className="row" style={{ gap: 8 }}>
        <KindIcon icon={card.icon} tone={card.tone} />
        <span style={{ fontWeight: 600 }}>{card.key}</span>
        <span className="mono faint truncate" style={{ flex: 1, fontSize: 11 }} data-testid="subtask-agent" title={card.model}>{card.profile ? `${card.profile} · ` : ''}{card.model}</span>
        <span className="row" style={{ gap: 5, fontSize: 11.5, color: TONE[card.statusTone].color }}>
          <Dot tone={card.statusTone} pulse={card.active} />
          {card.statusLabel}
        </span>
      </div>
      <div className="truncate" style={{ fontSize: 12.5 }} title={card.goal}>{card.title}</div>
      <Bar value={card.progress * 100} tone={card.statusTone} height={3} />
      <div className="mono faint truncate" style={{ fontSize: 10.5 }} title={card.lastLog}>{card.lastLog}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Variant B: live tiles
// ---------------------------------------------------------------------------

function RunTiles(data: Data) {
  const { task, execution, stage, cards, decisions, forecast, selected, elapsedMs } = data
  const pre = stage.state === 'draft' || stage.state === 'planning' || stage.state === 'plan_error'
  const pipe = pipelineStates(stage, execution)
  const done = cards.filter((card) => card.status === 'completed').length
  const usage = execution?.usage
  const localTokens = usage ? usage.local.inputTokens + usage.local.outputTokens : 0
  const allTokens = usage ? localTokens + usage.premium.inputTokens + usage.premium.outputTokens : 0
  const chips: Array<{ label: string; state: PipeState | Subtask['status'] }> = [
    { label: 'Analyse', state: stage.state === 'draft' ? 'pending' : stage.state === 'planning' ? 'running' : 'completed' },
    { label: 'Plan', state: pre ? (stage.state === 'planning' ? 'running' : 'pending') : 'completed' },
    ...cards.map((card) => ({ label: `${card.key} ${card.short}`, state: card.status })),
    { label: 'Integration', state: pipe.integration },
    { label: 'Review', state: pipe.review },
    { label: 'Freigabe', state: pipe.approval },
  ]
  return (
    <>
      <div className="pipeline">
        {chips.map((chip, index) => {
          const tone: Tone = ({ pending: 'faint', running: 'accent', completed: 'ok', failed: 'err', planned: 'muted', queued: 'faint', validating: 'local', repairing: 'tool', skipped: 'faint', cancelled: 'faint', blocked: 'err' } as Record<string, Tone>)[chip.state] ?? 'faint'
          return (
            <Fragment key={chip.label + index}>
              {index ? <ChevronRight size={13} className="faint" /> : null}
              <span className="pipe-chip" style={{ borderColor: ['running', 'validating', 'repairing'].includes(chip.state) ? TONE[tone].color : 'var(--line)', background: chip.state === 'running' ? 'var(--accent-soft)' : 'var(--elev)', color: ['pending', 'queued'].includes(chip.state) ? 'var(--faint)' : 'var(--text)' }}>
                <Dot tone={tone} size={6} />
                {chip.label}
              </span>
            </Fragment>
          )
        })}
      </div>
      <div className="tiles">
        {stage.state === 'draft' ? (
          <div className="tiles-empty">
            <LayoutGrid size={26} style={{ color: 'var(--accent)' }} />
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>Noch keine Agenten aktiv</div>
            <div>Sobald der Plan steht, bekommt jeder Agent hier seine eigene Live-Kachel.</div>
          </div>
        ) : stage.state === 'plan_error' && task ? <div style={{ gridColumn: '1 / -1' }}><PlanError task={task} /></div> : (
          <div className="orch-tile" style={{ borderColor: ['planning', 'running'].includes(stage.state) ? 'var(--accent)' : 'var(--line2)', boxShadow: ['planning', 'running'].includes(stage.state) ? 'var(--glow)' : 'none' }}>
            <div className="stack" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 10 }}>
                <div className="kind-icon" style={{ width: 34, height: 34, borderRadius: 11, background: 'var(--accent)', color: 'var(--on-accent)' }}><Sparkles size={17} /></div>
                <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}><strong style={{ fontSize: 15 }}>Orchestrator</strong><span className="faint" style={{ fontSize: 12 }}>plant, delegiert, prüft</span></div>
              </div>
              <div className="muted">{orchestratorSummary(stage, cards, execution)}</div>
              <div className="row" style={{ gap: 18 }}>
                <div className="stack" style={{ gap: 0 }}><span style={{ fontSize: 20, fontWeight: 600 }}>{done}/{cards.length}</span><span className="faint" style={{ fontSize: 11 }}>Teilaufgaben fertig</span></div>
                <div className="stack" style={{ gap: 0 }}><span style={{ fontSize: 20, fontWeight: 600 }}>{allTokens ? `${Math.round((localTokens / allTokens) * 100)}%` : '–'}</span><span className="faint" style={{ fontSize: 11 }}>Tokens lokal</span></div>
                <div className="stack" style={{ gap: 0 }}><span className="mono" style={{ fontSize: 20, fontWeight: 600 }}>{formatClock(elapsedMs)}</span><span className="faint" style={{ fontSize: 11 }}>Laufzeit</span></div>
              </div>
              {stage.state === 'ready' && forecast?.waves.length ? <ForecastStrip forecast={forecast} /> : null}
            </div>
            <div className="stack" style={{ gap: 6, borderLeft: '1px solid var(--line)', paddingLeft: 16, minWidth: 0 }}>
              <Eyebrow>Entscheidungen</Eyebrow>
              {decisions.length ? decisions.slice(-8).map((decision, index) => (
                <div key={index} className="row" style={{ gap: 10, fontSize: 12.5, alignItems: 'flex-start' }}>
                  <span className="mono faint" style={{ fontSize: 11, paddingTop: 1, flex: 'none', width: 34 }}>{decision.at}</span>
                  <span style={{ textWrap: 'pretty', color: decision.tone === 'err' ? 'var(--err)' : undefined }}>{decision.text}</span>
                </div>
              )) : <div className="faint" style={{ fontSize: 12.5 }}>{stage.state === 'planning' ? 'Repository-Analyse gestartet …' : 'Keine besonderen Entscheidungen – alles läuft nach Plan.'}</div>}
            </div>
          </div>
        )}
        {stage.state === 'planning' ? [1, 2, 3].map((key) => <div key={key} className="skeleton" style={{ height: 220, borderRadius: 16 }} />) : null}
        {!pre ? cards.map((card) => <AgentTile key={card.id} card={card} selected={selected?.id === card.id} execution={execution} subtasks={data.subtasks} />) : null}
      </div>
    </>
  )
}

function AgentTile({ card, selected, execution, subtasks }: { card: AgentCard; selected: boolean; execution?: ExecutionRun; subtasks: Subtask[] }) {
  const tail = (selected ? card.logs.slice(-12) : card.logs.slice(-5))
  return (
    <div className={`agent-tile ${selected ? 'selected' : ''}`} id={`workflow-subtask-${card.id}`} data-status={card.status} style={{ gridColumn: selected ? 'span 2' : 'auto', borderColor: selected ? 'var(--accent)' : card.active ? 'var(--line2)' : 'var(--line)' }} onClick={() => actions.setSelectedSubtask(card.id)}>
      <div className="row" style={{ gap: 8, padding: '11px 14px 8px' }}>
        <KindIcon icon={card.icon} tone={card.tone} size={26} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
          <strong className="truncate">{card.key} · {card.agent}</strong>
          <span className="mono faint truncate" style={{ fontSize: 10.5 }} data-testid="subtask-agent">{card.profile ? `${card.profile} · ` : ''}{card.model}</span>
        </div>
        <StatusPill tone={card.statusTone}>{card.statusLabel}</StatusPill>
      </div>
      <div style={{ padding: '0 14px 8px', fontSize: 13, fontWeight: 500 }} title={card.goal}>{card.title}</div>
      <div className="tile-log mono" style={{ height: selected ? 170 : 96 }}>
        {tail.length ? tail.map((line, index) => <div key={index} className="truncate" style={{ color: TONE[line.tone].color }} title={line.text}>› {line.text}</div>) : <div className="faint">› {card.lastLog}</div>}
      </div>
      {selected ? (
        <div className="tile-detail" onClick={(event) => event.stopPropagation()}>
          <div className="stack" style={{ gap: 8, flex: 1, minWidth: 0 }}>
            <CheckList card={card} />
            <SubtaskActions card={card} subtask={subtasks.find((entry) => entry.id === card.id)} execution={execution} />
          </div>
          <div className="stack" style={{ gap: 4, flex: 1, minWidth: 0 }}>
            <FileList card={card} execution={execution} />
          </div>
        </div>
      ) : null}
      <div className="row" style={{ gap: 10, padding: '10px 14px 12px' }}>
        <div style={{ flex: 1 }}><Bar value={card.progress * 100} tone={card.statusTone} /></div>
        <span className="mono faint" style={{ fontSize: 10.5 }}>{card.tokens ? `${(card.tokens / 1000).toFixed(1).replace('.', ',')}k Tok.` : card.waitDetail ?? '–'}</span>
      </div>
    </div>
  )
}

