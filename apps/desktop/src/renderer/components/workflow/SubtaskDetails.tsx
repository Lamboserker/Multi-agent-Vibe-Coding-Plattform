import { useEffect, useState } from 'react'
import { Bot } from 'lucide-react'
import { api, errorMessage } from '../../lib/api'
import { useExecution } from '../../lib/execution'
import { formatDuration, formatTokens, since, useLoader } from '../../lib/hooks'
import { useApp } from '../../lib/store'
import type { AgentRun, ExecutionRun, InstalledModel, Subtask, ValidationReport } from '../../lib/types'
import { AsyncButton, Badge, StatusDot } from '../common'
import { AgentSwitcher, useAgentProfiles } from '../agents/AgentProfiles'
import { SUBTASK_STATUS } from '../../lib/workflow'

export function SubtaskDetails({ subtask, runs, execution }: { subtask: Subtask; runs: AgentRun[]; execution?: ExecutionRun }) {
  const { selectedSubtaskId, setSelectedSubtaskId, reloadTask } = useExecution()
  const agentName = useAgentProfiles().data?.find((agent) => agent.id === subtask.agentId)?.name
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
    <div id={`workflow-subtask-${subtask.id}`}>
      <div className={`agent-row ${selected ? 'selected' : ''}`} onClick={() => setSelectedSubtaskId(selected ? undefined : subtask.id)}>
        <Bot size={14} color={premium ? 'var(--premium)' : 'var(--local)'} />
        <span className="truncate" style={{ maxWidth: 170 }} data-testid="subtask-agent">{subtask.fastPath ? 'Werkzeug' : agentName ?? (premium ? 'Premium-Agent' : 'Lokaler Agent')}</span>
        <Badge kind={premium ? 'premium' : 'local'}>{subtask.fastPath ? 'ohne Modell' : subtask.selectedModelName ?? (premium ? 'premium' : 'nicht zugewiesen')}</Badge>
        <span className="spacer" />
        <StatusDot status={subtask.status} />
      </div>
      <div className="agent-node" style={{ marginLeft: 16 }}>
        <div className="agent-row" onClick={() => setSelectedSubtaskId(selected ? undefined : subtask.id)}>
          <span className="faint mono">{subtask.key}</span>
          <span className="truncate">{subtask.title}</span>
          <span className="spacer" />
          <span className="faint">{SUBTASK_STATUS[subtask.status] ?? subtask.status}</span>
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
            <AgentSwitcher subtaskId={subtask.id} agentId={subtask.agentId} disabled={!['planned', 'queued'].includes(subtask.status)} onChanged={() => void reloadTask()} />
            {!subtask.fastPath ? <ModelSwitcher subtask={subtask} disabled={!['planned', 'queued', 'failed', 'cancelled', 'skipped', 'blocked'].includes(subtask.status)} onChanged={() => void reloadTask()} /> : null}
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

