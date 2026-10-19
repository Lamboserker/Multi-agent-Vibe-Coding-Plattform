import type { RuntimeStatus, TerminalInfo } from '../../shared/bridge'
import { createStore } from './store/core'
import type { PlanningProgressByTask } from './planning-progress'
import type { Activity, ChatMessage, ExecutionRun, Project, RunEvent, SessionDetail, SessionSummary, Task, VersionedSettings } from './types'

/*
 * State classes (see docs/state-architecture.md):
 *  1. global user settings ............ runtime (SQLite)            → appStore.settings
 *  2. project settings ................ runtime (Project.settings)
 *  3. persistent work state ........... main-process state store    → uiStore (global) + workspace (per project)
 *     unsaved editor content .......... main-process drafts         → editor-models.ts
 *  4. short-lived UI state ............ component state (dialogs, hover, menus)
 *  5. running work & recovery data .... runtime jobs/runs/sessions  → sessionStore, activity
 */

export type SideView = 'projects' | 'explorer' | 'search' | 'git' | 'tasks' | 'agents' | 'models' | 'plugins' | 'skills' | 'mcp' | 'usage' | 'diagnostics' | 'settings'
export type BottomTab = 'terminal' | 'logs' | 'tests' | 'diff' | 'run' | 'problems'
export type Theme = 'dark' | 'light'
/** Main screens of the navigation rail. */
export type Screen = 'leitstand' | 'code' | 'review' | 'sessions' | 'models' | 'usage' | 'setup'
export type SetupSection = 'onboarding' | 'settings' | 'agents' | 'plugins' | 'skills' | 'mcp' | 'diagnostics'
export type LeitstandVariant = 'graph' | 'tiles'

/** Window-level layout, persisted globally ("ui" document). */
export interface UiState {
  theme: Theme
  screen: Screen
  setupSection: SetupSection
  /** Leitstand: agents as a flow graph or as live tiles. */
  leitstandVariant: LeitstandVariant
  /** Leitstand: details of the selected agent below the graph. */
  inspectorOpen: boolean
  sideView: SideView
  bottomTab: BottomTab
  bottomOpen: boolean
  /** Bottom panel fills the whole center column (editor hidden). */
  bottomMaximized: boolean
  sideOpen: boolean
  chatOpen: boolean
  /** User-dragged sizes in px; unset = default (side width depends on the view). */
  sideWidths: Partial<Record<SideView, number>>
  chatWidth?: number
  bottomHeight?: number
  lastProjectId?: string
  /** Enough to show the workspace before the runtime has started (see sync.showCachedShell). */
  lastProject?: { id: string; name: string; repoPath: string }
}

export interface ComposerDraft {
  text: string
  mode: 'task' | 'ask'
  autoRun: boolean
}

/** Per-project work state, persisted as "workspace:<projectId>". */
export interface WorkspaceState {
  activeSessionId?: string
  /** Sessions whose tab in the header was closed (the sessions themselves stay). */
  closedSessionTabs?: string[]
  chatView?: 'workflow' | 'history'
  explorer: { expanded: string[]; selected?: string }
  /** Chat composer drafts per session ("new" = no session yet). */
  composer: Record<string, ComposerDraft>
  /** Second terminal shown next to the active one (split view). */
  splitTerminalId?: string
  gitMessage: string
  activeTerminalId?: string
}

export const EMPTY_WORKSPACE: WorkspaceState = { explorer: { expanded: [''] }, composer: {}, gitMessage: '' }

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
}

interface AppState {
  runtime?: RuntimeStatus
  /** True once the runtime was ready and the persisted state was restored. */
  booted: boolean
  /** Runtime unavailable after the first successful start (crash restart): the IDE stays mounted. */
  reconnecting: boolean
  settings?: VersionedSettings
  project?: Project
  ui: UiState
  workspace: WorkspaceState
  activity: Activity
}

function initialTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export const appStore = createStore<AppState>({
  booted: false,
  reconnecting: false,
  ui: { theme: initialTheme(), screen: 'leitstand', setupSection: 'onboarding', leitstandVariant: 'graph', inspectorOpen: true, sideView: 'explorer', bottomTab: 'terminal', bottomOpen: true, bottomMaximized: false, sideOpen: true, chatOpen: true, sideWidths: {} },
  workspace: EMPTY_WORKSPACE,
  activity: { executions: [], plans: [], asks: [] },
})

export const toastStore = createStore<{ toasts: Toast[] }>({ toasts: [] })

/** A message the user sent that is not yet confirmed as persisted by the runtime. */
export interface PendingMessage {
  clientId: string
  sessionId?: string
  content: string
  mode: 'task' | 'ask'
  status: 'sending' | 'failed'
  error?: string
  createdAt: string
}

interface SessionState {
  list: SessionSummary[]
  listLoaded: boolean
  includeArchived: boolean
  active?: SessionDetail
  pending: PendingMessage[]
  task?: Task
  execution?: ExecutionRun
  events: RunEvent[]
  selectedSubtaskId?: string
  /** Older chat pages loaded on demand (kept apart from `active`, which reloads the newest page). */
  older?: { sessionId: string; messages: SessionDetail['messages']; hasMore: boolean }
}

export const sessionStore = createStore<SessionState>({ list: [], listLoaded: false, includeArchived: false, pending: [], events: [] })

export interface LiveLine {
  ts: string
  level: string
  type: string
  message: string
  subtaskId?: string
}

/** Live agent output: only the log view subscribes to it. */
export const liveStore = createStore<{ executionId?: string; lines: LiveLine[] }>({ lines: [] })

export interface PullProgress {
  percent?: number
  status: string
}

/** Planning progress survives session switches, also while two tasks plan concurrently. */
export const planProgressStore = createStore<{ tasks: PlanningProgressByTask }>({ tasks: {} })

export const jobsStore =createStore<{ pulls: Record<string, PullProgress>; installLog: string[] }>({ pulls: {}, installLog: [] })

export const terminalStore = createStore<{ list: TerminalInfo[] }>({ list: [] })

export interface EditorTab {
  id: string
  /** preview: a local dev server (path is its URL) shown inside the app */
  kind: 'file' | 'diff' | 'preview'
  path: string
  title: string
  dirty: boolean
  readOnly: boolean
  /** File changed on disk while the tab had unsaved edits. */
  externalChange?: boolean
  language?: string
  mtimeMs?: number
  /** Diff tabs: both sides (not persisted, restored from `source`). */
  original?: string
  content?: string
  source?: DiffSource
}

/** Where a diff tab's content comes from, so it can be restored after a reload. */
export type DiffSource =
  | { type: 'execution'; executionId: string }
  | { type: 'git-head'; path: string }
  | { type: 'subtask-patch'; taskId: string; subtaskId: string }

/** splitTabId: a second file tab shown next to the active one (split editor). */
export const editorStore = createStore<{ tabs: EditorTab[]; activeTabId?: string; splitTabId?: string; restoring: boolean }>({ tabs: [], restoring: false })

export type { ChatMessage }

/** Bumped on plugin_* runtime events; plugin views reload their list/details when it changes. */
export const pluginStore = createStore<{ revision: number; lastEvent?: { id?: string; type: string; status?: string; error?: string } }>({ revision: 0 })

// ---------------------------------------------------------------------------
// IDE features (Phase F)
// ---------------------------------------------------------------------------

export interface SearchMatch {
  line: number
  column: number
  length: number
  preview: string
}

export interface SearchState {
  query: string
  replacement: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  include: string
  exclude: string
  loading: boolean
  error?: string
  results?: { files: Array<{ path: string; matches: SearchMatch[] }>; total: number; truncated: boolean }
  /** "Find all references" shows its result in the search view. */
  references?: { title: string; items: Array<{ path: string; line: number; column: number; endLine: number; endColumn: number; preview: string; isDefinition: boolean }> }
}

export const searchStore = createStore<SearchState>({ query: '', replacement: '', regex: false, caseSensitive: false, wholeWord: false, include: '', exclude: '', loading: false })

export interface ProblemEntry {
  path: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info'
  message: string
  code?: string
  source: string
}

export const problemsStore = createStore<{
  /** Live diagnostics of open files (language service, unsaved content included). */
  files: Record<string, ProblemEntry[]>
  project?: { at: string; durationMs: number; problems: ProblemEntry[]; tools: string[]; running: boolean }
}>({ files: {} })

/** Modal dialogs opened from editor commands. */
export type EditorDialog =
  | { kind: 'ai-edit'; tabId: string; path: string; selection: { line: number; column: number; endLine: number; endColumn: number }; text: string }
  | { kind: 'history'; tabId: string; path: string }
  | { kind: 'quick-open'; mode: 'files' | 'commands' | 'line' }
  | { kind: 'shortcuts' }

export const dialogStore = createStore<{ dialog?: EditorDialog }>({})
