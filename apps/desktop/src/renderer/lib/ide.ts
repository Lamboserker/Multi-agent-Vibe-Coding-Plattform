import * as actions from './actions'
import { api, enc, errorMessage } from './api'
import * as models from './editor-models'
import { appStore, dialogStore, editorStore, problemsStore, searchStore, type ProblemEntry } from './stores'

/** IDE actions shared by the command palette, the search view, editor commands and shortcuts. */

const projectId = () => appStore.get().project?.id

export const fileTabId = (file: string) => `file:${file}`

/** Opens a file and moves the cursor (after the tab is shown). */
export async function openFileAt(file: string, range?: models.TextRange) {
  await actions.openFile(file)
  if (range) models.requestReveal(fileTabId(file), range)
}

export interface FileEdits {
  path: string
  edits: Array<{ line: number; column: number; endLine: number; endColumn: number; text: string }>
}

/**
 * Applies edits to several files: open tabs are edited in the editor (undoable, unsaved changes kept),
 * closed files are rewritten on disk (the previous version goes to the local history).
 */
export async function applyFileEdits(files: FileEdits[], reason: 'rename' | 'replace' = 'rename') {
  const id = projectId()
  if (!id) return { editor: 0, disk: 0 }
  let editor = 0
  let disk = 0
  for (const file of files) {
    const edits = file.edits.map((edit) => ({ range: { line: edit.line, column: edit.column, endLine: edit.endLine, endColumn: edit.endColumn }, text: edit.text }))
    if (models.applyEdits(fileTabId(file.path), edits)) {
      editor += 1
      continue
    }
    const current = await api.get<{ content: string; mtimeMs: number }>(`/projects/${id}/file?path=${enc(file.path)}`)
    await api.put(`/projects/${id}/file`, { path: file.path, content: models.applyEditsToText(current.content, edits), expectedMtimeMs: current.mtimeMs, reason })
    disk += 1
  }
  return { editor, disk }
}

// ---------------------------------------------------------------------------
// Search / replace
// ---------------------------------------------------------------------------

function searchBody() {
  const state = searchStore.get()
  return { query: state.query, regex: state.regex, caseSensitive: state.caseSensitive, wholeWord: state.wholeWord, include: state.include, exclude: state.exclude }
}

export async function runSearch() {
  const id = projectId()
  const state = searchStore.get()
  if (!id || !state.query) {
    searchStore.set({ results: undefined, error: undefined })
    return
  }
  searchStore.set({ loading: true, error: undefined, references: undefined })
  try {
    const results = await api.post<NonNullable<typeof state.results>>(`/projects/${id}/ide/search`, searchBody())
    // a newer query superseded this one
    if (searchStore.get().query === state.query) searchStore.set({ results })
  } catch (error) {
    searchStore.set({ error: errorMessage(error), results: undefined })
  } finally {
    searchStore.set({ loading: false })
  }
}

/** Builds the same pattern as the runtime (for replacing inside open editors). */
function pattern() {
  const state = searchStore.get()
  let source = state.regex ? state.query : state.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (state.wholeWord) source = `\\b${source}\\b`
  return new RegExp(source, state.caseSensitive ? 'g' : 'gi')
}

/** Replaces in the given files (all result files by default). Open files are changed in the editor. */
export async function replaceAll(files?: string[]) {
  const id = projectId()
  const state = searchStore.get()
  if (!id || !state.results) return { files: 0, replacements: 0 }
  const targets = files ?? state.results.files.map((file) => file.path)
  const regex = pattern()
  const closed: string[] = []
  let replacements = 0
  let changedFiles = 0
  for (const file of targets) {
    const tabId = fileTabId(file)
    const content = models.contentOf(tabId)
    if (content === undefined) {
      closed.push(file)
      continue
    }
    let count = 0
    const next = content.replace(regex, (...args: unknown[]) => {
      count += 1
      if (!state.regex) return state.replacement
      const match = String(args[0])
      const groups = args.slice(1, -2).map((value) => (value === undefined ? '' : String(value)))
      return state.replacement.replace(/\$(\$|&|\d)/g, (_token, key: string) => (key === '$' ? '$' : key === '&' ? match : (groups[Number(key) - 1] ?? '')))
    })
    if (!count) continue
    const model = models.getModel(tabId)!
    models.applyEdits(tabId, [{ range: { line: 1, column: 1, endLine: model.getLineCount(), endColumn: model.getLineMaxColumn(model.getLineCount()) }, text: next }])
    replacements += count
    changedFiles += 1
  }
  if (closed.length) {
    const result = await api.post<{ changed: Array<{ path: string; replacements: number }>; total: number }>(`/projects/${id}/ide/replace`, { ...searchBody(), replacement: state.replacement, files: closed })
    replacements += result.total
    changedFiles += result.changed.length
  }
  await runSearch()
  return { files: changedFiles, replacements }
}

// ---------------------------------------------------------------------------
// Language features
// ---------------------------------------------------------------------------

export function modelContext() {
  const editor = models.getActiveEditor()
  const model = editor?.getModel()
  const tabId = model ? models.tabIdOfModel(model) : undefined
  const info = tabId ? models.entryInfo(tabId) : undefined
  if (!editor || !model || !tabId || !info) return undefined
  return { editor, model, tabId, ...info }
}

/** "Find all references": results appear in the search view. */
export async function findReferences() {
  const context = modelContext()
  if (!context) return
  const position = context.editor.getPosition()
  if (!position) return
  try {
    const items = await api.post<NonNullable<ReturnType<typeof searchStore.get>['references']>['items']>(`/projects/${context.projectId}/ide/ts/references`, { path: context.path, line: position.lineNumber, column: position.column, content: context.model.getValue() })
    const word = context.model.getWordAtPosition(position)?.word ?? 'Symbol'
    searchStore.set({ references: { title: `${items.length} Referenz(en) auf „${word}“`, items } })
    actions.setSideView('search')
  } catch (error) {
    actions.notify(errorMessage(error), 'error')
  }
}

/** Formats the active file with the project's Prettier (as one undoable edit). */
export async function formatTab(tabId = editorStore.get().activeTabId, quiet = false): Promise<boolean> {
  const id = projectId()
  const info = tabId ? models.entryInfo(tabId) : undefined
  const content = tabId ? models.contentOf(tabId) : undefined
  if (!id || !tabId || !info || content === undefined) return false
  const result = await api.post<{ available: boolean; ok?: boolean; content?: string; changed?: boolean; message?: string }>(`/projects/${id}/ide/format`, { path: info.path, content })
  if (!result.available || !result.ok) {
    if (!quiet) actions.notify(result.message ?? 'Formatieren nicht möglich.', 'error')
    return false
  }
  // the content may have changed while Prettier ran: only apply on the version that was formatted
  if (result.changed && result.content !== undefined && models.contentOf(tabId) === content) {
    const model = models.getModel(tabId)!
    models.applyEdits(tabId, [{ range: { line: 1, column: 1, endLine: model.getLineCount(), endColumn: model.getLineMaxColumn(model.getLineCount()) }, text: result.content }])
  }
  return true
}

/** Save with "format on save" (Prettier of the project, when the setting is on and Prettier exists). */
export async function saveWithFormat(tabId: string) {
  if (appStore.get().settings?.formatOnSave) await formatTab(tabId, true).catch(() => false)
  await actions.saveTab(tabId)
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

export function setFileProblems(file: string, problems: ProblemEntry[]) {
  problemsStore.set((state) => ({ files: { ...state.files, [file]: problems } }))
}

export async function loadProjectProblems() {
  const id = projectId()
  if (!id) return
  const result = await api.get<ReturnType<typeof problemsStore.get>['project'] | null>(`/projects/${id}/ide/problems`)
  problemsStore.set({ project: result ?? undefined })
}

export async function checkProject() {
  const id = projectId()
  if (!id) return
  problemsStore.set((state) => ({ project: state.project ? { ...state.project, running: true } : { at: '', durationMs: 0, problems: [], tools: [], running: true } }))
  try {
    const result = await api.post<NonNullable<ReturnType<typeof problemsStore.get>['project']>>(`/projects/${id}/ide/problems/check`)
    problemsStore.set({ project: result })
    if (!result.tools.length) actions.notify('Weder TypeScript (tsc) noch ESLint sind im Projekt installiert.', 'info')
  } catch (error) {
    actions.notify(errorMessage(error), 'error')
    problemsStore.set((state) => ({ project: state.project ? { ...state.project, running: false } : undefined }))
  }
}

// ---------------------------------------------------------------------------
// Editor commands that open dialogs
// ---------------------------------------------------------------------------

export function openAiEdit() {
  const context = modelContext()
  if (!context) return
  const selection = context.editor.getSelection()
  if (!selection || selection.isEmpty()) {
    actions.notify('Bitte zuerst Code markieren.', 'info')
    return
  }
  dialogStore.set({ dialog: { kind: 'ai-edit', tabId: context.tabId, path: context.path, selection: { line: selection.startLineNumber, column: selection.startColumn, endLine: selection.endLineNumber, endColumn: selection.endColumn }, text: context.model.getValueInRange(selection) } })
}

/** Puts the selection with a question into the chat composer (the user reviews and sends it). */
export function explainSelection() {
  const context = modelContext()
  if (!context) return
  const selection = context.editor.getSelection()
  const text = selection && !selection.isEmpty() ? context.model.getValueInRange(selection) : context.model.getLineContent(context.editor.getPosition()?.lineNumber ?? 1)
  const from = selection?.startLineNumber ?? 1
  const sessionId = appStore.get().workspace.activeSessionId
  actions.setComposerDraft(sessionId, { mode: 'ask', text: `Erkläre diesen Code aus \`${context.path}\` (ab Zeile ${from}):\n\n\`\`\`\n${text.slice(0, 8000)}\n\`\`\`` })
  actions.setScreen('leitstand')
  actions.notify('Frage im Chat vorbereitet – prüfen und senden.', 'info')
}

export function prepareCodeTask(action: 'refactor' | 'tests' | 'fix' | 'review') {
  const context = modelContext()
  if (!context) return
  const selection = context.editor.getSelection()
  const text = selection && !selection.isEmpty() ? context.model.getValueInRange(selection) : context.model.getValue()
  const instructions = { refactor: 'Refaktoriere diesen Code unter Erhalt des Verhaltens. Prüfe alle betroffenen Referenzen und Tests.', tests: 'Generiere aussagekräftige Tests für diesen Code nach den Konventionen des Projekts.', fix: 'Korrigiere die Fehler in diesem Code. Prüfe die Diagnosen und bestehenden Tests.', review: 'Prüfe diesen Code auf Fehler, Sicherheitsprobleme und fehlende Tests. Nenne konkrete Befunde mit Datei und Zeile.' }
  actions.setComposerDraft(appStore.get().workspace.activeSessionId, { mode: action === 'review' ? 'ask' : 'task', text: `${instructions[action]}\n\nDatei: ${context.path}\n\`\`\`\n${text.slice(0, 24_000)}\n\`\`\`` })
  actions.setScreen('leitstand')
  actions.notify('Auftrag im Chat vorbereitet – prüfen und senden.', 'info')
}

export async function addContext(kind: 'file' | 'folder' | 'diff', requestedPath?: string) {
  const id = projectId()
  if (!id) return
  const context = modelContext()
  const file = requestedPath ?? context?.path
  if (!file && kind !== 'diff') return
  let text: string
  if (kind === 'diff') text = (await api.get<{ diff: string }>(`/projects/${id}/git/diff`)).diff
  else if (kind === 'file') text = context && context.path === file ? context.model.getValue() : (await api.get<{ content: string }>(`/projects/${id}/file?path=${enc(file!)}`)).content
  else {
    const folder = requestedPath ?? file!.split('/').slice(0, -1).join('/')
    const result = await api.get<{ text: string }>(`/projects/${id}/ide/context?path=${enc(folder)}`)
    text = result.text
  }
  actions.flushComposer()
  const key = actions.composerKey(appStore.get().workspace.activeSessionId)
  const draft = appStore.get().workspace.composer[key]
  actions.setComposerDraft(appStore.get().workspace.activeSessionId, { text: `${draft?.text ?? ''}\n\nKontext (${kind}: ${file ?? 'Git-Diff'}):\n\`\`\`\n${text.slice(0, 32_000)}\n\`\`\`` })
  actions.setScreen('leitstand')
  actions.notify('Kontext zum Chat hinzugefügt.', 'success')
}

export function taskFromProblem(problem: { path: string; line: number; message: string; source?: string }) {
  actions.setComposerDraft(appStore.get().workspace.activeSessionId, { mode: 'task', text: `Behebe diese Fehlermeldung und prüfe die betroffenen Tests:\n${problem.path}:${problem.line} ${problem.source ?? ''}\n${problem.message}` })
  actions.setScreen('leitstand')
  actions.notify('Task aus Fehlermeldung im Chat vorbereitet.', 'info')
}

export function openHistory() {
  const context = modelContext()
  if (context) dialogStore.set({ dialog: { kind: 'history', tabId: context.tabId, path: context.path } })
}

export async function diffWithHead() {
  const context = modelContext()
  const id = projectId()
  if (!context || !id) return
  const head = await api.get<{ content: string | null }>(`/projects/${id}/git/head-file?path=${enc(context.path)}`)
  if (head.content === null) {
    actions.notify('Die Datei ist in HEAD nicht vorhanden (neu).', 'info')
    return
  }
  actions.openDiff({ title: `${context.path.split('/').pop()} ↔ HEAD`, path: context.path, original: head.content, modified: context.model.getValue(), source: { type: 'git-head', path: context.path } })
}

// live diagnostics only for open files; a project switch resets the problems
let lastProject = appStore.get().project?.id
editorStore.subscribe(() => {
  const open = new Set(editorStore.get().tabs.filter((tab) => tab.kind === 'file').map((tab) => tab.path))
  const files = problemsStore.get().files
  if (Object.keys(files).some((file) => !open.has(file))) problemsStore.set({ files: Object.fromEntries(Object.entries(files).filter(([file]) => open.has(file))) })
})
appStore.subscribe(() => {
  const current = appStore.get().project?.id
  if (current === lastProject) return
  lastProject = current
  problemsStore.set({ files: {}, project: undefined })
  searchStore.set({ results: undefined, references: undefined })
})
