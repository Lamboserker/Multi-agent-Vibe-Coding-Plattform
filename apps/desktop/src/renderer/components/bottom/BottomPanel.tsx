import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Plus, RotateCcw, X } from 'lucide-react'
import * as actions from '../../lib/actions'
import { useExecution } from '../../lib/execution'
import { formatDuration, formatTokens } from '../../lib/hooks'
import { shallowEqual } from '../../lib/store/core'
import { useAppState, useLiveState, useSessionState, useTerminalState } from '../../lib/store'
import type { BottomTab } from '../../lib/stores'
import type { CheckResult, ReviewSummary, ValidationReport } from '../../lib/types'
import { Badge, DiffText, Empty, StatusDot } from '../common'
import { TerminalView } from './TerminalInstance'

const TABS: Array<{ id: BottomTab; label: string }> = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'logs', label: 'Logs' },
  { id: 'tests', label: 'Tests' },
  { id: 'diff', label: 'Git-Diff' },
  { id: 'run', label: 'Run-Details' },
  { id: 'problems', label: 'Probleme' },
]

export function BottomPanel() {
  const { bottomTab, bottomOpen } = useAppState((state) => ({ bottomTab: state.ui.bottomTab, bottomOpen: state.ui.bottomOpen }), shallowEqual)
  return (
    <div className="bottom-panel" data-testid="bottom-panel">
      <div className="bottom-tabs">
        {TABS.map((tab) => (
          <button key={tab.id} className={`tab-btn ${bottomTab === tab.id ? 'active' : ''}`} onClick={() => actions.setBottomTab(tab.id)}>
            {tab.label}
          </button>
        ))}
        <span className="spacer" />
        {bottomTab === 'terminal' ? <TerminalTabs /> : null}
        <button className="icon-btn" title="Panel ausblenden (Terminals laufen weiter)" onClick={() => actions.setBottomOpen(false)}>
          <ChevronDown size={15} />
        </button>
      </div>
      <div className="bottom-body">
        <Terminals visible={bottomOpen && bottomTab === 'terminal'} />
        {bottomTab === 'logs' ? <LogsView /> : null}
        {bottomTab === 'tests' ? <TestsView /> : null}
        {bottomTab === 'diff' ? <DiffView /> : null}
        {bottomTab === 'run' ? <RunDetails /> : null}
        {bottomTab === 'problems' ? <ProblemsView /> : null}
      </div>
    </div>
  )
}

function useProjectTerminals() {
  const projectId = useAppState((state) => state.project?.id)
  const list = useTerminalState((state) => state.list)
  return useMemo(() => list.filter((terminal) => !projectId || !terminal.projectId || terminal.projectId === projectId), [list, projectId])
}

function TerminalTabs() {
  const terminals = useProjectTerminals()
  const activeId = useAppState((state) => state.workspace.activeTerminalId)
  return (
    <>
      {terminals.map((terminal) => (
        <span key={terminal.id} className={`badge ${terminal.id === activeId ? 'accent' : ''}`} style={{ cursor: 'pointer' }} title={`${terminal.cwd ?? ''}${terminal.status !== 'running' ? ` · ${terminal.status === 'restored' ? 'Verlauf der letzten Sitzung' : 'beendet'}` : ''}`} onClick={() => actions.updateWorkspace({ activeTerminalId: terminal.id })}>
          <StatusDot status={terminal.status === 'running' ? 'ok' : terminal.status === 'restored' ? 'skipped' : 'warn'} />
          {terminal.title}
          <X size={11} aria-label={`${terminal.title} schließen`} onClick={(event) => { event.stopPropagation(); void actions.closeTerminal(terminal.id) }} />
        </span>
      ))}
      <button className="icon-btn" title="Neues Terminal" aria-label="Neues Terminal" onClick={() => void actions.createTerminal()}>
        <Plus size={15} />
      </button>
    </>
  )
}

/** Terminal views are mounted on first display and kept (hidden) afterwards. */
function Terminals({ visible }: { visible: boolean }) {
  const terminals = useProjectTerminals()
  const activeId = useAppState((state) => state.workspace.activeTerminalId)
  const [shown, setShown] = useState<string[]>([])
  useEffect(() => {
    if (visible && activeId && !shown.includes(activeId)) setShown((current) => [...current, activeId])
  }, [visible, activeId, shown])
  const active = terminals.find((terminal) => terminal.id === activeId)
  return (
    <div style={{ height: '100%', display: visible ? 'flex' : 'none', flexDirection: 'column' }}>
      {active && active.status !== 'running' ? (
        <div className="terminal-history-bar">
          {active.status === 'restored' ? 'Verlauf aus der letzten App-Sitzung – der Prozess wurde beim Beenden der App beendet.' : `Prozess beendet${active.exitCode !== undefined ? ` (Code ${active.exitCode})` : ''}.`}
          <span className="spacer" />
          <button className="btn small" onClick={() => void actions.createTerminal({ replaces: active.id, title: active.title })}>
            <RotateCcw size={12} /> Neu starten
          </button>
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0 }}>
        {!terminals.length ? <Empty>Kein Terminal geöffnet.</Empty> : null}
        {terminals
          .filter((terminal) => shown.includes(terminal.id))
          .map((terminal) => (
            <TerminalView key={terminal.id} terminalId={terminal.id} visible={visible && terminal.id === activeId} />
          ))}
      </div>
    </div>
  )
}

/** Starts a terminal in the bottom panel that runs a specific (allowlisted) command. */
export function runInTerminal(command: string[], title: string) {
  void actions.runInTerminal(command, title)
}

const LogLine = memo(function LogLine({ ts, level, message }: { ts: string; level: string; message: string }) {
  return (
    <div className={`log-line ${level}`}>
      <span className="faint">{new Date(ts).toLocaleTimeString()}</span> {message}
    </div>
  )
})

const MAX_RENDERED_LOG_LINES = 1500

function LogsView() {
  const { events, execution, selectedSubtaskId } = useSessionState((state) => ({ events: state.events, execution: state.execution, selectedSubtaskId: state.selectedSubtaskId }), shallowEqual)
  const live = useLiveState((state) => (state.executionId === execution?.id ? state.lines : undefined))
  const [showDebug, setShowDebug] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => {
    const persisted = events.map((event) => ({ ts: event.createdAt, level: event.level, type: event.type, message: event.message, subtaskId: event.subtaskId ?? undefined }))
    const lastPersisted = persisted.at(-1)?.ts ?? ''
    const merged = [...persisted, ...(live ?? []).filter((line) => line.ts > lastPersisted || line.type === 'check_output' || line.type === 'tool_call')]
    return merged.filter((line) => (showDebug || line.level !== 'debug') && (!selectedSubtaskId || !line.subtaskId || line.subtaskId === selectedSubtaskId))
  }, [events, live, showDebug, selectedSubtaskId])
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [lines.length])
  if (!execution) return <Empty>Keine Ausführung ausgewählt.</Empty>
  const hidden = Math.max(0, lines.length - MAX_RENDERED_LOG_LINES)
  return (
    <div>
      <div className="row" style={{ padding: '4px 10px', position: 'sticky', top: 0, background: 'var(--bg-panel)' }}>
        <label className="row muted" style={{ gap: 4, fontSize: 12 }}>
          <input type="checkbox" checked={showDebug} onChange={(event) => setShowDebug(event.target.checked)} /> Tool-Aufrufe & Testausgaben
        </label>
        {selectedSubtaskId ? <span className="faint">gefiltert auf ausgewählte Teilaufgabe</span> : null}
        {hidden ? <span className="faint">{hidden} ältere Zeilen ausgeblendet</span> : null}
      </div>
      {lines.slice(hidden).map((line, index) => (
        <LogLine key={hidden + index} ts={line.ts} level={line.level} message={line.message} />
      ))}
      <div ref={end} />
    </div>
  )
}

function CheckRows({ results }: { results: CheckResult[] }) {
  return (
    <>
      {results.map((result, index) => (
        <details key={index} style={{ padding: '2px 10px' }}>
          <summary className="row" style={{ display: 'flex' }}>
            <StatusDot status={result.status === 'passed' ? 'completed' : result.status === 'skipped' ? 'skipped' : 'failed'} />
            <span>{result.kind}</span>
            <code className="faint">{result.command}</code>
            <span className="spacer" />
            {result.testsPassed !== undefined ? <span>{result.testsPassed} ✓ {result.testsFailed ? `${result.testsFailed} ✗` : ''}</span> : null}
            {result.errorCount ? <span className="error-text">{result.errorCount} Fehler</span> : null}
            <span className="faint">{formatDuration(result.durationMs)}</span>
          </summary>
          {result.reason ? <div className="callout warn">{result.reason}</div> : null}
          {result.output ? <pre className="pre">{result.output}</pre> : null}
        </details>
      ))}
    </>
  )
}

function TestsView() {
  const { execution, task } = useExecution()
  if (!execution) return <Empty>Keine Ausführung ausgewählt.</Empty>
  const final = execution.finalValidation as ValidationReport
  const subtasks = execution.task?.subtasks ?? task?.subtasks ?? []
  return (
    <div style={{ padding: '6px 0' }}>
      <div className="section-title" style={{ padding: '4px 10px' }}>Gesamtvalidierung (Integrations-Worktree)</div>
      {final?.results ? <CheckRows results={final.results} /> : <div className="faint" style={{ padding: '0 10px' }}>Noch nicht ausgeführt.</div>}
      {subtasks.map((subtask) => {
        const validation = subtask.validation as ValidationReport
        if (!validation?.results) return null
        return (
          <div key={subtask.id}>
            <div className="section-title" style={{ padding: '8px 10px 2px' }}>{subtask.key} · {subtask.title}</div>
            <CheckRows results={validation.results} />
          </div>
        )
      })}
    </div>
  )
}

function DiffView() {
  const { execution } = useExecution()
  if (!execution?.finalDiff) return <Empty>Noch kein integrierter Diff vorhanden.</Empty>
  return (
    <div style={{ padding: 8 }}>
      <DiffText diff={execution.finalDiff} />
    </div>
  )
}

function RunDetails() {
  const { execution } = useExecution()
  if (!execution) return <Empty>Keine Ausführung ausgewählt.</Empty>
  const calls = execution.modelCalls ?? []
  const usage = execution.usage
  return (
    <div style={{ padding: 10 }} className="stack">
      <div className="kv">
        <span>Status</span>
        <span>{execution.status}</span>
        <span>Basis-Commit</span>
        <span className="mono">{execution.baseCommit?.slice(0, 10) ?? '–'}</span>
        <span>Integrations-Branch</span>
        <span className="mono">{execution.integrationBranch ?? '–'}</span>
        <span>Kostenmodus</span>
        <span>{execution.costMode}</span>
        {usage ? (
          <>
            <span>Premium-Aufrufe</span>
            <span>
              {usage.premium.calls} · {formatTokens(usage.premium.inputTokens)} in / {formatTokens(usage.premium.outputTokens)} out (gemessen)
            </span>
            <span>Lokale Aufrufe</span>
            <span>
              {usage.local.calls} · {formatTokens(usage.local.inputTokens)} in / {formatTokens(usage.local.outputTokens)} out · {formatDuration(usage.local.durationMs)}
            </span>
          </>
        ) : null}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Art</th>
            <th>Modell</th>
            <th>Zweck</th>
            <th>Status</th>
            <th>Tokens (in/out)</th>
            <th>Dauer</th>
            <th>API-Äquivalent</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call) => (
            <tr key={call.id}>
              <td>
                <Badge kind={call.kind === 'local' ? 'local' : 'premium'}>{call.kind === 'local' ? 'lokal' : 'premium'}</Badge>
              </td>
              <td className="mono">{call.model}</td>
              <td>{call.purpose}</td>
              <td>{call.status}{call.errorClass ? ` (${call.errorClass})` : ''}</td>
              <td>
                {formatTokens(call.inputTokens)} / {formatTokens(call.outputTokens)} {call.tokensMeasured ? '' : <span className="faint">(nicht gemessen)</span>}
              </td>
              <td>{formatDuration(call.durationMs)}</td>
              <td>{call.apiEquivalentUsd ? `$${Number(call.apiEquivalentUsd).toFixed(4)} (gemeldet, nicht berechnet)` : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ProblemsView() {
  const { execution, task } = useExecution()
  const problems: Array<{ level: 'error' | 'warn'; source: string; message: string }> = []
  for (const subtask of execution?.task?.subtasks ?? task?.subtasks ?? []) {
    if (subtask.errorMessage) problems.push({ level: 'error', source: subtask.key, message: subtask.errorMessage })
    for (const warning of subtask.patchStats?.warnings ?? []) problems.push({ level: 'warn', source: subtask.key, message: `${warning.code}: ${warning.message}${warning.file ? ` (${warning.file})` : ''}` })
  }
  const review = execution?.review as ReviewSummary | undefined
  for (const issue of review?.deterministicIssues ?? []) problems.push({ level: issue.startsWith('blocking') ? 'error' : 'warn', source: 'Prüfung', message: issue })
  for (const issue of review?.result?.issues ?? []) problems.push({ level: issue.severity === 'blocker' ? 'error' : 'warn', source: `Review ${issue.file}`, message: issue.message })
  if (!problems.length) return <Empty>Keine Probleme.</Empty>
  return (
    <div style={{ padding: '4px 0' }}>
      {problems.map((problem, index) => (
        <div key={index} className={`log-line ${problem.level}`}>
          [{problem.source}] {problem.message}
        </div>
      ))}
    </div>
  )
}
