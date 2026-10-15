import type { FlushPayload } from '../../shared/bridge'
import { bridge } from './api'
import { appStore, EMPTY_WORKSPACE, type UiState, type WorkspaceState } from './stores'

/**
 * Write-behind persistence of UI work state into the main process (state-store.ts).
 * - Changes are debounced (no write per keystroke) and coalesced per document.
 * - Writes carry this page's epoch; after a reload, writes still in flight from the old page are
 *   rejected by the main process.
 * - On reload/close (beforeunload) and on app quit (flush request) everything pending is written
 *   synchronously.
 */

export const epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const DEBOUNCE_MS = 300
const pendingDocs = new Map<string, unknown>()
const pendingDrafts = new Map<string, { projectKey: string; path: string; entry: { path: string; content: string; baseMtimeMs?: number } | null }>()
let timer: number | undefined
let started = false

/** Extra per-project data contributed by other modules (editor tabs and view states). */
type WorkspaceExtra = (projectId: string) => Record<string, unknown>
const extras: WorkspaceExtra[] = []

export function registerWorkspaceExtra(extra: WorkspaceExtra) {
  extras.push(extra)
}

/** Hooks that push their own debounced state (e.g. editor drafts) into the queue before a flush. */
const beforeFlush: Array<() => void> = []
export function registerBeforeFlush(hook: () => void) {
  beforeFlush.push(hook)
}

export function workspaceKey(projectId: string) {
  return `workspace:${projectId}`
}

function schedule() {
  if (timer !== undefined) return
  timer = window.setTimeout(() => {
    timer = undefined
    void flush()
  }, DEBOUNCE_MS)
}

export function saveDocument(key: string, data: unknown) {
  pendingDocs.set(key, data)
  schedule()
}

export function saveDraft(projectKey: string, path: string, content: string, baseMtimeMs?: number) {
  pendingDrafts.set(`${projectKey}\u0000${path}`, { projectKey, path, entry: { path, content, baseMtimeMs } })
  schedule()
}

export function deleteDraft(projectKey: string, path: string) {
  pendingDrafts.set(`${projectKey}\u0000${path}`, { projectKey, path, entry: null })
  schedule()
}

async function flush() {
  const docs = [...pendingDocs.entries()]
  pendingDocs.clear()
  const drafts = [...pendingDrafts.values()]
  pendingDrafts.clear()
  for (const [key, data] of docs) {
    const result = await bridge().state.set(key, data, epoch).catch(() => undefined)
    if (!result) pendingDocs.set(key, data) // IPC failure: keep and retry
  }
  for (const draft of drafts) {
    const result = await (draft.entry ? bridge().drafts.put(draft.projectKey, draft.entry, epoch) : bridge().drafts.delete(draft.projectKey, draft.path, epoch)).catch(() => undefined)
    if (!result) pendingDrafts.set(`${draft.projectKey}\u0000${draft.path}`, draft)
  }
  if (pendingDocs.size || pendingDrafts.size) schedule()
}

/** Captures and writes the current state now (e.g. before switching to another project). */
export async function flushNow() {
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
  captureAll()
  await flush()
}

/** Writes everything pending synchronously (page unload, app quit). */
export function flushSync() {
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
  captureAll()
  if (!pendingDocs.size && !pendingDrafts.size) return
  const payload: FlushPayload = {
    epoch,
    writes: [...pendingDocs.entries()].map(([key, data]) => ({ key, data })),
    drafts: [...pendingDrafts.values()].map((draft) => ({ projectKey: draft.projectKey, entry: draft.entry, path: draft.path })),
  }
  pendingDocs.clear()
  pendingDrafts.clear()
  try {
    bridge().state.flushSync(payload)
  } catch {
    // window is going away; nothing else can be done
  }
}

// --- snapshots of the stores --------------------------------------------------

function uiSnapshot(): UiState {
  return appStore.get().ui
}

function workspaceSnapshot(projectId: string): Record<string, unknown> {
  const workspace = appStore.get().workspace
  const data: Record<string, unknown> = { ...workspace, activeSessionId: workspace.activeSessionId ?? null }
  for (const extra of extras) Object.assign(data, extra(projectId))
  return data
}

let lastUi: UiState | undefined
let lastWorkspace: WorkspaceState | undefined

/** Queues the current UI and workspace documents (called on store changes and before unload). */
export function captureAll() {
  for (const hook of beforeFlush) hook()
  if (!started) return
  const state = appStore.get()
  saveDocumentNow('ui', uiSnapshot())
  if (state.project) saveDocumentNow(workspaceKey(state.project.id), workspaceSnapshot(state.project.id))
}

function saveDocumentNow(key: string, data: unknown) {
  pendingDocs.set(key, data)
}

/** Requests a workspace save (e.g. after the editor tabs changed). */
export function touchWorkspace() {
  const project = appStore.get().project
  if (!started || !project) return
  saveDocument(workspaceKey(project.id), workspaceSnapshot(project.id))
}

export async function loadDocument<T>(key: string): Promise<T | undefined> {
  const doc = await bridge().state.get<T>(key).catch(() => null)
  return doc?.data
}

export async function loadWorkspace(projectId: string): Promise<{ workspace: WorkspaceState; raw: Record<string, unknown> }> {
  const raw = (await loadDocument<Record<string, unknown>>(workspaceKey(projectId))) ?? {}
  const workspace: WorkspaceState = {
    ...EMPTY_WORKSPACE,
    activeSessionId: typeof raw.activeSessionId === 'string' ? raw.activeSessionId : undefined,
      chatView: raw.chatView === 'history' ? 'history' : 'workflow',
    explorer: raw.explorer && typeof raw.explorer === 'object' ? { expanded: Array.isArray((raw.explorer as WorkspaceState['explorer']).expanded) ? (raw.explorer as WorkspaceState['explorer']).expanded : [''], selected: (raw.explorer as WorkspaceState['explorer']).selected } : EMPTY_WORKSPACE.explorer,
    composer: raw.composer && typeof raw.composer === 'object' ? (raw.composer as WorkspaceState['composer']) : {},
    gitMessage: typeof raw.gitMessage === 'string' ? raw.gitMessage : '',
    activeTerminalId: typeof raw.activeTerminalId === 'string' ? raw.activeTerminalId : undefined,
    splitTerminalId: typeof raw.splitTerminalId === 'string' ? raw.splitTerminalId : undefined,
  }
  return { workspace, raw }
}

/** Starts watching the stores (after the persisted state was restored, so defaults never overwrite it). */
export function startPersistence() {
  if (started) return
  started = true
  lastUi = appStore.get().ui
  lastWorkspace = appStore.get().workspace
  // changes made while the workspace was still being restored are written now
  saveDocument('ui', lastUi)
  touchWorkspace()
  appStore.subscribe(() => {
    const state = appStore.get()
    if (state.ui !== lastUi) {
      lastUi = state.ui
      saveDocument('ui', state.ui)
    }
    if (state.workspace !== lastWorkspace) {
      lastWorkspace = state.workspace
      touchWorkspace()
    }
  })
  window.addEventListener('beforeunload', () => flushSync())
  bridge().app.onFlushRequest(() => {
    flushSync()
    bridge().app.flushed()
  })
}

export function isPersistenceStarted() {
  return started
}
