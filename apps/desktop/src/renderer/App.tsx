import { useEffect, useState, type ReactNode } from 'react'
import { Bot, Boxes, Cpu, FolderGit2, FolderOpen, GitBranch, MessagesSquare, Moon, PiggyBank, Settings as SettingsIcon, Sun } from 'lucide-react'
import * as actions from './lib/actions'
import { bridge } from './lib/api'
import { useRuntimeStatus, VisibilityContext } from './lib/hooks'
import { shallowEqual } from './lib/store/core'
import { useAppState, useSessionState } from './lib/store'
import type { SideView } from './lib/stores'
import { Spinner, StatusDot, Toasts } from './components/common'
import { Onboarding } from './components/onboarding/Onboarding'
import { ProjectsPanel } from './components/panels/ProjectsPanel'
import { ExplorerPanel } from './components/panels/ExplorerPanel'
import { GitPanel } from './components/panels/GitPanel'
import { TasksPanel } from './components/panels/TasksPanel'
import { AgentsPanel } from './components/panels/AgentsPanel'
import { ModelsPanel } from './components/panels/ModelsPanel'
import { UsagePanel } from './components/panels/UsagePanel'
import { SettingsPanel } from './components/panels/SettingsPanel'
import { EditorArea } from './components/editor/EditorArea'
import { BottomPanel } from './components/bottom/BottomPanel'
import { ChatPanel } from './components/chat/ChatPanel'

export function App() {
  const booted = useAppState((state) => state.booted)
  const onboardingDone = useAppState((state) => state.settings?.onboarding.completed)
  const hasSettings = useAppState((state) => Boolean(state.settings))

  if (!window.mac) return <div className="splash">Diese Oberfläche läuft nur in der Multi-AI-Coder-Desktop-App.</div>
  // The splash is only shown until the first successful start. Afterwards a runtime restart keeps the
  // IDE (and everything open in it) mounted; see ReconnectBanner.
  if (!booted || !hasSettings) return <RuntimeSplash />
  return (
    <>
      {onboardingDone ? <Ide /> : <Onboarding />}
      <ReconnectBanner />
      <Toasts />
    </>
  )
}

function RuntimeSplash() {
  const runtime = useRuntimeStatus()
  const [log, setLog] = useState<string[]>([])
  useEffect(() => {
    const timer = window.setInterval(() => {
      void bridge()
        .runtime.status()
        .then((status) => setLog(status.log ?? []))
        .catch(() => undefined)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [])
  const failed = runtime?.state === 'failed'
  return (
    <div className="splash">
      <div className="row" style={{ fontSize: 18, fontWeight: 600 }}>
        {failed ? <StatusDot status="failed" /> : <Spinner />} Multi-AI Coder
      </div>
      <div className="muted">{failed ? 'Die lokale Laufzeit konnte nicht gestartet werden.' : runtime?.state === 'ready' ? 'Arbeitsstand wird wiederhergestellt …' : runtime?.state === 'restarting' ? 'Lokale Laufzeit wird neu gestartet …' : 'Lokale Laufzeit startet …'}</div>
      {runtime?.lastError ? <div className="callout error" style={{ maxWidth: 680 }}>{runtime.lastError}</div> : null}
      {failed ? (
        <button className="btn primary" onClick={() => void bridge().runtime.restart()}>
          Erneut starten
        </button>
      ) : null}
      {log.length && runtime?.state !== 'ready' ? <pre className="pre" style={{ width: 'min(900px, 90vw)', maxHeight: 260 }}>{log.slice(-30).join('\n')}</pre> : null}
    </div>
  )
}

/** Shown while the runtime restarts after a crash. Nothing below is unmounted or reset. */
function ReconnectBanner() {
  const reconnecting = useAppState((state) => state.reconnecting)
  const runtime = useRuntimeStatus()
  if (!reconnecting) return null
  return (
    <div className="reconnect-banner" role="status">
      {runtime?.state === 'failed' ? <StatusDot status="failed" /> : <Spinner />}
      <span>
        {runtime?.state === 'failed' ? 'Die lokale Laufzeit ist ausgefallen.' : 'Lokale Laufzeit startet neu …'} Offene Dateien, Sitzungen und Terminals bleiben erhalten; laufende Ausführungen werden danach korrekt als fortgesetzt oder unterbrochen angezeigt.
      </span>
      {runtime?.state === 'failed' ? (
        <button className="btn small" onClick={() => void bridge().runtime.restart()}>
          Erneut starten
        </button>
      ) : null}
    </div>
  )
}

const VIEWS: Array<{ id: SideView; label: string; icon: typeof FolderOpen }> = [
  { id: 'projects', label: 'Projekte', icon: FolderGit2 },
  { id: 'explorer', label: 'Explorer', icon: FolderOpen },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'tasks', label: 'Sitzungen', icon: MessagesSquare },
  { id: 'agents', label: 'Agenten', icon: Bot },
  { id: 'models', label: 'Modelle', icon: Cpu },
  { id: 'usage', label: 'Nutzung & Kosten', icon: PiggyBank },
]

const PANELS: Record<SideView, () => ReactNode> = {
  projects: () => <ProjectsPanel />,
  explorer: () => <ExplorerPanel />,
  git: () => <GitPanel />,
  tasks: () => <TasksPanel />,
  agents: () => <AgentsPanel />,
  models: () => <ModelsPanel />,
  usage: () => <UsagePanel />,
  settings: () => <SettingsPanel />,
}

/**
 * Side panels are mounted on first use and then kept mounted (hidden): switching views neither
 * re-initialises a view nor loses what was typed or expanded in it.
 */
function SidePanels({ view }: { view: SideView }) {
  const [mounted, setMounted] = useState<SideView[]>([view])
  useEffect(() => {
    setMounted((current) => (current.includes(view) ? current : [...current, view]))
  }, [view])
  return (
    <>
      {mounted.map((id) => (
        <div key={id} className="side-panel-view" data-view={id} style={{ display: id === view ? 'flex' : 'none' }}>
          <VisibilityContext.Provider value={id === view}>{PANELS[id]()}</VisibilityContext.Provider>
        </div>
      ))}
    </>
  )
}

function Ide() {
  const { sideView, theme, bottomOpen, project, settings } = useAppState(
    (state) => ({ sideView: state.ui.sideView, theme: state.ui.theme, bottomOpen: state.ui.bottomOpen, project: state.project, settings: state.settings }),
    shallowEqual,
  )
  const hasExecution = useSessionState((state) => Boolean(state.execution))

  return (
    <div className="ide" style={{ ['--side-width' as string]: ['models', 'usage', 'settings'].includes(sideView) ? '600px' : sideView === 'agents' ? '360px' : '290px' }}>
      <nav className="activity-bar">
        {VIEWS.map((view) => (
          <button key={view.id} className={sideView === view.id ? 'active' : ''} title={view.label} aria-label={view.label} onClick={() => actions.setSideView(view.id)}>
            <view.icon size={20} />
            {view.id === 'agents' ? <AgentsIndicator hasExecution={hasExecution} /> : null}
          </button>
        ))}
        <span className="spacer" />
        <button title={theme === 'dark' ? 'Helles Design' : 'Dunkles Design'} onClick={() => actions.setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button className={sideView === 'settings' ? 'active' : ''} title="Einstellungen" aria-label="Einstellungen" onClick={() => actions.setSideView('settings')}>
          <SettingsIcon size={19} />
        </button>
      </nav>
      <aside className="side-panel">
        <SidePanels view={sideView} />
      </aside>
      <section className="center" style={{ gridTemplateRows: bottomOpen ? '1fr auto' : '1fr' }}>
        <EditorArea />
        {/* The bottom panel stays mounted when hidden: terminals and logs keep their state. */}
        <div style={{ display: bottomOpen ? 'contents' : 'none' }}>
          <BottomPanel />
        </div>
      </section>
      <ChatPanel />
      <footer className="status-bar">
        <span className="item">
          <Boxes size={13} /> {project ? project.name : 'Kein Projekt'}
        </span>
        <span className="item">Orchestrator: {settings?.orchestrator === 'claude-code' ? 'Claude Code' : settings?.orchestrator === 'codex' ? 'Codex' : '–'}</span>
        <span className="item">Modus: {settings?.costMode}</span>
        <span className="item">Freigabe: {settings?.approvalMode === 'manual' ? 'manuell' : settings?.approvalMode}</span>
        <span className="spacer" />
        <ActivityIndicator />
        {!bottomOpen ? (
          <button className="btn small ghost" onClick={() => actions.setBottomOpen(true)} style={{ padding: '0 6px' }}>
            Panel einblenden
          </button>
        ) : null}
      </footer>
    </div>
  )
}

function AgentsIndicator({ hasExecution }: { hasExecution: boolean }) {
  const running = useAppState((state) => state.activity.executions.length + state.activity.plans.length)
  if (!running && !hasExecution) return null
  return <span className={`dot indicator ${running ? 'running' : ''}`} />
}

/** What runs in the runtime right now (from the runtime, not counted from UI events). */
function ActivityIndicator() {
  const activity = useAppState((state) => state.activity)
  const projectId = useAppState((state) => state.project?.id)
  const parts = [
    activity.executions.length ? `${activity.executions.length} Ausführung(en)` : '',
    activity.plans.length ? `${activity.plans.length} Planung(en)` : '',
    activity.asks.length ? `${activity.asks.length} Frage(n)` : '',
  ].filter(Boolean)
  if (!parts.length) return <span className="item">bereit</span>
  const first = activity.executions.find((entry) => entry.projectId === projectId) ?? activity.plans.find((entry) => entry.projectId === projectId)
  return (
    <button
      className="item activity-indicator"
      title={[...activity.executions.map((entry) => `▶ ${entry.title} (${entry.status})`), ...activity.plans.map((entry) => `◔ Plan: ${entry.title}`)].join('\n') || undefined}
      onClick={() => {
        if (first?.sessionId) void actions.selectSession(first.sessionId)
        actions.setSideView('agents')
      }}
    >
      <span className="dot running" /> {parts.join(' · ')} aktiv
    </button>
  )
}
