import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FolderGit2, FolderOpen, GitBranch, GitCompare, PanelBottom, PanelLeft, PanelRight, Radar, Search } from 'lucide-react'
import * as actions from '../../lib/actions'
import { openAgentVersion, openChangedFile } from '../../lib/agent-files'
import { VisibilityContext } from '../../lib/hooks'
import { agentCards, TONE } from '../../lib/leitstand'
import { shallowEqual } from '../../lib/store/core'
import { useAppState, useEditorState, useSessionState } from '../../lib/store'
import type { SideView } from '../../lib/stores'
import { BottomPanel } from '../bottom/BottomPanel'
import { EditorArea } from '../editor/EditorArea'
import { ExplorerPanel } from '../panels/ExplorerPanel'
import { GitPanel } from '../panels/GitPanel'
import { ProjectsPanel } from '../panels/ProjectsPanel'
import { SearchPanel } from '../search/SearchPanel'
import { Splitter } from '../Splitter'
import { Chip, Dot, Eyebrow, KindIcon } from '../ui'

const SIDE_TABS: Array<{ id: SideView; label: string; icon: typeof FolderOpen }> = [
  { id: 'explorer', label: 'Explorer', icon: FolderOpen },
  { id: 'search', label: 'Suchen', icon: Search },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'projects', label: 'Projekte', icon: FolderGit2 },
]
const CODE_VIEWS = SIDE_TABS.map((tab) => tab.id)
const PANELS: Partial<Record<SideView, () => ReactNode>> = {
  explorer: () => <ExplorerPanel />,
  search: () => <SearchPanel />,
  git: () => <GitPanel />,
  projects: () => <ProjectsPanel />,
}

/** Side views are mounted on first use and then kept (hidden), so nothing typed or expanded is lost. */
function SidePanels({ view }: { view: SideView }) {
  const [mounted, setMounted] = useState<SideView[]>([view])
  useEffect(() => setMounted((current) => (current.includes(view) ? current : [...current, view])), [view])
  return (
    <>
      {mounted.map((id) => (
        <div key={id} className="side-panel-view" data-view={id} style={{ display: id === view ? 'flex' : 'none' }}>
          <VisibilityContext.Provider value={id === view}>{PANELS[id]?.()}</VisibilityContext.Provider>
        </div>
      ))}
    </>
  )
}

const SIDE_MIN = 180
const BOTTOM_MIN = 90
const AGENT_WIDTH = 290

function useWindowSize() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

export function CodeScreen({ visible }: { visible: boolean }) {
  const { sideView: storedView, sideOpen, bottomOpen, bottomMaximized, storedSide, storedBottom, agentsOpen } = useAppState(
    // ui.chatOpen (the former chat column) now toggles the agent column on the right
    (state) => ({ sideView: state.ui.sideView, sideOpen: state.ui.sideOpen, bottomOpen: state.ui.bottomOpen, bottomMaximized: state.ui.bottomMaximized, storedSide: state.ui.sideWidths[state.ui.sideView], storedBottom: state.ui.bottomHeight, agentsOpen: state.ui.chatOpen }),
    shallowEqual,
  )
  const sideView = CODE_VIEWS.includes(storedView) ? storedView : 'explorer'
  const ref = useRef<HTMLDivElement>(null)
  const size = useWindowSize()
  const free = size.width - 72 - (agentsOpen ? AGENT_WIDTH : 0) - 360
  const sideWidth = sideOpen ? Math.max(SIDE_MIN, Math.min(storedSide ?? 270, free)) : 0
  const bottomMax = () => size.height - 52 - 28 - 160
  const bottomHeight = Math.max(BOTTOM_MIN, Math.min(storedBottom ?? 240, bottomMax()))
  const preview = (name: string) => (px: number) => ref.current?.style.setProperty(name, `${px}px`)

  return (
    <div ref={ref} className="code-screen" style={{ ['--side-width' as string]: `${sideWidth}px`, ['--bottom-height' as string]: `${bottomHeight}px` }}>
      {sideOpen ? (
        <aside className="code-side side-panel">
          <div className="code-side-tabs" role="tablist" aria-label="Seitenansicht">
            {SIDE_TABS.map((tab) => (
              <button key={tab.id} role="tab" aria-selected={sideView === tab.id} aria-label={tab.label} title={tab.label} className={sideView === tab.id ? 'on' : ''} onClick={() => actions.toggleSideView(tab.id)}>
                <tab.icon size={15} />
              </button>
            ))}
            <span className="spacer" />
            <button title="Seitenleiste ausblenden (Strg+B)" aria-label="Seitenleiste ausblenden" onClick={() => actions.setLayout({ sideOpen: false })}>
              <PanelLeft size={15} />
            </button>
          </div>
          <SidePanels view={sideView} />
        </aside>
      ) : null}
      {sideOpen ? (
        <Splitter axis="x" direction={1} className="splitter-side" label="Seitenleiste" size={sideWidth} min={SIDE_MIN} max={() => free} onPreview={preview('--side-width')} onCommit={(width) => actions.setSideWidth(sideView, width)} onCollapse={() => actions.setLayout({ sideOpen: false })} onReset={() => actions.setSideWidth(sideView, undefined)} />
      ) : null}
      <section className={`center ${bottomOpen && bottomMaximized ? 'bottom-max' : ''}`} style={{ gridTemplateRows: !bottomOpen ? '1fr' : bottomMaximized ? '0 1fr' : '1fr auto' }}>
        <VisibilityContext.Provider value={visible}>
          <EditorArea />
          <div style={{ display: bottomOpen ? 'contents' : 'none' }}>
            <BottomPanel
              resizer={bottomMaximized ? null : <Splitter axis="y" direction={-1} className="splitter-bottom" label="Unteres Panel" size={bottomHeight} min={BOTTOM_MIN} max={bottomMax} onPreview={preview('--bottom-height')} onCommit={(height) => actions.setLayout({ bottomHeight: height })} onCollapse={() => actions.setBottomOpen(false)} onReset={() => actions.setLayout({ bottomHeight: undefined })} />}
            />
          </div>
        </VisibilityContext.Provider>
        <div className="code-toggles" hidden={bottomOpen && bottomMaximized}>
          {!sideOpen ? <button title="Seitenleiste einblenden (Strg+B)" aria-label="Seitenleiste einblenden" onClick={() => actions.setLayout({ sideOpen: true })}><PanelLeft size={14} /></button> : null}
          <button className={bottomOpen ? 'on' : ''} title="Terminal & Protokolle (Strg+J)" aria-label="Unteres Panel ein-/ausblenden" onClick={() => actions.setBottomOpen(!bottomOpen)}><PanelBottom size={14} /></button>
          <button className={agentsOpen ? 'on' : ''} title="Agenten-Änderungen ein-/ausblenden" aria-label="Agenten-Änderungen ein-/ausblenden" onClick={() => actions.setLayout({ chatOpen: !agentsOpen })}><PanelRight size={14} /></button>
        </div>
      </section>
      {agentsOpen ? <AgentChanges /> : null}
    </div>
  )
}

/** Which agent changed the open file, plus every change of the current run. */
function AgentChanges() {
  const { task, execution: selected } = useSessionState((state) => ({ task: state.task, execution: state.execution }), shallowEqual)
  const execution = selected && selected.taskId === task?.id ? selected : undefined
  const activePath = useEditorState((state) => state.tabs.find((tab) => tab.id === state.activeTabId)?.path)
  const cards = useMemo(() => agentCards({ subtasks: execution?.task?.subtasks ?? task?.subtasks ?? [], plan: execution?.task?.plans?.[0] ?? task?.plans?.[0], runs: execution?.agentRuns }), [execution, task])
  const applied = Boolean(execution && (execution.status === 'applied' || execution.applyRecords?.some((record) => record.status === 'applied' && record.mode === 'working_tree')))
  const changes = cards.flatMap((card) => card.files.filter((file) => file.added !== null || card.active).map((file) => ({ card, file })))
  const current = changes.find((entry) => entry.file.path === activePath)
  const card = current?.card
  return (
    <aside className="agent-changes">
      <Eyebrow>Bearbeitet von</Eyebrow>
      {card && current ? (
        <>
          <div className="side-card" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 8 }}>
              <KindIcon icon={card.icon} tone={card.tone} size={28} />
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, minWidth: 0 }}>
                <strong className="truncate">{card.key} · {card.agent}</strong>
                <span className="mono faint truncate" style={{ fontSize: 10.5 }}>{card.model}</span>
              </div>
            </div>
            <div style={{ fontSize: 12.5, textWrap: 'pretty' }}>{card.title}</div>
            <div className="row" style={{ gap: 8, fontSize: 12 }}>
              <Dot tone={card.status === 'completed' && !applied ? 'tool' : card.statusTone} pulse={card.active} />
              <span style={{ color: TONE[card.status === 'completed' && !applied ? 'tool' : card.statusTone].color }}>{card.status === 'completed' && !applied ? 'fertig · noch nicht übernommen' : card.statusLabel}</span>
              <span className="spacer" />
              {current.file.added !== null ? <span className="mono" style={{ fontSize: 11, color: 'var(--ok)' }}>+{current.file.added}</span> : null}
              {current.file.deleted ? <span className="mono" style={{ fontSize: 11, color: 'var(--err)' }}>−{current.file.deleted}</span> : null}
            </div>
            {!applied && card.status === 'completed' ? <div className="faint" style={{ fontSize: 12 }}>Die Änderung liegt im Integrations-Branch. Im Editor siehst du deine Arbeitskopie; die Agenten-Version öffnet sich als Diff.</div> : null}
            {card.active ? <div className="faint" style={{ fontSize: 12 }}>{card.key} arbeitet gerade im eigenen Worktree an dieser Datei. Die Änderung erscheint nach der Integration.</div> : null}
          </div>
          <div className="stack" style={{ gap: 6 }}>
            {execution && card.status === 'completed' ? (
              <button className="btn" style={{ justifyContent: 'center' }} onClick={() => void openAgentVersion(execution, current.file.path)}>
                <GitCompare size={13} /> Als Diff ansehen
              </button>
            ) : null}
            <button className="btn" style={{ justifyContent: 'center' }} onClick={() => { actions.setSelectedSubtask(card.id); actions.setScreen('leitstand') }}>
              <Radar size={13} /> Agent im Leitstand zeigen
            </button>
          </div>
        </>
      ) : (
        <div className="dashed-note">{activePath ? 'Keine Agenten-Änderungen in dieser Datei. Du kannst sie normal bearbeiten; der Orchestrator sieht deine Änderungen bei der nächsten Aufgabe.' : 'Öffne eine Datei, um zu sehen, welcher Agent sie geändert hat.'}</div>
      )}
      <Eyebrow>Alle Änderungen dieses Laufs</Eyebrow>
      {changes.length ? (
        <div className="stack" style={{ gap: 2 }}>
          {changes.map(({ card: owner, file }) => {
            const state = owner.active ? 'in Arbeit' : owner.status !== 'completed' ? 'offen' : applied ? (file.status === 'added' ? 'neu' : 'geändert') : 'nicht übernommen'
            return (
              <button key={owner.key + file.path} className={`change-row ${file.path === activePath ? 'on' : ''}`} title={file.path} onClick={() => void (owner.status === 'completed' ? openChangedFile(execution, file.path) : actions.openFile(file.path))}>
                <Chip tone={owner.tone}>{owner.key}</Chip>
                <span className="mono truncate" style={{ flex: 1, fontSize: 11.5 }}>{file.path.split('/').pop()}</span>
                <span style={{ fontSize: 11, color: owner.active ? 'var(--accent)' : owner.status === 'completed' ? 'var(--ok)' : 'var(--faint)' }}>{state}</span>
              </button>
            )
          })}
        </div>
      ) : <div className="faint" style={{ fontSize: 12.5 }}>{task ? 'Noch keine Änderungen.' : 'Kein aktiver Lauf in dieser Sitzung.'}</div>}
    </aside>
  )
}
