import { useEffect } from 'react'
import * as actions from '../../lib/actions'
import { useExecution } from '../../lib/execution'
import { useLiveState } from '../../lib/store'
import { SUBTASK_STATUS, workflowState } from '../../lib/workflow'
import { Spinner, StatusDot } from '../common'

/** Executions whose diff was opened automatically once (closing the tab is respected). */
const autoOpened = new Set<string>()

/**
 * Shown in the otherwise empty editor while a task is active: what the agents are doing right now,
 * in the largest area of the window. Read-only – lifecycle and approval controls stay in the workflow.
 * When the result is ready for approval its diff opens here automatically (once per execution).
 */
export function RunOverview() {
  const { task, execution: selected } = useExecution()
  const execution = selected?.taskId === task?.id ? selected : undefined
  const lines = useLiveState((state) => (execution && state.executionId === execution.id ? state.lines.slice(-8) : []), (a, b) => a.length === b.length && a.at(-1) === b.at(-1))
  const current = workflowState(task, execution)

  useEffect(() => {
    if (!execution || execution.status !== 'awaiting_approval' || !execution.finalDiff || autoOpened.has(execution.id)) return
    autoOpened.add(execution.id)
    actions.openDiff({ title: 'Gesamt-Diff', path: 'changes.diff', original: '', modified: execution.finalDiff, source: { type: 'execution', executionId: execution.id } })
  }, [execution?.id, execution?.status, execution?.finalDiff])

  if (!task || current.state === 'draft') return null
  const subtasks = execution?.task?.subtasks ?? task.subtasks
  const busy = current.state === 'planning' || current.state === 'running'
  return (
    <div className="run-overview" data-testid="run-overview">
      <div className="row run-overview-head">
        {busy ? <Spinner /> : <StatusDot status={current.state === 'done' ? 'ok' : current.state === 'recoverable' || current.state === 'cancelled' || current.state === 'plan_error' ? 'failed' : 'warn'} />}
        <strong>{current.label}</strong>
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => void actions.openWorkflow()}>
          Zum Arbeitsablauf
        </button>
      </div>
      <div className="run-overview-goal">{task.userPrompt}</div>
      {subtasks.length ? (
        <ol className="run-overview-tasks">
          {subtasks.map((subtask) => (
            <li key={subtask.id} data-status={subtask.status}>
              <span className="run-overview-status">{SUBTASK_STATUS[subtask.status] ?? subtask.status}</span>
              <span className="run-overview-title">{subtask.title}</span>
              <span className="faint">{subtask.selectedModelClass === 'premium_llm' ? 'Premium' : subtask.selectedModelName ?? ''}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {lines.length ? (
        <pre className="run-overview-log" aria-label="Letzte Agentenaktivität">
          {lines.map((line) => line.message.replace(/\s+/g, ' ').slice(0, 220)).join('\n')}
        </pre>
      ) : null}
    </div>
  )
}
