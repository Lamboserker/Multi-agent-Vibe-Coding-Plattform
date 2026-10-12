import { useEffect, useState } from 'react'
import { Ban, Bot, Brain, CirclePause, CirclePlay, GitMerge, RotateCcw, Search, ShieldCheck, Sparkles } from 'lucide-react'
import { api, errorMessage } from '../../lib/api'
import { useExecution } from '../../lib/execution'
import { formatDuration, formatTokens, since, useLoader } from '../../lib/hooks'
import { loadActivity } from '../../lib/actions'
import { useApp } from '../../lib/store'
import type { AgentRun, ExecutionRun, InstalledModel, ReviewSummary, Subtask, ValidationReport } from '../../lib/types'
import { AsyncButton, Badge, Empty, PanelHeader, StatusDot } from '../common'
import { ApprovalBox } from '../chat/ApprovalBox'

const STATUS_DE: Record<string, string> = {
  planned: 'geplant', queued: 'wartet', running: 'läuft', validating: 'validiert', repairing: 'repariert', completed: 'fertig', failed: 'fehlgeschlagen',
  skipped: 'übersprungen', cancelled: 'abgebrochen', blocked: 'blockiert', pending: 'wartet', integrating: 'integriert', awaiting_approval: 'Freigabe nötig',
  applied: 'übernommen', interrupted: 'unterbrochen', paused: 'pausiert',
}

export function AgentsPanel() {
  const { execution, task, reloadExecution } = useExecution()
  const { settings } = useApp()
  const orchestratorName = settings?.orchestrator === 'codex' ? 'Codex' : settings?.orchestrator === 'claude-code' ? 'Claude Code' : 'Kein Orchestrator'

  if (!task) {
    return (
      <>
        <PanelHeader title="Agenten" />
        <Empty>Wähle eine Aufgabe oder starte eine neue im Chat.</Empty>
      </>
    )
  }
  const plan = task.plans?.[0]
  const subtasks = execution?.task?.subtasks ?? task.subtasks
  return (
    <>
      <PanelHeader title="Agenten">{execution ? <RunControls execution={execution} onChange={() => void reloadExecution()} /> : null}</PanelHeader>
      <div className="panel-body agent-tree">
        <div className="agent-row" style={{ fontWeight: 600 }}>
          <Sparkles size={15} color="var(--premium)" />
          <span>{orchestratorName} — Orchestrator</span>
          <span className="spacer" />
          {execution ? <><StatusDot status={execution.status} /><span className="faint">{STATUS_DE[execution.status] ?? execution.status}</span></> : <span className="faint">{task.currentStep}</span>}
        </div>
        <div className="agent-node">
          <div className="agent-row">
            <Search size={14} className="faint" />
            <span>Repository-Analyse</span>
            <span className="spacer" />
            {plan ? <StatusDot status="completed" /> : task.currentStep === 'planning' ? <StatusDot status="running" /> : <StatusDot status="pending" />}
          </div>
          {plan?.dag?.contextTokens ? <div className="agent-meta">{plan.dag.consideredFiles} Dateien bewertet · Kontext ~{formatTokens(plan.dag.contextTokens)} Tokens (deterministisch)</div> : null}
          <div className="agent-row">
            <Brain size={14} className="faint" />
            <span>Planung</span>
            {plan ? <Badge kind={plan.source === 'deterministic-fallback' ? 'warn' : 'premium'}>{plan.source === 'deterministic-fallback' ? 'Fallback' : plan.source}</Badge> : null}
            <span className="spacer" />
            {plan ? <StatusDot status="completed" /> : task.currentStep === 'planning' ? <StatusDot status="running" /> : task.currentStep === 'plan_failed' ? <StatusDot status="failed" /> : <StatusDot status="pending" />}
          </div>
          {subtasks.map((subtask) => (
            <SubtaskNode key={subtask.id} subtask={subtask} runs={(execution?.agentRuns ?? []).filter((run) => run.subtaskId === subtask.id)} execution={execution} />
          ))}
          {execution ? <IntegrationNode execution={execution} /> : null}
        </div>
        {execution?.status === 'awaiting_approval' ? (
          <div style={{ marginTop: 12 }}>
            <ApprovalBox execution={execution} />
          </div>
        ) : null}
        {execution?.errorMessage && execution.status !== 'awaiting_approval' ? <div className="callout error" style={{ marginTop: 10 }}>{execution.errorMessage}</div> : null}
      </div>
    </>
  )
}

function RunControls({ execution, onChange }: { execution: ExecutionRun; onChange: () => void }) {
  const { notify } = useApp()
  const act = async (path: string) => {
    try {
      await api.post(`/executions/${execution.id}/${path}`)
      onChange()
      void loadActivity()
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }
  const active = ['pending', 'running', 'integrating', 'paused'].includes(execution.status)
  return (
    <>
      {execution.status === 'running' ? (
        <button className="icon-btn" title="Pausieren (laufende Agenten beenden ihre Aufgabe)" onClick={() => void act('pause')}>
          <CirclePause size={16} />
        </button>
      ) : null}
      {execution.status === 'paused' ? (
        <button className="icon-btn" title="Fortsetzen" onClick={() => void act('resume')}>
          <CirclePlay size={16} />
        </button>
      ) : null}
      {['interrupted', 'failed'].includes(execution.status) && execution.integrationBranch ? (
        <button className="icon-btn" title="Unterbrochene Ausführung fortsetzen" onClick={() => void act('continue')}>
          <RotateCcw size={15} />
        </button>
      ) : null}
      {active ? (
        <button className="icon-btn" title="Abbrechen" onClick={() => void act('cancel')}>
          <Ban size={15} />
        </button>
      ) : null}
    </>
  )
}

function SubtaskNode({ subtask, runs, execution }: { subtask: Subtask; runs: AgentRun[]; execution?: ExecutionRun }) {
  const { selectedSubtaskId, setSelectedSubtaskId, reloadTask } = useExecution()
  const { openDiff, notify } = useApp()
  const selected = selectedSubtaskId === subtask.id
  const premium = subtask.selectedModelClass === 'premium_llm'
  const tokens = runs.reduce((sum, run) => sum + (run.inputTokens ?? 0) + (run.outputTokens ?? 0), 0)
  const duration = since(subtask.startedAt, subtask.finishedAt)
  const validation = subtask.validation as ValidationReport
  const files = subtask.patchStats?.files ?? []
  const lastRun = runs.at(-1)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!['running', 'validating', 'repairing'].includes(subtask.status)) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [subtask.status])
  void now

  return (
    <div>
      <div className={`agent-row ${selected ? 'selected' : ''}`} onClick={() => setSelectedSubtaskId(selected ? undefined : subtask.id)}>
        <Bot size={14} color={premium ? 'var(--premium)' : 'var(--local)'} />
        <span className="truncate" style={{ maxWidth: 170 }}>{premium ? 'Premium-Agent' : `Lokaler Agent`}</span>
        <Badge kind={premium ? 'premium' : 'local'}>{subtask.selectedModelName ?? (premium ? 'premium' : 'nicht zugewiesen')}</Badge>
        <span className="spacer" />
        <StatusDot status={subtask.status} />
      </div>
      <div className="agent-node" style={{ marginLeft: 16 }}>
        <div className="agent-row" onClick={() => setSelectedSubtaskId(selected ? undefined : subtask.id)}>
          <span className="faint mono">{subtask.key}</span>
          <span className="truncate">{subtask.title}</span>
          <span className="spacer" />
          <span className="faint">{STATUS_DE[subtask.status] ?? subtask.status}</span>
        </div>
        <div className="agent-meta">
          <span>K{subtask.complexityScore}/R{subtask.riskScore}</span>
          <span>{subtask.category}</span>
          {duration !== undefined ? <span>{formatDuration(duration)}</span> : null}
          {tokens ? <span>{formatTokens(tokens)} Tokens{runs.some((run) => !run.tokensMeasured) ? ' (teilw. geschätzt)' : ''}</span> : null}
          {subtask.attempts > 1 ? <span className="warn-text">{subtask.attempts} Versuche</span> : null}
          {files.length ? <span>{files.length} Datei(en)</span> : null}
          {validation?.results ? <span className={validation.ok ? 'ok-text' : 'error-text'}>Tests {validation.testsPassed}✓ {validation.testsFailed ? `${validation.testsFailed}✗` : ''}</span> : null}
          {subtask.dependsOn.length ? <span>nach {subtask.dependsOn.join(', ')}</span> : null}
        </div>
        {selected ? (
          <div className="card stack" style={{ margin: '4px 0 8px' }}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{subtask.goal}</div>
            {subtask.acceptanceCriteria.length ? (
              <div>
                <div className="section-title">Akzeptanzkriterien</div>
                <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{subtask.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
              </div>
            ) : null}
            {subtask.modelReason ? (
              <details>
                <summary className="muted">Routing-Begründung</summary>
                <pre className="pre">{subtask.modelReason}</pre>
              </details>
            ) : null}
            {subtask.errorMessage ? <div className="callout error" style={{ whiteSpace: 'pre-wrap' }}>{subtask.errorMessage}</div> : null}
            {runs.length ? (
              <div>
                <div className="section-title">Versuche</div>
                {runs.map((run) => (
                  <div key={run.id} className="row" style={{ fontSize: 12, padding: '2px 0' }}>
                    <StatusDot status={run.outcome === 'success' ? 'completed' : run.outcome ? 'failed' : 'running'} />
                    <span>{run.selectedModelName}</span>
                    <span className="faint">{run.repairRound ? `Reparatur ${run.repairRound}` : 'Erstversuch'}</span>
                    <span className="faint">{run.outcome ?? run.status}</span>
                    <span className="spacer" />
                    <span className="faint">{formatDuration(run.durationMs)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <ModelSwitcher subtask={subtask} disabled={['running', 'validating', 'repairing'].includes(subtask.status)} onChanged={() => void reloadTask()} />
            <div className="row wrap">
              {subtask.patchText || lastRun?.patchText ? (
                <button className="btn small" onClick={() => openDiff({ title: `Patch ${subtask.key}`, path: `${subtask.key}.diff`, original: '', modified: subtask.patchText ?? lastRun?.patchText ?? '', source: subtask.patchText ? { type: 'subtask-patch', taskId: subtask.taskId, subtaskId: subtask.id } : undefined })}>
                  Patch ansehen
                </button>
              ) : null}
              {['failed', 'cancelled', 'skipped', 'blocked'].includes(subtask.status) ? (
                <AsyncButton className="btn small" onClick={async () => { await api.post(`/subtasks/${subtask.id}/retry`); notify('Teilaufgabe wird erneut ausgeführt.', 'info') }}>
                  Wiederholen
                </AsyncButton>
              ) : null}
              {['running', 'validating', 'repairing', 'queued'].includes(subtask.status) && execution ? (
                <AsyncButton className="btn small danger" onClick={() => api.post(`/subtasks/${subtask.id}/cancel`)}>
                  Abbrechen
                </AsyncButton>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ModelSwitcher({ subtask, disabled, onChanged }: { subtask: Subtask; disabled: boolean; onChanged: () => void }) {
  const { data: models } = useLoader(() => api.get<InstalledModel[]>('/local-models/installed').catch(() => []), [])
  const { notify } = useApp()
  return (
    <div className="row">
      <span className="muted" style={{ whiteSpace: 'nowrap' }}>Modell:</span>
      <select
        className="select"
        disabled={disabled}
        value={subtask.manualModel ?? ''}
        onChange={async (event) => {
          try {
            await api.post(`/subtasks/${subtask.id}/model`, { model: event.target.value || null })
            onChanged()
          } catch (error) {
            notify(errorMessage(error), 'error')
          }
        }}
      >
        <option value="">Automatisch (Router)</option>
        <option value="premium">Premium-Orchestrator</option>
        {models?.map((model) => (
          <option key={model.name} value={model.name}>
            {model.name}
          </option>
        ))}
      </select>
    </div>
  )
}

function IntegrationNode({ execution }: { execution: ExecutionRun }) {
  const review = execution.review as ReviewSummary
  const validation = execution.finalValidation as ValidationReport
  const done = ['awaiting_approval', 'applied', 'completed'].includes(execution.status)
  return (
    <>
      <div className="agent-row">
        <GitMerge size={14} className="faint" />
        <span>Integration & Validierung</span>
        <span className="spacer" />
        <StatusDot status={execution.status === 'integrating' ? 'running' : done ? (validation?.ok === false ? 'failed' : 'completed') : execution.status === 'failed' ? 'failed' : 'pending'} />
      </div>
      {validation?.summary ? <div className="agent-meta">{validation.summary}</div> : null}
      <div className="agent-row">
        <ShieldCheck size={14} className="faint" />
        <span>Finaler Review</span>
        {review?.kind ? <Badge kind={review.kind === 'premium' ? 'premium' : review.kind === 'human_required' ? 'warn' : undefined}>{review.kind === 'premium' ? 'Premium' : review.kind === 'deterministic' ? 'automatisch' : 'manuell nötig'}</Badge> : null}
        <span className="spacer" />
        {review?.result ? <Badge kind={review.result.verdict === 'approve' ? 'ok' : 'warn'}>{review.result.verdict} {review.result.score}/100</Badge> : review?.kind ? <StatusDot status="completed" /> : <StatusDot status="pending" />}
      </div>
      {review?.reason ? <div className="agent-meta">{review.reason}</div> : null}
    </>
  )
}
