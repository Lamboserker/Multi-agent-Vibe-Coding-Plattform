import { useEffect, useState } from 'react'
import { ChevronsUpDown, Code, Cpu, FolderGit2, Gauge, GitBranch, GitPullRequestArrow, ListChecks, MessagesSquare, Moon, Orbit, PiggyBank, Plus, Radar, Search, Sparkles, Sun, Thermometer, TriangleAlert, X, Zap, type LucideIcon } from 'lucide-react'
import * as actions from '../../lib/actions'
import { useRuntimeStatus } from '../../lib/hooks'
import { tokenShare, stageInfo, type Tone } from '../../lib/leitstand'
import { loadTone, pct, resourceMetrics, useResourceMonitor } from '../../lib/resources'
import { shallowEqual, useStore } from '../../lib/store/core'
import { useAppState, useSessionState } from '../../lib/store'
import { dialogStore, problemsStore, type Screen } from '../../lib/stores'
import type { ApprovalMode, SessionSummary } from '../../lib/types'
import { workflowState } from '../../lib/workflow'
import { Spinner } from '../common'
import { ProjectsPanel } from '../panels/ProjectsPanel'
import { Bar, Dot, Seg, Spark } from '../ui'

const SESSION_TONE: Record<string, Tone> = { running: 'accent', paused: 'tool', interrupted: 'err', failed: 'err', completed: 'ok', active: 'muted', idle: 'faint', archived: 'faint' }

export function sessionTone(session: Pick<SessionSummary, 'status'>): Tone {
  return SESSION_TONE[session.status] ?? 'faint'
}

const fmtTokens = (value: number) => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1).replace('.', ',')}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value))

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function Header() {
  const { project, theme, orchestrator } = useAppState((state) => ({ project: state.project, theme: state.ui.theme, orchestrator: state.settings?.orchestrator }), shallowEqual)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [hwOpen, setHwOpen] = useState(false)
  return (
    <header className="app-header">
      <div className="brand-cell">
        <div className="brand-mark" title="Multi-AI Coder">
          <Orbit size={18} strokeWidth={2.2} />
        </div>
      </div>
      <div style={{ position: 'relative', flex: 'none' }}>
        <button className="hdr-btn project-btn" onClick={() => setProjectsOpen((open) => !open)} title={project?.repoPath ?? 'Projekt öffnen'} aria-label="Projekt wählen">
          <FolderGit2 size={15} className="muted" />
          <span className="project-name">{project?.name ?? 'Kein Projekt'}</span>
          {project?.defaultBranch ? (
            <span className="mono small muted row" style={{ gap: 4 }}>
              <GitBranch size={12} />
              {project.defaultBranch}
            </span>
          ) : null}
          <ChevronsUpDown size={13} className="faint" />
        </button>
        {projectsOpen ? (
          <>
            <div className="popover-scrim" onClick={() => setProjectsOpen(false)} />
            <div className="popover project-popover" onClick={(event) => (event.target as HTMLElement).closest('.tree-item, .project-item, button.btn.primary') && window.setTimeout(() => setProjectsOpen(false), 150)}>
              <ProjectsPanel />
            </div>
          </>
        ) : null}
      </div>
      <SessionTabs />
      <button className="hdr-btn palette-btn" onClick={() => dialogStore.set({ dialog: { kind: 'quick-open', mode: 'commands' } })} aria-label="Befehlspalette">
        <Search size={14} />
        <span className="truncate" style={{ flex: 1, textAlign: 'left' }}>Befehl oder Datei …</span>
        <kbd>Strg K</kbd>
      </button>
      <div style={{ position: 'relative', flex: 'none' }}>
        <HardwareChip open={hwOpen} onToggle={() => setHwOpen((open) => !open)} />
        {hwOpen ? <HardwarePopover onClose={() => setHwOpen(false)} /> : null}
      </div>
      <TokenMeter orchestrator={orchestrator === 'codex' ? 'Codex' : orchestrator === 'claude-code' ? 'Claude Code' : 'kein Orchestrator'} />
      <button className="hdr-icon" title={theme === 'dark' ? 'Helles Design' : 'Dunkles Design'} aria-label="Design wechseln" onClick={() => actions.setTheme(theme === 'dark' ? 'light' : 'dark')}>
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </header>
  )
}

function SessionTabs() {
  const { list, activeId } = useSessionState((state) => ({ list: state.list, activeId: state.active?.id }), shallowEqual)
  const { sessionId, closed } = useAppState((state) => ({ sessionId: state.workspace.activeSessionId, closed: state.workspace.closedSessionTabs }), shallowEqual)
  const { task, execution } = useSessionState((state) => ({ task: state.task, execution: state.execution }), shallowEqual)
  const active = list.find((entry) => entry.id === sessionId)
  const others = list.filter((entry) => entry.id !== sessionId && !entry.archivedAt && !closed?.includes(entry.id)).slice(0, active ? 2 : 3)
  const tabs = [...(active ? [active] : []), ...others]
  const subtasks = execution?.task?.subtasks ?? task?.subtasks ?? []
  const done = subtasks.filter((entry) => entry.status === 'completed').length
  const stage = stageInfo(task, execution)
  const open = (id: string) => {
    void actions.selectSession(id)
    actions.setScreen('leitstand')
  }
  return (
    <div className="session-strip">
      {!sessionId ? (
        <button className="session-tab on" onClick={() => actions.setScreen('leitstand')}>
          <Dot tone="muted" />
          <span className="truncate">Neue Sitzung</span>
        </button>
      ) : null}
      {tabs.map((session) => {
        const on = session.id === sessionId
        const meta = on && activeId === session.id && (stage.state === 'running' || stage.state === 'paused') ? `${done}/${subtasks.length}` : on && stage.state === 'approval' ? 'Freigabe' : ''
        return (
          <div
            key={session.id}
            role="button"
            tabIndex={0}
            data-testid="session-tab"
            className={`session-tab ${on ? 'on' : ''}`}
            title={session.title}
            onClick={() => open(session.id)}
            onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && (event.preventDefault(), open(session.id))}
            onAuxClick={(event) => event.button === 1 && void actions.closeSessionTab(session.id)}
          >
            <Dot tone={on ? stage.tone : sessionTone(session)} pulse={on && stage.state === 'running'} />
            <span className="truncate">{session.title || 'Sitzung'}</span>
            {meta ? <span className="mono faint" style={{ fontSize: 11 }}>{meta}</span> : null}
            <button
              className="session-close"
              title="Tab schließen (die Sitzung bleibt unter „Sitzungen“)"
              aria-label={`${session.title || 'Sitzung'} schließen`}
              onClick={(event) => {
                event.stopPropagation()
                void actions.closeSessionTab(session.id)
              }}
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
      <button className="session-new" title="Neue Sitzung" aria-label="Neue Sitzung" onClick={() => actions.newSession()}>
        <Plus size={15} />
      </button>
    </div>
  )
}

function HardwareChip({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const snapshot = useResourceMonitor(3000)
  const gpuPct = snapshot?.gpu?.utilizationPct
  const vramPct = pct(snapshot?.gpu?.vramUsedMb, snapshot?.gpu?.vramTotalMb)
  const chips = [
    { label: 'GPU', value: gpuPct, tone: loadTone(gpuPct) },
    { label: 'VRAM', value: vramPct, tone: loadTone(vramPct) },
  ]
  const warn = snapshot?.warnings.some((warning) => warning.severity !== 'info')
  return (
    <button className={`hdr-btn hw-chip ${open ? 'open' : ''}`} onClick={onToggle} title="Hardwareauslastung" aria-label="Hardwareauslastung" aria-expanded={open}>
      <Gauge size={15} style={{ color: warn ? 'var(--tool)' : chips[0]!.tone }} />
      {chips.map((chip) => (
        <div key={chip.label} className="hw-mini">
          <div className="hw-mini-label">
            <span>{chip.label}</span>
            <span style={{ color: chip.tone }}>{chip.value === undefined ? '–' : `${chip.value}%`}</span>
          </div>
          <Bar value={chip.value} tone={chip.tone} />
        </div>
      ))}
    </button>
  )
}

function TokenMeter({ orchestrator }: { orchestrator: string }) {
  const execution = useSessionState((state) => state.execution)
  const { localPct, total } = tokenShare(execution)
  return (
    <div className="token-meter" title="Token-Anteil des aktuellen Laufs: lokal vs. Premium-Orchestrator (gemessen)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, width: 120 }}>
        <div className="split-bar">
          <div style={{ width: `${total ? localPct : 0}%`, background: 'var(--local)' }} />
          <div style={{ width: `${total ? 100 - localPct : 0}%`, background: 'var(--accent)' }} />
        </div>
        <div className="hw-mini-label">
          <span>lokal {total ? `${localPct}%` : '–'}</span>
          <span>{total ? `${fmtTokens(total)} Tok.` : 'kein Lauf'}</span>
        </div>
      </div>
      <span className="row muted" style={{ gap: 5, fontSize: 12, whiteSpace: 'nowrap' }}>
        <Sparkles size={13} style={{ color: 'var(--accent)' }} />
        {orchestrator}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Resource monitor popover
// ---------------------------------------------------------------------------

export function HardwarePopover({ onClose }: { onClose: () => void }) {
  const snapshot = useResourceMonitor(1500)
  const selfTests = useAppState((state) => state.settings?.modelSelfTests)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="popover-scrim" onClick={onClose} />
      <div className="popover hw-popover" role="dialog" aria-label="Hardwareauslastung">
        <div className="hw-head">
          <Gauge size={17} style={{ color: 'var(--local)' }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0 }}>
            <strong style={{ fontSize: 14 }}>Hardwareauslastung</strong>
            <span className="faint truncate" style={{ fontSize: 11.5 }}>
              {snapshot ? [snapshot.gpu?.name.replace(/^NVIDIA (GeForce )?/, ''), snapshot.cpu.model.replace(/\s+\d+-Core Processor/i, ''), `${Math.round(snapshot.ram.totalBytes / 1024 ** 3)} GB`].filter(Boolean).join(' · ') : 'wird gemessen …'}
            </span>
          </div>
          <span className="row faint" style={{ gap: 6, fontSize: 11 }}>
            <Dot tone={snapshot ? 'ok' : 'faint'} pulse={Boolean(snapshot)} />
            live · 1,5 s
          </span>
        </div>
        {!snapshot ? (
          <div className="row" style={{ padding: 16 }}>
            <Spinner /> Messung läuft …
          </div>
        ) : (
          <>
            <div className="hw-metrics">
              {resourceMetrics(snapshot).map((metric) => (
                <div key={metric.id} className="hw-metric">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span className="faint" style={{ fontSize: 11.5 }}>{metric.label}</span>
                    <span style={{ fontSize: 17, fontWeight: 600, color: metric.tone }}>{metric.pct === undefined ? '–' : `${metric.pct}%`}</span>
                  </div>
                  <Spark values={metric.bars} tone={metric.tone} />
                  <div className="mono muted" style={{ fontSize: 11, textAlign: 'right', lineHeight: 1.4 }}>
                    {metric.value}
                    <br />
                    <span className="faint">{metric.sub}</span>
                  </div>
                </div>
              ))}
            </div>
            {snapshot.warnings.filter((warning) => warning.code !== 'cpu_high').map((warning, index) => (
              <div key={index} className={`hw-warn ${warning.severity}`}>
                <TriangleAlert size={14} />
                <span>{warning.message}</span>
              </div>
            ))}
            {snapshot.waiting.map((entry) => (
              <div key={entry.key} className="hw-warn info">
                <TriangleAlert size={14} />
                <span>
                  <strong>{entry.key}</strong>
                  {entry.model ? ` (${entry.model})` : ''} {entry.reason}.
                </span>
              </div>
            ))}
            <div className="hw-section">
              <div className="row">
                <span className="eyebrow">Geladene Modelle</span>
                <span className="spacer" />
                <span className="faint" style={{ fontSize: 11.5 }}>
                  {snapshot.slots.busyLocal} von {snapshot.slots.local} lokalen Slot{snapshot.slots.local === 1 ? '' : 's'} belegt
                </span>
              </div>
              {!snapshot.ollama.reachable ? <div className="muted" style={{ fontSize: 12.5 }}>Ollama ist nicht erreichbar.</div> : !snapshot.models.length ? <div className="muted" style={{ fontSize: 12.5 }}>Kein Modell geladen. Ollama lädt Modelle beim nächsten Agentenstart.</div> : null}
              {snapshot.models.map((model) => {
                const gpu = Math.round(model.gpuShare * 100)
                const tps = selfTests?.[model.name]?.tokensPerSecond
                return (
                  <div key={model.name} className="hw-model">
                    <div className="row" style={{ gap: 8 }}>
                      <span className="mono truncate" style={{ fontSize: 12, flex: 1 }}>{model.name}</span>
                      {model.agents.length ? <span className="chip mono" style={{ background: 'var(--local-soft)', color: 'var(--local)' }}>{model.agents.join(', ')}</span> : <span className="faint" style={{ fontSize: 11 }}>bereit</span>}
                      {tps ? <span className="mono muted" style={{ fontSize: 11 }} title="aus dem Selbsttest, bei voller GPU-Nutzung">~{Math.round(tps * (0.4 + 0.6 * model.gpuShare))} Tok./s</span> : null}
                    </div>
                    <div className="split-bar">
                      <div style={{ width: `${gpu}%`, background: 'var(--local)' }} />
                      <div style={{ width: `${100 - gpu}%`, background: 'var(--tool)' }} />
                    </div>
                    <div className="row faint" style={{ fontSize: 11, justifyContent: 'space-between' }}>
                      <span>
                        {(model.sizeBytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB · {gpu >= 98 ? '100 % GPU' : `${gpu} % GPU / ${100 - gpu} % CPU`}
                      </span>
                      <span>{model.contextLength ? `Kontext ${Math.round(model.contextLength / 1024)}k` : ''}</span>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="hw-foot mono">
              {snapshot.gpu?.temperatureC !== undefined ? (
                <span className="row" style={{ gap: 5 }}>
                  <Thermometer size={12} />
                  {snapshot.gpu.temperatureC} °C
                </span>
              ) : null}
              {snapshot.gpu?.powerW !== undefined ? (
                <span className="row" style={{ gap: 5 }}>
                  <Zap size={12} />
                  {Math.round(snapshot.gpu.powerW)} W{snapshot.gpu.powerLimitW ? ` / ${Math.round(snapshot.gpu.powerLimitW)} W` : ''}
                </span>
              ) : null}
              <span className="faint" style={{ fontFamily: 'var(--sans)' }}>{snapshot.gpu?.source === 'nvidia-smi' ? 'Quelle: nvidia-smi' : snapshot.gpu?.source === 'ollama' ? 'Quelle: Ollama' : ''}</span>
              <span className="spacer" />
              <button className="link-btn" onClick={() => { onClose(); actions.setScreen('models') }}>
                Modelle verwalten
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Navigation rail
// ---------------------------------------------------------------------------

interface NavEntry {
  id: Screen
  label: string
  icon: LucideIcon
}

const NAV_TOP: NavEntry[] = [
  { id: 'leitstand', label: 'Leitstand', icon: Radar },
  { id: 'code', label: 'Code', icon: Code },
  { id: 'review', label: 'Freigabe', icon: GitPullRequestArrow },
  { id: 'sessions', label: 'Sitzungen', icon: MessagesSquare },
]
const NAV_BOTTOM: NavEntry[] = [
  { id: 'models', label: 'Modelle', icon: Cpu },
  { id: 'usage', label: 'Kosten', icon: PiggyBank },
  { id: 'setup', label: 'Setup', icon: ListChecks },
]

export function NavRail() {
  const screen = useAppState((state) => state.ui.screen)
  const { task, execution } = useSessionState((state) => ({ task: state.task, execution: state.execution }), shallowEqual)
  const running = useAppState((state) => state.activity.executions.length + state.activity.plans.length)
  const state = workflowState(task, execution).state
  const changed = new Set((execution?.task?.subtasks ?? task?.subtasks ?? []).filter((entry) => entry.status === 'completed').flatMap((entry) => entry.patchStats?.files?.map((file) => file.path) ?? [])).size
  const approvalFiles = state === 'approval' ? [...(execution?.finalDiff ?? '').matchAll(/^diff --git /gm)].length : 0
  const badge: Partial<Record<Screen, string>> = {
    code: changed && state !== 'done' ? String(changed) : '',
    review: approvalFiles ? String(approvalFiles) : '',
  }
  const button = (entry: NavEntry, small?: boolean) => (
    <button key={entry.id} className={`nav-btn ${small ? 'small' : ''} ${screen === entry.id ? 'on' : ''}`} aria-label={entry.label} aria-current={screen === entry.id ? 'page' : undefined} onClick={() => actions.setScreen(entry.id)}>
      <entry.icon size={small ? 17 : 19} />
      <span>{entry.label}</span>
      {badge[entry.id] ? <span className="nav-badge">{badge[entry.id]}</span> : null}
      {entry.id === 'leitstand' && running && screen !== 'leitstand' ? <span className="nav-live" /> : null}
    </button>
  )
  return (
    <nav className="nav-rail" aria-label="Navigation">
      {NAV_TOP.map((entry) => button(entry))}
      <span className="spacer" />
      {NAV_BOTTOM.map((entry) => button(entry, true))}
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Footer (status bar)
// ---------------------------------------------------------------------------

export function Footer() {
  const runtime = useRuntimeStatus()
  const { settings, screen, variant, projectId } = useAppState((state) => ({ settings: state.settings, screen: state.ui.screen, variant: state.ui.leitstandVariant, projectId: state.project?.id }), shallowEqual)
  const activity = useAppState((state) => state.activity)
  const { task, execution } = useSessionState((state) => ({ task: state.task, execution: state.execution }), shallowEqual)
  const snapshot = useResourceMonitor(3000)
  const counts = useStore(problemsStore, (state) => {
    const all = [...Object.values(state.files).flat(), ...(state.project?.problems ?? [])]
    return `${all.filter((problem) => problem.severity === 'error').length}/${all.filter((problem) => problem.severity === 'warning').length}`
  })
  const [errors, warnings] = counts.split('/')
  const current = workflowState(task, execution)
  const subtasks = execution?.task?.subtasks ?? task?.subtasks ?? []
  const done = subtasks.filter((entry) => entry.status === 'completed').length
  const gpuPct = snapshot?.gpu?.utilizationPct
  const vram = snapshot?.gpu?.vramUsedMb !== undefined ? `${(snapshot.gpu.vramUsedMb / 1024).toFixed(1).replace('.', ',')} GB` : '–'
  const first = activity.executions.find((entry) => entry.projectId === projectId) ?? activity.plans.find((entry) => entry.projectId === projectId)
  const background = activity.executions.length + activity.plans.length + activity.asks.length
  return (
    <footer className="app-footer status-bar">
      <span className="row" style={{ gap: 5 }}>
        <Dot tone={!runtime || runtime.state === 'ready' ? 'ok' : runtime.state === 'failed' ? 'err' : 'tool'} />
        {!runtime || runtime.state === 'ready' ? 'Laufzeit bereit' : runtime.state === 'failed' ? 'Laufzeit ausgefallen' : 'Laufzeit startet …'}
      </span>
      <span>Modus: {settings?.costMode ?? '–'}</span>
      <label className="foot-select" title="Was nach einem erfolgreichen Lauf mit dem Ergebnis passiert">
        Freigabe:
        <select aria-label="Freigabemodus" value={settings?.approvalMode ?? 'manual'} onChange={(event) => void actions.updateSettings({ approvalMode: event.target.value as ApprovalMode })}>
          <option value="manual">manuell prüfen</option>
          <option value="auto_commit">automatisch auf main committen</option>
          <option value="auto_working_tree">automatisch in die Arbeitskopie</option>
          <option value="auto_branch">automatisch als Branch</option>
        </select>
      </label>
      <span className="spacer" />
      {screen === 'leitstand' ? <Seg size="sm" label="Darstellung" value={variant} onChange={actions.setLeitstandVariant} options={[{ id: 'graph', label: 'Graph' }, { id: 'tiles', label: 'Kacheln' }]} /> : null}
      <button className="foot-btn" title="Probleme anzeigen" onClick={() => { actions.setScreen('code'); actions.setBottomOpen(true); actions.setBottomTab('problems') }}>
        ⊗ {errors} ⚠ {warnings}
      </button>
      <span className="mono" style={{ fontSize: 11 }} title={snapshot?.gpu?.name}>
        <Dot tone={loadTone(gpuPct)} /> GPU {gpuPct === undefined ? '–' : `${gpuPct}%`} · VRAM {vram}
      </span>
      <button
        className="foot-btn activity-indicator"
        data-testid="workflow-entry"
        title={['Arbeitsablauf öffnen (Strg+Umschalt+L)', ...activity.executions.map((entry) => `▶ ${entry.title} (${entry.status})`), ...activity.plans.map((entry) => `◔ Plan: ${entry.title}`)].join('\n')}
        onClick={() => void actions.openWorkflow(task ? undefined : first?.sessionId ?? undefined)}
      >
        {background ? <Dot tone="accent" pulse /> : null}{' '}
        {task ? (current.state === 'running' ? `${done} von ${subtasks.length} Teilaufgaben` : stageInfo(task, execution).label) : background ? `${background} Vorgang/Vorgänge aktiv` : 'Arbeitsablauf'}
      </button>
    </footer>
  )
}
