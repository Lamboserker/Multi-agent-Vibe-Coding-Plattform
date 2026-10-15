import type { DraftEntry } from '../../shared/bridge'
import { api, ApiError, bridge, enc, errorMessage } from './api'
import * as models from './editor-models'
import * as persistence from './persistence'
import {
  appStore,
  editorStore,
  jobsStore,
  liveStore,
  sessionStore,
  terminalStore,
  toastStore,
  type BottomTab,
  type ComposerDraft,
  type DiffSource,
  type EditorTab,
  type SideView,
  type Theme,
  type Toast,
  type UiState,
  type WorkspaceState,
} from './stores'
import type { Activity, ExecutionRun, FileContent, Project, RunEvent, SessionDetail, SessionSummary, Settings, Task, VersionedSettings } from './types'

/*
 * All state transitions of the renderer. Plain functions (no React): they can be called from any
 * view, from event handlers and during startup, and their effect does not depend on which view is
 * mounted. Long-running work is always owned by the runtime; the renderer only reflects it.
 */

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function notify(message: string, kind: Toast['kind'] = 'info') {
  const id = Date.now() + Math.random()
  toastStore.set((state) => ({ toasts: [...state.toasts.slice(-4), { id, kind, message }] }))
  window.setTimeout(() => toastStore.set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })), kind === 'error' ? 9000 : 4500)
}

// ---------------------------------------------------------------------------
// Settings (versioned: responses that arrive out of order never roll a newer state back)
// ---------------------------------------------------------------------------

function applySettings(next: VersionedSettings) {
  const current = appStore.get().settings
  if (current && typeof next.version === 'number' && next.version < current.version) return
  appStore.set({ settings: next })
  // last known settings: lets the next start show the workspace before the runtime is ready
  persistence.saveDocument('settings-cache', next)
}

export async function loadSettings() {
  applySettings(await api.get<VersionedSettings>('/settings'))
}

export async function updateSettings(patch: Partial<Settings>) {
  const before = appStore.get().settings
  if (before && Object.keys(patch).length) appStore.set({ settings: { ...before, ...patch } })
  try {
    applySettings(await api.patch<VersionedSettings>('/settings', patch))
  } catch (error) {
    await loadSettings().catch(() => undefined)
    notify(errorMessage(error), 'error')
    throw error
  }
}

// ---------------------------------------------------------------------------
// Window layout and per-project work state
// ---------------------------------------------------------------------------

export function setSideView(sideView: SideView) {
  appStore.set((state) => ({ ui: { ...state.ui, sideView, sideOpen: true } }))
}

/** Activity bar click: clicking the view that is already shown collapses the side panel. */
export function toggleSideView(sideView: SideView) {
  appStore.set((state) => ({ ui: { ...state.ui, sideView, sideOpen: !(state.ui.sideOpen && state.ui.sideView === sideView) } }))
}

export function setBottomTab(bottomTab: BottomTab) {
  appStore.set((state) => ({ ui: { ...state.ui, bottomTab } }))
}

export function setBottomOpen(bottomOpen: boolean) {
  appStore.set((state) => ({ ui: { ...state.ui, bottomOpen, bottomMaximized: bottomOpen && state.ui.bottomMaximized } }))
}

export function setLayout(patch: Partial<Pick<UiState, 'sideOpen' | 'chatOpen' | 'bottomMaximized' | 'chatWidth' | 'bottomHeight'>>) {
  appStore.set((state) => ({ ui: { ...state.ui, ...patch } }))
}

export function setSideWidth(view: SideView, width: number | undefined) {
  appStore.set((state) => ({ ui: { ...state.ui, sideWidths: { ...state.ui.sideWidths, [view]: width } } }))
}

export function toggleBottomMaximized() {
  appStore.set((state) => ({ ui: { ...state.ui, bottomOpen: true, bottomMaximized: !state.ui.bottomMaximized } }))
}

export function setTheme(theme: Theme) {
  appStore.set((state) => ({ ui: { ...state.ui, theme } }))
  document.documentElement.dataset.theme = theme
}

export function updateWorkspace(patch: Partial<WorkspaceState> | ((workspace: WorkspaceState) => Partial<WorkspaceState>)) {
  appStore.set((state) => ({ workspace: { ...state.workspace, ...(typeof patch === 'function' ? patch(state.workspace) : patch) } }))
}

export function composerKey(sessionId?: string) {
  return sessionId ?? 'new'
}

/** The composer writes typing with a short delay; actions that extend the draft flush it first. */
let composerFlush: (() => void) | undefined
export function registerComposerFlush(flush: (() => void) | undefined) {
  composerFlush = flush
}
export function flushComposer() {
  composerFlush?.()
}

export function setComposerDraft(sessionId: string | undefined, patch: Partial<ComposerDraft>) {
  const key = composerKey(sessionId)
  updateWorkspace((workspace) => {
    const current = workspace.composer[key] ?? { text: '', mode: 'task' as const, autoRun: false }
    return { composer: { ...workspace.composer, [key]: { ...current, ...patch } } }
  })
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function openProjectPath(folder: string) {
  const opened = await api.post<Project>('/projects/open', { path: folder })
  await activateProject(opened)
  setSideView('explorer')
}

/** Selecting the project that is already open keeps all of its state (tabs, session, terminals). */
export async function selectProject(project: Project) {
  const current = appStore.get().project
  const opened = await api.post<Project>('/projects/open', { path: project.repoPath, name: project.name })
  if (current?.id === opened.id) {
    appStore.set({ project: { ...current, ...opened } })
    return
  }
  await activateProject(opened)
}

/** Switches the workspace to a project and restores its persisted work state. */
export async function activateProject(project: Project, options: { onShown?: () => void } = {}) {
  const previous = appStore.get().project
  if (previous && previous.id !== project.id) {
    await persistence.flushNow()
    models.disposeProject(previous.id)
  }
  const { workspace, raw } = await persistence.loadWorkspace(project.id)
  appStore.set((state) => ({ project, workspace, ui: { ...state.ui, lastProjectId: project.id, lastProject: { id: project.id, name: project.name, repoPath: project.repoPath } } }))
  sessionStore.set({ list: [], listLoaded: false, active: undefined, task: undefined, execution: undefined, events: [], selectedSubtaskId: undefined })
  liveStore.set({ executionId: undefined, lines: [] })
  // The project is known: the IDE can be shown while tabs, sessions and terminals load.
  options.onShown?.()
  await Promise.all([restoreTabs(project.id, raw), loadSessions(), refreshTerminals()])
  const sessions = sessionStore.get().list
  // null = the user deliberately started a new (not yet created) session; absent = never chosen
  const target = raw.activeSessionId === null ? undefined : sessions.some((session) => session.id === workspace.activeSessionId) ? workspace.activeSessionId : sessions[0]?.id
  await selectSession(target)
  await ensureDefaultTerminal()
}

// ---------------------------------------------------------------------------
// Editor tabs
// ---------------------------------------------------------------------------

export const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less', html: 'html', yml: 'yaml', yaml: 'yaml', py: 'python', go: 'go', rs: 'rust',
  java: 'java', cs: 'csharp', sql: 'sql', prisma: 'plaintext', sh: 'shell', ps1: 'powershell', xml: 'xml', toml: 'ini', vue: 'html', svelte: 'html',
}

export function languageFor(file: string): string {
  const extension = file.split('.').pop()?.toLowerCase() ?? ''
  if (file.endsWith('Dockerfile')) return 'dockerfile'
  return LANGUAGES[extension] ?? 'plaintext'
}

const fileTabId = (path: string) => `file:${path}`

interface PersistedTab {
  id: string
  kind: 'file' | 'diff'
  path: string
  title: string
  source?: DiffSource
}

persistence.registerWorkspaceExtra((projectId) => {
  const { tabs, activeTabId } = editorStore.get()
  const persisted: PersistedTab[] = tabs.filter((tab) => tab.kind === 'file' || tab.source).map((tab) => ({ id: tab.id, kind: tab.kind, path: tab.path, title: tab.title, source: tab.source }))
  return { tabs: persisted, activeTabId, viewStates: models.viewStates(projectId) }
})
persistence.registerBeforeFlush(() => models.flushDrafts())
models.setDirtyListener((tabId, dirty) => updateTab(tabId, { dirty }))

let lastTabs = editorStore.get().tabs
let lastActive = editorStore.get().activeTabId
editorStore.subscribe(() => {
  const state = editorStore.get()
  if (state.restoring || (state.tabs === lastTabs && state.activeTabId === lastActive)) return
  // Only structural changes are persisted (dirty flags change on every first keystroke).
  const structural = state.activeTabId !== lastActive || state.tabs.length !== lastTabs.length || state.tabs.some((tab, index) => tab.id !== lastTabs[index]?.id)
  lastTabs = state.tabs
  lastActive = state.activeTabId
  if (structural) persistence.touchWorkspace()
})

async function loadFileTab(projectId: string, path: string, draft?: DraftEntry, viewState?: unknown): Promise<EditorTab | undefined> {
  const id = fileTabId(path)
  const title = path.split('/').pop() ?? path
  let file: FileContent | undefined
  try {
    file = await api.get<FileContent>(`/projects/${projectId}/file?path=${enc(path)}`)
  } catch {
    file = undefined
  }
  if (!file && !draft) return undefined
  const readOnly = Boolean(file && (file.binary || file.tooLarge))
  const content = !file ? '' : file.binary ? '// Binärdatei – nicht im Editor darstellbar' : file.tooLarge ? '// Datei ist zu groß für den Editor' : file.content
  const state = await models.openModel({ tabId: id, projectId, path, language: languageFor(path), content, mtimeMs: file?.mtimeMs, readOnly, draft, viewState })
  // A draft for a file that no longer exists on disk is kept and shown as a conflict.
  return { id, kind: 'file', path, title, dirty: state.dirty, readOnly, externalChange: state.externalChange || (!file && Boolean(draft)), language: languageFor(path), mtimeMs: file?.mtimeMs }
}

async function loadDiffTab(saved: PersistedTab): Promise<EditorTab | undefined> {
  const project = appStore.get().project
  if (!saved.source || !project) return undefined
  try {
    if (saved.source.type === 'execution') {
      const run = await api.get<ExecutionRun>(`/executions/${saved.source.executionId}`)
      if (!run.finalDiff) return undefined
      return { ...saved, kind: 'diff', dirty: false, readOnly: true, original: '', content: run.finalDiff, language: 'diff' }
    }
    if (saved.source.type === 'git-head') {
      const [head, current] = await Promise.all([
        api.get<{ content: string | null }>(`/projects/${project.id}/git/head-file?path=${enc(saved.source.path)}`),
        api.get<FileContent>(`/projects/${project.id}/file?path=${enc(saved.source.path)}`).catch(() => ({ content: '' })),
      ])
      return { ...saved, kind: 'diff', dirty: false, readOnly: true, original: head.content ?? '', content: current.content, language: languageFor(saved.source.path) }
    }
    const source = saved.source
    const task = await api.get<Task>(`/tasks/${source.taskId}`)
    const patch = task.subtasks.find((subtask) => subtask.id === source.subtaskId)?.patchText
    return patch ? { ...saved, kind: 'diff', dirty: false, readOnly: true, original: '', content: patch, language: 'diff' } : undefined
  } catch {
    return undefined
  }
}

/** Restores the tabs of a project: file contents from disk, unsaved edits from drafts, diffs from their source. */
async function restoreTabs(projectId: string, raw: Record<string, unknown>) {
  editorStore.set({ tabs: [], activeTabId: undefined, restoring: true })
  try {
    const saved = (Array.isArray(raw.tabs) ? raw.tabs : []) as PersistedTab[]
    const viewStates = (raw.viewStates && typeof raw.viewStates === 'object' ? raw.viewStates : {}) as Record<string, unknown>
    const drafts = await bridge().drafts.list(projectId).catch(() => [] as DraftEntry[])
    const fileTabs = saved.filter((tab) => tab.kind === 'file' && typeof tab.path === 'string')
    const orphanDrafts = drafts.filter((draft) => !fileTabs.some((tab) => tab.path === draft.path))
    const loaded = await Promise.all([
      ...saved.map((tab) => (tab.kind === 'file' ? loadFileTab(projectId, tab.path, drafts.find((draft) => draft.path === tab.path), viewStates[tab.id]) : loadDiffTab(tab))),
      // Unsaved edits whose tab is gone (e.g. closed by a crash) come back as tabs.
      ...orphanDrafts.map((draft) => loadFileTab(projectId, draft.path, draft)),
    ])
    if (appStore.get().project?.id !== projectId) return
    const tabs = loaded.filter((tab): tab is EditorTab => Boolean(tab))
    const activeTabId = typeof raw.activeTabId === 'string' && tabs.some((tab) => tab.id === raw.activeTabId) ? raw.activeTabId : tabs.at(-1)?.id
    lastTabs = tabs
    lastActive = activeTabId
    editorStore.set({ tabs, activeTabId })
    if (orphanDrafts.length) notify(`${orphanDrafts.length} nicht gespeicherte Datei(en) wiederhergestellt.`, 'info')
  } finally {
    editorStore.set({ restoring: false })
  }
}

export function updateTab(id: string, patch: Partial<EditorTab>) {
  editorStore.set((state) => ({ tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) }))
}

export function setActiveTab(id: string) {
  editorStore.set({ activeTabId: id })
}

export async function openFile(path: string) {
  const project = appStore.get().project
  if (!project) return
  const id = fileTabId(path)
  if (editorStore.get().tabs.some((tab) => tab.id === id)) {
    setActiveTab(id)
    return
  }
  const tab = await loadFileTab(project.id, path)
  if (!tab) {
    notify(`Datei nicht gefunden: ${path}`, 'error')
    return
  }
  if (appStore.get().project?.id !== project.id) return
  editorStore.set((state) => ({ tabs: state.tabs.some((existing) => existing.id === id) ? state.tabs : [...state.tabs, tab], activeTabId: id }))
}

export function openDiff(input: { title: string; path: string; original: string; modified: string; source?: DiffSource }) {
  const id = `diff:${input.title}:${input.path}`
  const tab: EditorTab = { id, kind: 'diff', path: input.path, title: input.title, content: input.modified, original: input.original, dirty: false, readOnly: true, language: input.path.endsWith('.diff') ? 'diff' : languageFor(input.path), source: input.source }
  editorStore.set((state) => ({ tabs: [...state.tabs.filter((existing) => existing.id !== id), tab], activeTabId: id }))
}

/** Closes a tab. A tab with unsaved changes is only closed with force (after the user confirmed). */
export function closeTab(id: string, force = false): 'closed' | 'needs_confirmation' {
  const tab = editorStore.get().tabs.find((entry) => entry.id === id)
  if (!tab) return 'closed'
  if (tab.kind === 'file' && models.isDirty(id) && !force) return 'needs_confirmation'
  if (tab.kind === 'file') models.disposeModel(id)
  editorStore.set((state) => {
    const index = state.tabs.findIndex((entry) => entry.id === id)
    const tabs = state.tabs.filter((entry) => entry.id !== id)
    return { tabs, activeTabId: state.activeTabId === id ? tabs[Math.max(0, index - 1)]?.id : state.activeTabId, splitTabId: state.splitTabId === id ? undefined : state.splitTabId }
  })
  return 'closed'
}

export async function saveTab(id: string, force = false) {
  const project = appStore.get().project
  const tab = editorStore.get().tabs.find((entry) => entry.id === id)
  if (!tab || tab.kind !== 'file' || tab.readOnly || !project) return
  const content = models.contentOf(id)
  if (content === undefined) return
  try {
    const result = await api.put<{ mtimeMs: number }>(`/projects/${project.id}/file`, { path: tab.path, content, expectedMtimeMs: force ? undefined : models.baseMtime(id) })
    models.markSaved(id, result.mtimeMs)
    updateTab(id, { dirty: models.isDirty(id), mtimeMs: result.mtimeMs, externalChange: false })
  } catch (error) {
    if ((error as ApiError).status === 409) updateTab(id, { externalChange: true })
    notify(errorMessage(error), 'error')
  }
}

export async function reloadTabFromDisk(id: string) {
  const project = appStore.get().project
  const tab = editorStore.get().tabs.find((entry) => entry.id === id)
  if (!project || !tab) return
  const file = await api.get<FileContent>(`/projects/${project.id}/file?path=${enc(tab.path)}`)
  models.replaceWithDisk(id, file.content, file.mtimeMs)
  updateTab(id, { dirty: false, externalChange: false, mtimeMs: file.mtimeMs })
}

/** Files changed on disk (agents, git, external editors): clean tabs follow, dirty tabs are flagged. */
export function onFilesChanged(projectId: string, files: string[]) {
  if (appStore.get().project?.id !== projectId) return
  const changed = new Set(files)
  for (const tab of editorStore.get().tabs) {
    if (tab.kind !== 'file' || !changed.has(tab.path)) continue
    void api
      .get<FileContent>(`/projects/${projectId}/file?path=${enc(tab.path)}`)
      .then((file) => {
        if (Math.abs(file.mtimeMs - (models.baseMtime(tab.id) ?? 0)) < 1) return
        if (models.isDirty(tab.id)) updateTab(tab.id, { externalChange: true })
        else {
          models.replaceWithDisk(tab.id, file.content, file.mtimeMs)
          updateTab(tab.id, { mtimeMs: file.mtimeMs, externalChange: false })
        }
      })
      .catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function loadSessions() {
  const project = appStore.get().project
  if (!project) return
  const list = await api.get<SessionSummary[]>(`/projects/${project.id}/sessions${sessionStore.get().includeArchived ? '?archived=1' : ''}`).catch(() => undefined)
  if (list && appStore.get().project?.id === project.id) sessionStore.set({ list, listLoaded: true })
}

export function setIncludeArchived(includeArchived: boolean) {
  sessionStore.set({ includeArchived })
  void loadSessions()
}

export function upsertSessionSummary(summary: Partial<SessionSummary> & { id: string }) {
  sessionStore.set((state) => {
    const exists = state.list.some((entry) => entry.id === summary.id)
    const list = exists ? state.list.map((entry) => (entry.id === summary.id ? { ...entry, ...summary } : entry)) : [summary as SessionSummary, ...state.list]
    return { list: [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()), active: state.active?.id === summary.id ? { ...state.active, ...summary } : state.active }
  })
}

/** Shows a session. Nothing is cancelled or reset by switching: the runtime keeps running its work. */
export async function selectSession(sessionId: string | undefined) {
  if (appStore.get().workspace.activeSessionId !== sessionId) updateWorkspace({ activeSessionId: sessionId })
  if (sessionStore.get().active?.id !== sessionId) sessionStore.set({ active: undefined, task: undefined, execution: undefined, events: [], selectedSubtaskId: undefined, older: undefined })
  if (!sessionId) return
  await reloadActiveSession()
}

/** Loads the next older page of the active chat (100 messages) in front of the loaded ones. */
export async function loadOlderMessages() {
  const { active, older } = sessionStore.get()
  if (!active) return
  const current = older?.sessionId === active.id ? older : undefined
  const oldest = current?.messages[0] ?? active.messages[0]
  if (!oldest) return
  const page = await api.get<SessionDetail>(`/sessions/${active.id}/messages?before=${encodeURIComponent(oldest.createdAt)}&limit=100`)
  if (sessionStore.get().active?.id !== active.id) return
  sessionStore.set({ older: { sessionId: active.id, messages: [...page.messages, ...(current?.messages ?? [])], hasMore: page.hasMore } })
}

export async function reloadActiveSession() {
  const sessionId = appStore.get().workspace.activeSessionId
  if (!sessionId) return
  let detail: SessionDetail
  try {
    detail = await api.get<SessionDetail>(`/sessions/${sessionId}`)
  } catch (error) {
    if ((error as ApiError).status === 404) {
      updateWorkspace({ activeSessionId: undefined })
      sessionStore.set({ active: undefined, task: undefined, execution: undefined })
    }
    return
  }
  if (appStore.get().workspace.activeSessionId !== sessionId) return // switched meanwhile
  const persistedClientIds = new Set(detail.messages.map((message) => message.clientId).filter(Boolean))
  sessionStore.set((state) => ({ active: detail, pending: state.pending.filter((message) => !persistedClientIds.has(message.clientId)) }))
  upsertSessionSummary(detail)
  if (detail.activeTaskId) await reloadTask()
  else sessionStore.set({ task: undefined, execution: undefined, events: [] })
}

export async function reloadTask() {
  const taskId = sessionStore.get().active?.activeTaskId
  if (!taskId) return
  const task = await api.get<Task>(`/tasks/${taskId}`).catch(() => undefined)
  if (!task || sessionStore.get().active?.activeTaskId !== taskId) return
  sessionStore.set({ task })
  const latest = task.executions?.[0]
  if (latest?.id !== sessionStore.get().execution?.id || !latest) await reloadExecution(latest?.id)
}

export async function reloadExecution(executionId: string | undefined = sessionStore.get().execution?.id) {
  if (!executionId) {
    sessionStore.set({ execution: undefined, events: [] })
    return
  }
  // events: all of them (long runs have 10,000+), incrementally behind the ones already loaded
  const known = sessionStore.get().execution?.id === executionId ? sessionStore.get().events : []
  const result = await Promise.all([api.get<ExecutionRun>(`/executions/${executionId}`), loadEvents(executionId, known)]).catch(() => undefined)
  if (!result) return
  const task = sessionStore.get().task
  if (task && task.executions?.[0] && task.executions[0].id !== executionId) return // a newer run was selected meanwhile
  sessionStore.set({ execution: result[0], events: result[1] })
  if (liveStore.get().executionId !== executionId) liveStore.set({ executionId, lines: [] })
}

async function loadEvents(executionId: string, known: RunEvent[]): Promise<RunEvent[]> {
  let events = known
  for (let page = 0; page < 10 && events.length < 20_000; page++) {
    const last = events.at(-1)
    const batch = await api.get<RunEvent[]>(`/executions/${executionId}/events?limit=2000${last ? `&after=${encodeURIComponent(last.createdAt)}&afterId=${encodeURIComponent(last.id)}` : ''}`)
    if (batch.length) events = [...events, ...batch]
    if (batch.length < 2000) break
  }
  return events
}

export function setSelectedSubtask(subtaskId: string | undefined) {
  sessionStore.set({ selectedSubtaskId: subtaskId })
}

/** All execution entry points lead to the same session workflow, including a hidden chat panel. */
export async function openWorkflow(sessionId?: string) {
  if (sessionId && appStore.get().workspace.activeSessionId !== sessionId) await selectSession(sessionId)
  setLayout({ chatOpen: true })
  updateWorkspace({ chatView: 'workflow' })
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="workflow"]')?.focus({ preventScroll: true }))
}

function newClientId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
}

/**
 * Sends a chat message. It appears immediately as "pending"; it counts as sent only once the runtime
 * confirmed that it is stored. A failed send keeps the text and can be retried with the same
 * idempotency key, so a retry after a reload never creates a duplicate task or run.
 */
export async function sendMessage(content: string, mode: 'task' | 'ask', autoRun: boolean) {
  const project = appStore.get().project
  if (!project || !content.trim()) return
  updateWorkspace({ chatView: mode === 'task' ? 'workflow' : 'history' })
  const clientId = newClientId()
  const sessionId = appStore.get().workspace.activeSessionId
  sessionStore.set((state) => ({ pending: [...state.pending, { clientId, sessionId, content, mode, status: 'sending', createdAt: new Date().toISOString() }] }))
  setComposerDraft(sessionId, { text: '' })
  await deliver(clientId, { content, mode, autoRun, projectId: project.id })
}

async function deliver(clientId: string, input: { content: string; mode: 'task' | 'ask'; autoRun: boolean; projectId: string }) {
  const setPending = (patch: Partial<{ sessionId: string; status: 'sending' | 'failed'; error: string }>) =>
    sessionStore.set((state) => ({ pending: state.pending.map((message) => (message.clientId === clientId ? { ...message, ...patch } : message)) }))
  try {
    let sessionId = sessionStore.get().pending.find((message) => message.clientId === clientId)?.sessionId
    if (!sessionId) {
      const created = await api.post<SessionSummary>(`/projects/${input.projectId}/sessions`, {})
      sessionId = created.id
      setPending({ sessionId })
      upsertSessionSummary(created)
      if (appStore.get().project?.id === input.projectId && !appStore.get().workspace.activeSessionId) {
        // carry the "new session" composer settings over to the created session
        updateWorkspace((workspace) => {
          const { new: fresh, ...rest } = workspace.composer
          return { activeSessionId: sessionId, composer: fresh ? { ...rest, [sessionId!]: fresh } : rest }
        })
        sessionStore.set({ active: undefined, task: undefined, execution: undefined, events: [] })
      }
    }
    const result = await api.post<{ session: SessionSummary; duplicate: boolean }>(`/sessions/${sessionId}/messages`, { content: input.content, mode: input.mode, autoRun: input.autoRun, clientId })
    upsertSessionSummary(result.session)
    if (appStore.get().workspace.activeSessionId === sessionId) await reloadActiveSession()
    sessionStore.set((state) => ({ pending: state.pending.filter((message) => message.clientId !== clientId) }))
    void loadActivity()
  } catch (error) {
    setPending({ status: 'failed', error: errorMessage(error) })
    notify(`Nachricht nicht gesendet: ${errorMessage(error)}`, 'error')
  }
}

export async function retryPending(clientId: string) {
  const project = appStore.get().project
  const message = sessionStore.get().pending.find((entry) => entry.clientId === clientId)
  if (!message || !project) return
  sessionStore.set((state) => ({ pending: state.pending.map((entry) => (entry.clientId === clientId ? { ...entry, status: 'sending', error: undefined } : entry)) }))
  await deliver(clientId, { content: message.content, mode: message.mode, autoRun: false, projectId: project.id })
}

export function discardPending(clientId: string) {
  const message = sessionStore.get().pending.find((entry) => entry.clientId === clientId)
  sessionStore.set((state) => ({ pending: state.pending.filter((entry) => entry.clientId !== clientId) }))
  if (message && !appStore.get().workspace.composer[composerKey(message.sessionId)]?.text) setComposerDraft(message.sessionId, { text: message.content })
}

export function newSession() {
  updateWorkspace({ chatView: 'workflow' })
  void selectSession(undefined)
}

export async function updateSession(sessionId: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) {
  const summary = await api.patch<SessionSummary>(`/sessions/${sessionId}`, patch)
  upsertSessionSummary(summary)
  if (patch.archived !== undefined && !sessionStore.get().includeArchived) {
    sessionStore.set((state) => ({ list: state.list.filter((entry) => !entry.archivedAt) }))
    if (patch.archived && appStore.get().workspace.activeSessionId === sessionId) await selectSession(undefined)
  }
}

export async function deleteSession(sessionId: string) {
  await api.del(`/sessions/${sessionId}`)
  sessionStore.set((state) => ({ list: state.list.filter((entry) => entry.id !== sessionId) }))
  if (appStore.get().workspace.activeSessionId === sessionId) await selectSession(undefined)
}

export async function exportSession(sessionId: string, format: 'md' | 'json') {
  const file = await api.get<{ fileName: string; content: string }>(`/sessions/${sessionId}/export?format=${format}`)
  const saved = await bridge().dialog.saveText(file.fileName, file.content)
  if (saved) notify(`Exportiert: ${saved}`, 'success')
}

export async function retryPlan(sessionId: string) {
  upsertSessionSummary(await api.post<SessionSummary>(`/sessions/${sessionId}/retry-plan`, {}))
  await reloadActiveSession()
}

// ---------------------------------------------------------------------------
// Activity (work running in the runtime) and model downloads
// ---------------------------------------------------------------------------

export async function loadActivity() {
  const activity = await api.get<Activity>('/activity').catch(() => undefined)
  if (activity) appStore.set({ activity })
}

export async function loadModelJobs() {
  const jobs = await api.get<Array<{ payload: { model?: string }; status: string; progress: { percent?: number; status?: string } | null }>>('/system/jobs?type=model.pull&active=1').catch(() => [])
  const pulls: Record<string, { percent?: number; status: string }> = {}
  for (const job of jobs) if (job.payload.model) pulls[job.payload.model] = { percent: job.progress?.percent, status: job.progress?.status ?? (job.status === 'queued' ? 'wartet' : 'läuft') }
  jobsStore.set((state) => ({ pulls: { ...Object.fromEntries(Object.entries(state.pulls).filter(([, value]) => value.percent === 100)), ...pulls } }))
}

// ---------------------------------------------------------------------------
// Terminals (processes live in the main process)
// ---------------------------------------------------------------------------

export async function refreshTerminals() {
  const list = await bridge().terminal.list().catch(() => undefined)
  if (list) terminalStore.set({ list })
}

export function projectTerminals() {
  const project = appStore.get().project
  return terminalStore.get().list.filter((terminal) => !project || !terminal.projectId || terminal.projectId === project.id)
}

export async function createTerminal(options: { command?: string[]; title?: string; replaces?: string } = {}) {
  const project = appStore.get().project
  try {
    const info = await bridge().terminal.create({ cols: 100, rows: 24, cwd: project?.repoPath, command: options.command, title: options.title, projectId: project?.id, replaces: options.replaces })
    await refreshTerminals()
    updateWorkspace({ activeTerminalId: info.id })
    return info
  } catch (error) {
    notify(errorMessage(error), 'error')
    return undefined
  }
}

export async function closeTerminal(id: string) {
  await bridge().terminal.kill(id).catch(() => undefined)
  await refreshTerminals()
  if (appStore.get().workspace.activeTerminalId === id) updateWorkspace({ activeTerminalId: projectTerminals()[0]?.id })
}

async function ensureDefaultTerminal() {
  if (!projectTerminals().length) await createTerminal()
  else if (!projectTerminals().some((terminal) => terminal.id === appStore.get().workspace.activeTerminalId)) updateWorkspace({ activeTerminalId: projectTerminals()[0]?.id })
}

/** Starts a terminal that runs an allowlisted command (official login/install commands). */
export async function runInTerminal(command: string[], title: string) {
  await createTerminal({ command, title })
  setBottomTab('terminal')
  setBottomOpen(true)
}
