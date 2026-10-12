import type * as Monaco from 'monaco-editor'
import type { DraftEntry } from '../../shared/bridge'
import { deleteDraft, saveDraft } from './persistence'

/**
 * Text models of open file tabs. The editor content lives in Monaco models (not in React state):
 * typing does not re-render the app, switching tabs keeps undo history, cursor and scroll position,
 * and unsaved content is mirrored (debounced) into a draft in the main process, so neither a view
 * switch, a window reload nor a crash loses it.
 */

let monacoPromise: Promise<typeof Monaco> | undefined

/** Monaco is loaded on demand (it is the largest part of the renderer bundle). */
export function loadMonaco(): Promise<typeof Monaco> {
  monacoPromise ??= import('../monaco-setup').then((module) => module.monaco)
  return monacoPromise
}

interface ModelEntry {
  tabId: string
  projectId: string
  path: string
  model: Monaco.editor.ITextModel
  savedVersionId: number
  baseMtimeMs?: number
  readOnly: boolean
  viewState?: Monaco.editor.ICodeEditorViewState | null
  draftTimer?: number
  listener: Monaco.IDisposable
}

const entries = new Map<string, ModelEntry>()
type DirtyListener = (tabId: string, dirty: boolean) => void
let onDirtyChange: DirtyListener = () => undefined

export function setDirtyListener(listener: DirtyListener) {
  onDirtyChange = listener
}

export function modelPath(projectId: string, path: string) {
  // The same string is used as the editor's `path` prop (@monaco-editor/react resolves it via Uri.parse).
  return `file:///${encodeURIComponent(projectId)}/${path.split('/').map(encodeURIComponent).join('/')}`
}

export interface OpenModelInput {
  tabId: string
  projectId: string
  path: string
  language?: string
  content: string
  mtimeMs?: number
  readOnly: boolean
  draft?: DraftEntry
  viewState?: unknown
}

/**
 * Creates (or reuses) the model of a tab. A draft from a previous session is applied on top of the
 * file content; when the file changed on disk since the draft was written, the draft still wins
 * (nothing typed is lost) but the tab is flagged as conflicting.
 */
export async function openModel(input: OpenModelInput): Promise<{ dirty: boolean; externalChange: boolean }> {
  const monaco = await loadMonaco()
  const existing = entries.get(input.tabId)
  if (existing && !existing.model.isDisposed()) return { dirty: isDirty(input.tabId), externalChange: false }
  const uri = monaco.Uri.parse(modelPath(input.projectId, input.path))
  monaco.editor.getModel(uri)?.dispose()
  const model = monaco.editor.createModel(input.content, input.language, uri)
  const entry: ModelEntry = {
    tabId: input.tabId,
    projectId: input.projectId,
    path: input.path,
    model,
    savedVersionId: model.getAlternativeVersionId(),
    baseMtimeMs: input.mtimeMs,
    readOnly: input.readOnly,
    viewState: (input.viewState as Monaco.editor.ICodeEditorViewState | undefined) ?? null,
    listener: model.onDidChangeContent(() => onContentChanged(entry)),
  }
  entries.set(input.tabId, entry)
  let externalChange = false
  if (input.draft && !input.readOnly && input.draft.content !== input.content) {
    model.setValue(input.draft.content)
    externalChange = input.draft.baseMtimeMs !== undefined && input.mtimeMs !== undefined && Math.abs(input.draft.baseMtimeMs - input.mtimeMs) > 1
  } else if (input.draft) {
    deleteDraft(input.projectId, input.path)
  }
  return { dirty: isDirty(input.tabId), externalChange }
}

let lastDirty = new Map<string, boolean>()

function onContentChanged(entry: ModelEntry) {
  const dirty = isDirty(entry.tabId)
  if (lastDirty.get(entry.tabId) !== dirty) {
    lastDirty.set(entry.tabId, dirty)
    onDirtyChange(entry.tabId, dirty)
  }
  if (entry.draftTimer !== undefined) window.clearTimeout(entry.draftTimer)
  entry.draftTimer = window.setTimeout(() => {
    entry.draftTimer = undefined
    writeDraft(entry)
  }, 400)
}

function writeDraft(entry: ModelEntry) {
  if (entry.model.isDisposed() || entry.readOnly) return
  if (isDirty(entry.tabId)) saveDraft(entry.projectId, entry.path, entry.model.getValue(), entry.baseMtimeMs)
  else deleteDraft(entry.projectId, entry.path)
}

/** Writes all pending drafts immediately (before the page unloads). */
export function flushDrafts() {
  for (const entry of entries.values()) {
    if (entry.draftTimer === undefined) continue
    window.clearTimeout(entry.draftTimer)
    entry.draftTimer = undefined
    writeDraft(entry)
  }
}

export function getModel(tabId: string): Monaco.editor.ITextModel | null {
  const entry = entries.get(tabId)
  return entry && !entry.model.isDisposed() ? entry.model : null
}

export function hasModel(tabId: string) {
  const entry = entries.get(tabId)
  return Boolean(entry && !entry.model.isDisposed())
}

export function isDirty(tabId: string): boolean {
  const entry = entries.get(tabId)
  return Boolean(entry && !entry.model.isDisposed() && entry.model.getAlternativeVersionId() !== entry.savedVersionId)
}

export function contentOf(tabId: string): string | undefined {
  const entry = entries.get(tabId)
  return entry && !entry.model.isDisposed() ? entry.model.getValue() : undefined
}

export function baseMtime(tabId: string) {
  return entries.get(tabId)?.baseMtimeMs
}

export function markSaved(tabId: string, mtimeMs: number) {
  const entry = entries.get(tabId)
  if (!entry) return
  entry.savedVersionId = entry.model.getAlternativeVersionId()
  entry.baseMtimeMs = mtimeMs
  if (entry.draftTimer !== undefined) window.clearTimeout(entry.draftTimer)
  entry.draftTimer = undefined
  lastDirty.set(tabId, false)
  deleteDraft(entry.projectId, entry.path)
}

/** Replaces the content with the version on disk (clean tab, or the user chose "reload"). */
export function replaceWithDisk(tabId: string, content: string, mtimeMs: number) {
  const entry = entries.get(tabId)
  if (!entry || entry.model.isDisposed()) return
  if (entry.model.getValue() !== content) entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: content }], () => null)
  markSaved(tabId, mtimeMs)
  onDirtyChange(tabId, false)
}

export function setViewState(tabId: string, viewState: Monaco.editor.ICodeEditorViewState | null) {
  const entry = entries.get(tabId)
  if (entry) entry.viewState = viewState
}

export function viewStateOf(tabId: string) {
  return entries.get(tabId)?.viewState ?? null
}

export function viewStates(projectId: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const entry of entries.values()) if (entry.projectId === projectId && entry.viewState) result[entry.tabId] = entry.viewState
  return result
}

export function disposeModel(tabId: string, options: { keepDraft?: boolean } = {}) {
  const entry = entries.get(tabId)
  if (!entry) return
  if (entry.draftTimer !== undefined) window.clearTimeout(entry.draftTimer)
  if (!options.keepDraft) deleteDraft(entry.projectId, entry.path)
  entry.listener.dispose()
  entry.model.dispose()
  entries.delete(tabId)
  lastDirty.delete(tabId)
}

/** Disposes all models of a project (switching projects); drafts of dirty files are written first. */
export function disposeProject(projectId: string) {
  flushDrafts()
  for (const entry of [...entries.values()]) if (entry.projectId === projectId) disposeModel(entry.tabId, { keepDraft: true })
  lastDirty = new Map([...lastDirty].filter(([tabId]) => entries.has(tabId)))
}
