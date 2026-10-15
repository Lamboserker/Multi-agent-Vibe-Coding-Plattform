import { useState } from 'react'
import { Bot, Brain, GitMerge, Search, ShieldCheck, Sparkles } from 'lucide-react'
import * as actions from '../../lib/actions'
import { useExecution } from '../../lib/execution'
import { formatTokens } from '../../lib/hooks'
import { useApp } from '../../lib/store'
import type { ExecutionRun, ReviewSummary, Subtask, ValidationReport } from '../../lib/types'
import { Badge, Empty, PanelHeader, StatusDot } from '../common'
import { WorkflowLink } from '../workflow/WorkflowLink'
import { AgentProfilesView, useAgentProfiles } from '../agents/AgentProfiles'
import { SUBTASK_STATUS as STATUS_DE } from '../../lib/workflow'
import { localizeEngineText } from '../../lib/engine-text'

export function AgentsPanel() {
  const [tab, setTab] = useState<'run' | 'profiles'>('run')
  const tabs = (
    <div className="row" style={{ gap: 6, padding: '6px 12px 0' }}>
      <button className={`btn small ${tab === 'run' ? 'primary' : ''}`} onClick={() => setTab('run')}>
        Aktueller Lauf
      </button>
      <button className={`btn small ${tab === 'profiles' ? 'primary' : ''}`} onClick={() => setTab('profiles')}>
        Agenten verwalten
      </button>
    </div>
  )
  if (tab === 'profiles') {
    return (
      <>
        <PanelHeader title="Agenten" />
        {tabs}
        <div className="panel-body">
          <AgentProfilesView />
        </div>
      </>
    )
  }
  return <RunView tabs={tabs} />
}

function RunView({ tabs }: { tabs: React.ReactNode }) {
  const { execution, task } = useExecution()
  const { settings } = useApp()
  const orchestratorName = settings?.orchestrator === 'codex' ? 'Codex' : settings?.orchestrator === 'claude-code' ? 'Claude Code' : 'Kein Orchestrator'

  if (!task) {
    return (
      <>
        <PanelHeader title="Agenten" />
        {tabs}
        <Empty>Wähle eine Aufgabe oder starte eine neue im Chat.</Empty>
      </>
    )
  }
  const plan = task.plans?.[0]
  const subtasks = execution?.task?.subtasks ?? task.subtasks
  return (
    <>
      <PanelHeader title="Agenten"><WorkflowLink /></PanelHeader>
      {tabs}
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
            <AgentNode key={subtask.id} subtask={subtask} />
          ))}
          {execution ? <IntegrationNode execution={execution} /> : null}
        </div>
        {execution?.status === 'awaiting_approval' ? <div className="callout" style={{ marginTop: 12 }}>Die Änderungen sind bereit. Prüfe und übernimm sie im Arbeitsablauf.</div> : null}
        {execution?.errorMessage && execution.status !== 'awaiting_approval' ? <div className="callout error" style={{ marginTop: 10 }}>{execution.errorMessage}</div> : null}
      </div>
    </>
  )
}

function AgentNode({ subtask }: { subtask: Subtask }) {
  const agentName = useAgentProfiles().data?.find((agent) => agent.id === subtask.agentId)?.name
  const premium = subtask.selectedModelClass === 'premium_llm'
  return (
    <button className="agent-row agent-summary" onClick={() => {
      actions.setSelectedSubtask(subtask.id)
      void actions.openWorkflow()
    }} title="Teilaufgabe im Arbeitsablauf öffnen">
      <Bot size={14} color={premium ? 'var(--premium)' : 'var(--local)'} />
      <span className="agent-summary-text">
        <span data-testid="subtask-agent">{subtask.fastPath ? 'Werkzeug' : agentName ?? (premium ? 'Premium-Agent' : 'Lokaler Agent')}</span>
        <span className="muted">{subtask.key} · {subtask.title}</span>
      </span>
      <StatusDot status={subtask.status} />
      <span className="faint">{STATUS_DE[subtask.status] ?? subtask.status}</span>
    </button>
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
      {validation?.summary ? <div className="agent-meta">{localizeEngineText(validation.summary)}</div> : null}
      <div className="agent-row">
        <ShieldCheck size={14} className="faint" />
        <span>Finaler Review</span>
        {review?.kind ? <Badge kind={review.kind === 'premium' ? 'premium' : review.kind === 'human_required' ? 'warn' : undefined}>{review.kind === 'premium' ? 'Premium' : review.kind === 'deterministic' ? 'automatisch' : 'manuell nötig'}</Badge> : null}
        <span className="spacer" />
        {review?.result ? <Badge kind={review.result.verdict === 'approve' ? 'ok' : 'warn'}>{review.result.verdict} {review.result.score}/100</Badge> : review?.kind ? <StatusDot status="completed" /> : <StatusDot status="pending" />}
      </div>
      {review?.reason ? <div className="agent-meta">{localizeEngineText(review.reason)}</div> : null}
    </>
  )
}
