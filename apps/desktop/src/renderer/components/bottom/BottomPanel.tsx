import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Columns2, Maximize2, Minimize2, Plus, RotateCcw, X } from 'lucide-react'
import { bridge } from '../../lib/api'
import * as actions from '../../lib/actions'
import { useExecution } from '../../lib/execution'
import { formatDuration, formatTokens } from '../../lib/hooks'
import { shallowEqual } from '../../lib/store/core'
import { useAppState, useLiveState, useSessionState, useTerminalState } from '../../lib/store'
import * as ide from '../../lib/ide'
import { useStore } from '../../lib/store/core'
import { problemsStore, type ProblemEntry } from '../../lib/stores'
import type { BottomTab } from '../../lib/stores'
import type { CheckResult, ReviewSummary, ValidationReport } from '../../lib/types'
import { Badge, DiffText, Empty, StatusDot } from '../common'
import { TerminalView } from './TerminalInstance'
import { VirtualList } from '../VirtualList'
import { WorkflowLink } from '../workflow/WorkflowLink'
import { runStatusLabel } from '../../lib/engine-text'

const TABS: Array<{ id: BottomTab; label: string }> = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'logs', label: 'Logs' },
  { id: 'tests', label: 'Tests' },
  { id: 'diff', label: 'Git-Diff' },
  { id: 'run', label: 'Run-Details' },
  { id: 'problems', label: 'Probleme' },
]

/** `resizer`: drag handle on the top edge (owned by the IDE layout). */
export function BottomPanel({ resizer }: { resizer?: ReactNode }) {
  const { bottomTab, bottomOpen, maximized } = useAppState((state) => ({ bottomTab: state.ui.bottomTab, bottomOpen: state.ui.bottomOpen, maximized: state.ui.bottomMaximized }), shallowEqual)
  return (
    <div className="bottom-panel" data-testid="bottom-panel">
      {resizer}
      <div className="bottom-tabs" onDoubleClick={(event) => {
        if (!(event.target as HTMLElement).closest('button, input, .badge')) actions.toggleBottomMaximized()
      }}>
        <div className="bottom-tab-list">
          {TABS.map((tab) => (
            <button key={tab.id} className={`tab-btn ${bottomTab === tab.id ? 'active' : ''}`} onClick={() => actions.setBottomTab(tab.id)}>
              {tab.label}
            </button>
          ))}
          <span className="spacer" />
        </div>
        <button className="icon-btn" title={maximized ? 'Panel wiederherstellen' : 'Panel maximieren'} aria-label={maximized ? 'Panel wiederherstellen' : 'Panel maximieren'} onClick={() => actions.toggleBottomMaximized()}>
          {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button className="icon-btn" title="Panel ausblenden (Terminals laufen weiter)" onClick={() => actions.setBottomOpen(false)}>
          <ChevronDown size={15} />
        </button>
      </div>
      {bottomTab === 'terminal' ? <div className="terminal-tabs"><TerminalTabs /></div> : null}
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
  const splitId = useAppState((state) => state.workspace.splitTerminalId)
  const [renaming, setRenaming] = useState<string>()
  const [title, setTitle] = useState('')
  const rename = async (id: string) => {
    setRenaming(undefined)
    if (title.trim()) await bridge().terminal.rename(id, title.trim()).catch(() => false)
    await actions.refreshTerminals()
  }
  const toggleSplit = async () => {
    if (splitId) {
      actions.updateWorkspace({ splitTerminalId: undefined })
      return
    }
    // second pane: another running terminal of the project, or a new one
    const other = terminals.find((terminal) => terminal.id !== activeId && terminal.status === 'running')
    const created = other ?? (await actions.createTerminal({ title: 'Terminal 2' }))
    // createTerminal makes the new terminal active; keep the previous one in the main pane
    if (created) actions.updateWorkspace({ activeTerminalId: activeId ?? created.id, splitTerminalId: created.id === activeId ? undefined : created.id })
  }
  return (
    <>
      <div className="terminal-tab-list">
      {terminals.map((terminal) =>
        renaming === terminal.id ? (
          <input
            key={terminal.id}
            className="input"
            style={{ width: 140, height: 22 }}
            autoFocus
            value={title}
            aria-label="Terminal umbenennen"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void rename(terminal.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename(terminal.id)
              if (event.key === 'Escape') setRenaming(undefined)
            }}
          />
        ) : (
        <span key={terminal.id} className={`badge ${terminal.id === activeId || terminal.id === splitId ? 'accent' : ''}`} style={{ cursor: 'pointer' }} onDoubleClick={() => { setTitle(terminal.title); setRenaming(terminal.id) }} title={`${terminal.cwd ?? ''}${terminal.status !== 'running' ? ` · ${terminal.status === 'restored' ? 'Verlauf der letzten Sitzung' : 'beendet'}` : ''}`} onClick={() => actions.updateWorkspace({ activeTerminalId: terminal.id })}>
          <StatusDot status={terminal.status === 'running' ? 'ok' : terminal.status === 'restored' ? 'skipped' : 'warn'} />
          {terminal.title}
          <X size={11} aria-label={`${terminal.title} schließen`} onClick={(event) => { event.stopPropagation(); void actions.closeTerminal(terminal.id) }} />
        </span>
        ),
      )}
      </div>
      <button className="icon-btn" title="Neues Terminal" aria-label="Neues Terminal" onClick={() => void actions.createTerminal()}>
        <Plus size={15} />
      </button>
      <button className={`icon-btn ${splitId ? 'active' : ''}`} title={splitId ? 'Teilung aufheben' : 'Terminal teilen'} aria-label="Terminal teilen" onClick={() => void toggleSplit()}>
        <Columns2 size={14} />
      </button>
    </>
  )
}

/** Terminal views are mounted on first display and kept (hidden) afterwards. */
function Terminals({ visible }: { visible: boolean }) {
  const terminals = useProjectTerminals()
  const activeId = useAppState((state) => state.workspace.activeTerminalId)
  const storedSplit = useAppState((state) => state.workspace.splitTerminalId)
  // the split pane only shows an existing terminal other than the active one
  const splitId = storedSplit && storedSplit !== activeId && terminals.some((terminal) => terminal.id === storedSplit) ? storedSplit : undefined
  const [shown, setShown] = useState<string[]>([])
  useEffect(() => {
    const wanted = [activeId, splitId].filter((id): id is string => Boolean(id) && !shown.includes(id!))
    if (visible && wanted.length) setShown((current) => [...current, ...wanted])
  }, [visible, activeId, splitId, shown])
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
      <div className={splitId ? 'terminal-split' : ''} style={{ flex: 1, minHeight: 0, display: 'flex' }} data-testid="terminals">
        {!terminals.length ? <Empty>Kein Terminal geöffnet.</Empty> : null}
        {terminals
          .filter((terminal) => shown.includes(terminal.id))
          .sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId))
          .map((terminal) => (
            <TerminalView key={terminal.id} terminalId={terminal.id} visible={visible && (terminal.id === activeId || terminal.id === splitId)} />
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


function LogsView() {
  const { events, execution, selectedSubtaskId } = useSessionState((state) => ({ events: state.events, execution: state.execution, selectedSubtaskId: state.selectedSubtaskId }), shallowEqual)
  const live = useLiveState((state) => (state.executionId === execution?.id ? state.lines : undefined))
  const [showDebug, setShowDebug] = useState(false)

  const lines = useMemo(() => {
    const persisted = events.map((event) => ({ ts: event.createdAt, level: event.level, type: event.type, message: event.message, subtaskId: event.subtaskId ?? undefined }))
    const lastPersisted = persisted.at(-1)?.ts ?? ''
    const merged = [...persisted, ...(live ?? []).filter((line) => line.ts > lastPersisted || line.type === 'check_output' || line.type === 'tool_call')]
    return merged.filter((line) => (showDebug || line.level !== 'debug') && (!selectedSubtaskId || !line.subtaskId || line.subtaskId === selectedSubtaskId))
  }, [events, live, showDebug, selectedSubtaskId])
  if (!execution) return <Empty>Keine Ausführung ausgewählt.</Empty>
  // every line stays reachable; only the visible window is rendered (10,000+ lines)
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="row" style={{ padding: '4px 10px', background: 'var(--bg-panel)' }}>
        <label className="row muted" style={{ gap: 4, fontSize: 12 }}>
          <input type="checkbox" checked={showDebug} onChange={(event) => setShowDebug(event.target.checked)} /> Tool-Aufrufe & Testausgaben
        </label>
        {selectedSubtaskId ? <span className="faint">gefiltert auf ausgewählte Teilaufgabe</span> : null}
        <span className="faint">{lines.length} Zeilen</span>
      </div>
      <VirtualList items={lines} estimate={19} followTail testId="log-lines" itemKey={(_line, index) => index} render={(line) => <LogLine ts={line.ts} level={line.level} message={line.message} />} />
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
      <div className="row"><strong>Laufdetails</strong><span className="spacer" /><WorkflowLink /></div>
      <div className="kv">
        <span>Status</span>
        <span>{runStatusLabel(execution.status)}</span>
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
  const { files, project } = useStore(problemsStore, (state) => state, shallowEqual)
  const projectId = useAppState((state) => state.project?.id)
  const [filter, setFilter] = useState<'all' | 'error'>('all')
  useEffect(() => {
    if (projectId) void ide.loadProjectProblems().catch(() => undefined)
  }, [projectId])

  const run: Array<{ level: 'error' | 'warn'; source: string; message: string }> = []
  for (const subtask of execution?.task?.subtasks ?? task?.subtasks ?? []) {
    if (subtask.errorMessage) run.push({ level: 'error', source: subtask.key, message: subtask.errorMessage })
    for (const warning of subtask.patchStats?.warnings ?? []) run.push({ level: 'warn', source: subtask.key, message: `${warning.code}: ${warning.message}${warning.file ? ` (${warning.file})` : ''}` })
  }
  const review = execution?.review as ReviewSummary | undefined
  for (const issue of review?.deterministicIssues ?? []) run.push({ level: issue.startsWith('blocking') ? 'error' : 'warn', source: 'Prüfung', message: issue })
  for (const issue of review?.result?.issues ?? []) run.push({ level: issue.severity === 'blocker' ? 'error' : 'warn', source: `Review ${issue.file}`, message: issue.message })

  // live diagnostics of open files win over the (older) project check for the same file
  const live = Object.values(files).flat()
  const liveFiles = new Set(Object.keys(files))
  const all: ProblemEntry[] = [...live, ...(project?.problems ?? []).filter((problem) => !(problem.source === 'tsc' && liveFiles.has(problem.path)))]
  const shown = all.filter((problem) => filter === 'all' || problem.severity === 'error')
  const byFile = new Map<string, ProblemEntry[]>()
  for (const problem of shown) byFile.set(problem.path, [...(byFile.get(problem.path) ?? []), problem])

  return (
    <div style={{ padding: '4px 8px' }} data-testid="problems-view">
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <button className="btn small" disabled={!projectId || project?.running} onClick={() => void ide.checkProject()}>
          {project?.running ? 'Prüfung läuft …' : 'Projekt prüfen (tsc + ESLint)'}
        </button>
        <select className="select" style={{ width: 150 }} value={filter} onChange={(event) => setFilter(event.target.value as 'all' | 'error')}>
          <option value="all">Fehler und Warnungen</option>
          <option value="error">Nur Fehler</option>
        </select>
        <span className="faint">
          {project?.at && !project.running ? `Letzte Prüfung ${new Date(project.at).toLocaleTimeString('de-DE')} (${(project.durationMs / 1000).toFixed(1)} s${project.tools.length ? `, ${project.tools.join(' + ')}` : ', keine Werkzeuge im Projekt'})` : 'Offene Dateien werden live geprüft.'}
        </span>
      </div>
      {[...byFile].map(([file, problems]) => (
        <div key={file || '(projekt)'}>
          <div className="search-file">
            {file || 'Projekt'} <span className="faint">{problems.length}</span>
          </div>
          {problems.map((problem, index) => (
            <div key={index} className="row"><button className={`search-hit log-line ${problem.severity === 'error' ? 'error' : 'warn'}`} onClick={() => file && void ide.openFileAt(file, { line: problem.line, column: problem.column })}>
              {problem.severity === 'error' ? '⊗' : '⚠'} {problem.message} <span className="faint">{problem.code ? `${problem.source} ${problem.code}` : problem.source} [{problem.line}, {problem.column}]</span>
            </button><button className="btn small" onClick={() => ide.taskFromProblem({ ...problem, path: file })}>Task erstellen</button></div>
          ))}
        </div>
      ))}
      {run.length ? <div className="search-file">Aktuelle Ausführung</div> : null}
      {run.map((problem, index) => (
        <div key={index} className={`log-line ${problem.level}`}>
          [{problem.source}] {problem.message}
        </div>
      ))}
      {!shown.length && !run.length ? <Empty>Keine Probleme.</Empty> : null}
    </div>
  )
}
