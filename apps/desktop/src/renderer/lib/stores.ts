import type { RuntimeStatus, TerminalInfo } from '../../shared/bridge'
import { createStore } from './store/core'
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

export type SideView = 'projects' | 'explorer' | 'git' | 'tasks' | 'agents' | 'models' | 'usage' | 'settings'
export type BottomTab = 'terminal' | 'logs' | 'tests' | 'diff' | 'run' | 'problems'
export type Theme = 'dark' | 'light'

/** Window-level layout, persisted globally ("ui" document). */
export interface UiState {
  theme: Theme
  sideView: SideView
  bottomTab: BottomTab
  bottomOpen: boolean
  lastProjectId?: string
}

export interface ComposerDraft {
  text: string
  mode: 'task' | 'ask'
  autoRun: boolean
}

/** Per-project work state, persisted as "workspace:<projectId>". */
export interface WorkspaceState {
  activeSessionId?: string
  explorer: { expanded: string[]; selected?: string }
  /** Chat composer drafts per session ("new" = no session yet). */
  composer: Record<string, ComposerDraft>
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
  ui: { theme: initialTheme(), sideView: 'explorer', bottomTab: 'terminal', bottomOpen: true },
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

export const jobsStore = createStore<{ pulls: Record<string, PullProgress>; installLog: string[] }>({ pulls: {}, installLog: [] })

export const terminalStore = createStore<{ list: TerminalInfo[] }>({ list: [] })

export interface EditorTab {
  id: string
  kind: 'file' | 'diff'
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

export const editorStore = createStore<{ tabs: EditorTab[]; activeTabId?: string; restoring: boolean }>({ tabs: [], restoring: false })

export type { ChatMessage }
