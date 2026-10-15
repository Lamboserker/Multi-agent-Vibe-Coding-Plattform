import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Activity as ActivityIcon, Bot, Boxes, Cable, Command as CommandIcon, Cpu, FolderGit2, FolderOpen, GitBranch, MessagesSquare, Moon, PanelBottom, PanelLeft, PanelRight, PiggyBank, Puzzle, Search, Settings as SettingsIcon, Sparkles, Sun } from 'lucide-react'
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
import { TasksPanel } from './components/panels/TasksPanel'
import { commandForEvent } from './lib/commands'
import { useStore } from './lib/store/core'
import { dialogStore, problemsStore } from './lib/stores'
import { EditorArea } from './components/editor/EditorArea'
import { GitPanel } from './components/panels/GitPanel'
import { AgentsPanel } from './components/panels/AgentsPanel'
import { ModelsPanel } from './components/panels/ModelsPanel'
import { UsagePanel } from './components/panels/UsagePanel'
import { SettingsPanel } from './components/panels/SettingsPanel'
import { DiagnosticsPanel } from './components/panels/DiagnosticsPanel'
import { PluginsPanel } from './components/plugins/PluginsPanel'
import { SkillsPanel } from './components/skills/SkillsPanel'
import { McpPanel } from './components/mcp/McpPanel'
import { SearchPanel } from './components/search/SearchPanel'
import { EditorDialogs } from './components/editor/EditorDialogs'
import { BottomPanel } from './components/bottom/BottomPanel'
import { ChatPanel } from './components/chat/ChatPanel'
import { Splitter } from './components/Splitter'
import { workflowState } from './lib/workflow'

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

type ViewEntry = { id: SideView; label: string; icon: typeof FolderOpen }

/** Daily work: top of the activity bar. */
const WORK_VIEWS: ViewEntry[] = [
  { id: 'projects', label: 'Projekte', icon: FolderGit2 },
  { id: 'explorer', label: 'Explorer', icon: FolderOpen },
  { id: 'search', label: 'Suchen', icon: Search },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'tasks', label: 'Sitzungen', icon: MessagesSquare },
  { id: 'agents', label: 'Agenten', icon: Bot },
]

/** Set up once, rarely opened: grouped at the bottom next to the settings. */
const SETUP_VIEWS: ViewEntry[] = [
  { id: 'models', label: 'Modelle', icon: Cpu },
  { id: 'plugins', label: 'Erweiterungen', icon: Puzzle },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mcp', label: 'MCP-Server', icon: Cable },
  { id: 'usage', label: 'Nutzung & Kosten', icon: PiggyBank },
  { id: 'diagnostics', label: 'Diagnose & Performance', icon: ActivityIcon },
]

const PANELS: Record<SideView, () => ReactNode> = {
  projects: () => <ProjectsPanel />,
  explorer: () => <ExplorerPanel />,
  search: () => <SearchPanel />,
  git: () => <GitPanel />,
  tasks: () => <TasksPanel />,
  agents: () => <AgentsPanel />,
  models: () => <ModelsPanel />,
  plugins: () => <PluginsPanel />,
  skills: () => <SkillsPanel />,
  mcp: () => <McpPanel />,
  usage: () => <UsagePanel />,
  diagnostics: () => <DiagnosticsPanel />,
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

const ACTIVITY_WIDTH = 48
const STATUS_HEIGHT = 24
/** The editor column never gets narrower than this when side/chat panels are dragged. */
const MIN_CENTER = 320
const SIDE_MIN = 180
const CHAT_MIN = 280
const BOTTOM_MIN = 90
const CHAT_DEFAULT = 400
const BOTTOM_DEFAULT = 260
const WIDE_VIEWS: SideView[] = ['models', 'plugins', 'skills', 'mcp', 'usage', 'settings', 'diagnostics']

function defaultSideWidth(view: SideView) {
  return WIDE_VIEWS.includes(view) ? 520 : view === 'agents' ? 360 : 290
}

function useWindowSize() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

function Ide() {
  const { sideView, theme, bottomOpen, project, settings, sideOpen, chatOpen, bottomMaximized, storedSide, storedChat, storedBottom } = useAppState(
    (state) => ({
      sideView: state.ui.sideView,
      theme: state.ui.theme,
      bottomOpen: state.ui.bottomOpen,
      project: state.project,
      settings: state.settings,
      sideOpen: state.ui.sideOpen,
      chatOpen: state.ui.chatOpen,
      bottomMaximized: state.ui.bottomMaximized,
      storedSide: state.ui.sideWidths[state.ui.sideView],
      storedChat: state.ui.chatWidth,
      storedBottom: state.ui.bottomHeight,
    }),
    shallowEqual,
  )
  const hasExecution = useSessionState((state) => Boolean(state.execution))
  const ideRef = useRef<HTMLDivElement>(null)
  const windowSize = useWindowSize()

  // stored sizes are clamped to the current window so the editor column always stays usable
  const free = windowSize.width - ACTIVITY_WIDTH - MIN_CENTER
  const chatWidth = chatOpen ? Math.max(CHAT_MIN, Math.min(storedChat ?? CHAT_DEFAULT, free - (sideOpen ? SIDE_MIN : 0))) : 0
  const sideWidth = sideOpen ? Math.max(SIDE_MIN, Math.min(storedSide ?? defaultSideWidth(sideView), free - chatWidth)) : 0
  const bottomMax = () => windowSize.height - STATUS_HEIGHT - 120
  const bottomHeight = Math.max(BOTTOM_MIN, Math.min(storedBottom ?? BOTTOM_DEFAULT, bottomMax()))
  // while dragging only the CSS variable changes; the store (and a re-render) follows on release
  const preview = (name: string) => (px: number) => ideRef.current?.style.setProperty(name, `${px}px`)

  // global shortcuts (command registry); editor-specific ones are bound inside Monaco
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = commandForEvent(event)
      if (!command || (command.enabled && !command.enabled())) return
      event.preventDefault()
      event.stopPropagation()
      void Promise.resolve(command.run()).catch((error: unknown) => actions.notify(error instanceof Error ? error.message : String(error), 'error'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div
      ref={ideRef}
      className={`ide ${sideOpen ? '' : 'side-closed'} ${chatOpen ? '' : 'chat-closed'}`}
      style={{ ['--side-width' as string]: `${sideWidth}px`, ['--chat-width' as string]: `${chatWidth}px`, ['--bottom-height' as string]: `${bottomHeight}px` }}
    >
      <nav className="activity-bar">
        {WORK_VIEWS.map((view) => (
          <ViewButton key={view.id} view={view} active={sideOpen && sideView === view.id}>
            {view.id === 'agents' ? <AgentsIndicator hasExecution={hasExecution} /> : null}
          </ViewButton>
        ))}
        <span className="spacer" />
        {SETUP_VIEWS.map((view) => (
          <ViewButton key={view.id} view={view} active={sideOpen && sideView === view.id} small />
        ))}
        <span className="activity-separator" />
        <button title="Befehlspalette (Strg+Umschalt+P)" aria-label="Befehlspalette" onClick={() => dialogStore.set({ dialog: { kind: 'quick-open', mode: 'commands' } })}>
          <CommandIcon size={18} />
        </button>
        <button title={theme === 'dark' ? 'Helles Design' : 'Dunkles Design'} onClick={() => actions.setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button className={sideOpen && sideView === 'settings' ? 'active' : ''} title="Einstellungen" aria-label="Einstellungen" onClick={() => actions.toggleSideView('settings')}>
          <SettingsIcon size={19} />
        </button>
      </nav>
      <aside className="side-panel">
        <SidePanels view={sideView} />
      </aside>
      {sideOpen ? (
        <Splitter
          axis="x"
          direction={1}
          className="splitter-side"
          label="Seitenleiste"
          size={sideWidth}
          min={SIDE_MIN}
          max={() => free - chatWidth}
          onPreview={preview('--side-width')}
          onCommit={(width) => actions.setSideWidth(sideView, width)}
          onCollapse={() => actions.setLayout({ sideOpen: false })}
          onReset={() => actions.setSideWidth(sideView, undefined)}
        />
      ) : null}
      <section className={`center ${bottomOpen && bottomMaximized ? 'bottom-max' : ''}`} style={{ gridTemplateRows: !bottomOpen ? '1fr' : bottomMaximized ? '0 1fr' : '1fr auto' }}>
        <EditorArea />
        {/* The bottom panel stays mounted when hidden: terminals and logs keep their state. */}
        <div style={{ display: bottomOpen ? 'contents' : 'none' }}>
          <BottomPanel
            resizer={
              bottomMaximized ? null : (
                <Splitter
                  axis="y"
                  direction={-1}
                  className="splitter-bottom"
                  label="Unteres Panel"
                  size={bottomHeight}
                  min={BOTTOM_MIN}
                  max={bottomMax}
                  onPreview={preview('--bottom-height')}
                  onCommit={(height) => actions.setLayout({ bottomHeight: height })}
                  onCollapse={() => actions.setBottomOpen(false)}
                  onReset={() => actions.setLayout({ bottomHeight: undefined })}
                />
              )
            }
          />
        </div>
      </section>
      {chatOpen ? (
        <Splitter
          axis="x"
          direction={-1}
          className="splitter-chat"
          label="Chat-Bereich"
          size={chatWidth}
          min={CHAT_MIN}
          max={() => free - sideWidth}
          onPreview={preview('--chat-width')}
          onCommit={(width) => actions.setLayout({ chatWidth: width })}
          onCollapse={() => actions.setLayout({ chatOpen: false })}
          onReset={() => actions.setLayout({ chatWidth: undefined })}
        />
      ) : null}
      <ChatPanel />
      <footer className="status-bar">
        <span className="item">
          <Boxes size={13} /> {project ? project.name : 'Kein Projekt'}
        </span>
        <span className="item">Orchestrator: {settings?.orchestrator === 'claude-code' ? 'Claude Code' : settings?.orchestrator === 'codex' ? 'Codex' : '–'}</span>
        <span className="item">Modus: {settings?.costMode}</span>
        <span className="item">Freigabe: {settings?.approvalMode === 'manual' ? 'manuell' : settings?.approvalMode}</span>
        <span className="spacer" />
        <ProblemsIndicator />
        <RuntimeIndicator />
        <ActivityIndicator />
        <span className="layout-toggles">
          <button className={`item ${sideOpen ? 'on' : ''}`} title="Seitenleiste ein-/ausblenden (Strg+B)" aria-label="Seitenleiste ein-/ausblenden" onClick={() => actions.setLayout({ sideOpen: !sideOpen })}>
            <PanelLeft size={14} />
          </button>
          <button className={`item ${bottomOpen ? 'on' : ''}`} title="Unteres Panel ein-/ausblenden (Strg+J)" aria-label="Unteres Panel ein-/ausblenden" onClick={() => actions.setBottomOpen(!bottomOpen)}>
            <PanelBottom size={14} />
          </button>
          <button className={`item ${chatOpen ? 'on' : ''}`} title="Chat ein-/ausblenden (Strg+Umschalt+B)" aria-label="Chat ein-/ausblenden" onClick={() => actions.setLayout({ chatOpen: !chatOpen })}>
            <PanelRight size={14} />
          </button>
        </span>
      </footer>
      <EditorDialogs />
    </div>
  )
}

function ViewButton({ view, active, small, children }: { view: ViewEntry; active: boolean; small?: boolean; children?: ReactNode }) {
  return (
    <button className={`${active ? 'active' : ''} ${small ? 'small' : ''}`} title={active ? `${view.label} (erneut klicken zum Einklappen)` : view.label} aria-label={view.label} onClick={() => actions.toggleSideView(view.id)}>
      <view.icon size={small ? 17 : 20} />
      {children}
    </button>
  )
}

function ProblemsIndicator() {
  const counts = useStore(problemsStore, (state) => {
    const all = [...Object.values(state.files).flat(), ...(state.project?.problems ?? [])]
    return `${all.filter((problem) => problem.severity === 'error').length}/${all.filter((problem) => problem.severity === 'warning').length}`
  })
  const [errors, warnings] = counts.split('/')
  return (
    <button
      className="item"
      title="Probleme anzeigen"
      onClick={() => {
        actions.setBottomOpen(true)
        actions.setBottomTab('problems')
      }}
    >
      ⊗ {errors} ⚠ {warnings}
    </button>
  )
}

function RuntimeIndicator() {
  const runtime = useRuntimeStatus()
  if (!runtime || runtime.state === 'ready') return null
  return (
    <span className="item">
      <Spinner /> Laufzeit {runtime.state === 'failed' ? 'ausgefallen' : 'startet'} …
    </span>
  )
}

function AgentsIndicator({ hasExecution }: { hasExecution: boolean }) {
  const running = useAppState((state) => state.activity.executions.length + state.activity.plans.length)
  if (!running && !hasExecution) return null
  return <span className={`dot indicator ${running ? 'running' : ''}`} />
}

/** Status and navigation to the selected workflow; background activity comes from the runtime. */
function ActivityIndicator() {
  const activity = useAppState((state) => state.activity)
  const projectId = useAppState((state) => state.project?.id)
  const { task, execution } = useSessionState((state) => ({ task: state.task, execution: state.execution }), shallowEqual)
  const current = workflowState(task, execution)
  const parts = [
    activity.executions.length ? `${activity.executions.length} Ausführung(en)` : '',
    activity.plans.length ? `${activity.plans.length} Planung(en)` : '',
    activity.asks.length ? `${activity.asks.length} Frage(n)` : '',
  ].filter(Boolean)
  const first = activity.executions.find((entry) => entry.projectId === projectId) ?? activity.plans.find((entry) => entry.projectId === projectId)
  return (
    <button
      className="item activity-indicator"
      data-testid="workflow-entry"
      title={['Arbeitsablauf öffnen (Strg+Umschalt+L)', ...activity.executions.map((entry) => `▶ ${entry.title} (${entry.status})`), ...activity.plans.map((entry) => `◔ Plan: ${entry.title}`)].join('\n')}
      onClick={() => {
        void actions.openWorkflow(task ? undefined : first?.sessionId ?? undefined)
      }}
    >
      {parts.length ? <span className="dot running" /> : null} {task ? current.label : parts.length ? `${parts.join(' · ')} aktiv` : 'Arbeitsablauf'}
    </button>
  )
}
