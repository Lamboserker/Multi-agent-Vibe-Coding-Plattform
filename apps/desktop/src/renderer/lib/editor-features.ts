import type * as Monaco from 'monaco-editor'
import * as actions from './actions'
import { api, enc, errorMessage } from './api'
import * as models from './editor-models'
import * as ide from './ide'
import { lineChanges } from './text-utils'
import { appStore, type ProblemEntry } from './stores'

/**
 * Editor features on top of Monaco: project-wide TypeScript navigation (definition, hover, rename),
 * live diagnostics with unsaved content, git change markers in the gutter and editor commands
 * (references, format, local history, diff with HEAD, AI edit/explain).
 */

const TS_LANGUAGES = ['typescript', 'javascript']
let registered = false

/** Project and path of a model URI created by editor-models.modelPath. */
function parseUri(uri: Monaco.Uri): { projectId: string; path: string } | undefined {
  if (uri.scheme !== 'file') return undefined
  const parts = uri.path.replace(/^\//, '').split('/').map(decodeURIComponent)
  if (parts.length < 2) return undefined
  return { projectId: parts[0]!, path: parts.slice(1).join('/') }
}

interface Span {
  path: string
  line: number
  column: number
  endLine: number
  endColumn: number
}

function registerProviders(monaco: typeof Monaco) {
  if (registered) return
  registered = true
  // the project service replaces the single-file features of Monaco's own TypeScript worker
  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, hovers: false, definitions: false, references: false, rename: false })
  }

  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const target = parseUri(resource)
      if (!target || target.projectId !== appStore.get().project?.id) return false
      const range = selectionOrPosition && 'startLineNumber' in selectionOrPosition
        ? { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn, endLine: selectionOrPosition.endLineNumber, endColumn: selectionOrPosition.endColumn }
        : selectionOrPosition
          ? { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column }
          : undefined
      void ide.openFileAt(target.path, range)
      return true
    },
  })

  for (const language of TS_LANGUAGES) {
    monaco.languages.registerDefinitionProvider(language, {
      async provideDefinition(model, position) {
        const target = parseUri(model.uri)
        if (!target) return null
        try {
          const spans = await api.post<Span[]>(`/projects/${target.projectId}/ide/ts/definition`, { path: target.path, line: position.lineNumber, column: position.column, content: model.getValue() })
          return spans
            .filter((span) => !span.path.startsWith('/') && !/^[A-Za-z]:/.test(span.path))
            .map((span) => ({ uri: monaco.Uri.parse(models.modelPath(target.projectId, span.path)), range: { startLineNumber: span.line, startColumn: span.column, endLineNumber: span.endLine, endColumn: span.endColumn } }))
        } catch {
          return null
        }
      },
    })

    monaco.languages.registerHoverProvider(language, {
      async provideHover(model, position) {
        const target = parseUri(model.uri)
        if (!target || !model.getWordAtPosition(position)) return null
        try {
          const hover = await api.post<(Span & { signature: string; documentation: string }) | null>(`/projects/${target.projectId}/ide/ts/hover`, { path: target.path, line: position.lineNumber, column: position.column, content: model.getValue() })
          if (!hover) return null
          return {
            range: { startLineNumber: hover.line, startColumn: hover.column, endLineNumber: hover.endLine, endColumn: hover.endColumn },
            contents: [{ value: `\`\`\`typescript\n${hover.signature}\n\`\`\`` }, ...(hover.documentation ? [{ value: hover.documentation }] : [])],
          }
        } catch {
          return null
        }
      },
    })

    monaco.languages.registerRenameProvider(language, {
      async provideRenameEdits(model, position, newName) {
        const target = parseUri(model.uri)
        if (!target) return { edits: [], rejectReason: 'Unbekannte Datei.' }
        try {
          const result = await api.post<{ canRename: true; files: Array<{ path: string; edits: Array<Span & { text: string }> }> } | { canRename: false; reason?: string }>(`/projects/${target.projectId}/ide/ts/rename`, {
            path: target.path,
            line: position.lineNumber,
            column: position.column,
            newName,
            content: model.getValue(),
          })
          if (!result.canRename) return { edits: [], rejectReason: result.reason ?? 'Kann nicht umbenannt werden.' }
          // other files: open tabs are edited in place, closed files on disk; this file through Monaco (undo)
          const others = result.files.filter((file) => file.path !== target.path)
          const applied = await ide.applyFileEdits(others.map((file) => ({ path: file.path, edits: file.edits })), 'rename')
          const own = result.files.find((file) => file.path === target.path)?.edits ?? []
          if (others.length) actions.notify(`Umbenannt in ${others.length + (own.length ? 1 : 0)} Datei(en)${applied.disk ? ` (${applied.disk} gespeichert, vorherige Fassung in der lokalen Historie)` : ''}.`, 'success')
          return { edits: own.map((edit) => ({ resource: model.uri, versionId: undefined, textEdit: { range: { startLineNumber: edit.line, startColumn: edit.column, endLineNumber: edit.endLine, endColumn: edit.endColumn }, text: edit.text } })) }
        } catch (error) {
          return { edits: [], rejectReason: errorMessage(error) }
        }
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Git change markers
// ---------------------------------------------------------------------------

const headCache = new Map<string, { at: number; content: string | null }>()

async function headContent(projectId: string, file: string) {
  const key = `${projectId}:${file}`
  const cached = headCache.get(key)
  if (cached && Date.now() - cached.at < 20_000) return cached.content
  const result = await api.get<{ content: string | null }>(`/projects/${projectId}/git/head-file?path=${enc(file)}`).catch(() => ({ content: null }))
  headCache.set(key, { at: Date.now(), content: result.content })
  return result.content
}

// ---------------------------------------------------------------------------
// Attach to the editor instance
// ---------------------------------------------------------------------------

export function attachEditorFeatures(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor): () => void {
  registerProviders(monaco)
  const disposables: Monaco.IDisposable[] = []
  const add = (id: string, label: string, run: () => unknown, keybinding?: number, group = 'navigation') =>
    disposables.push(editor.addAction({ id, label, keybindings: keybinding ? [keybinding] : undefined, contextMenuGroupId: group, run: () => void run() }))
  const { KeyMod, KeyCode } = monaco
  add('mac.findReferences', 'Alle Referenzen suchen', () => ide.findReferences(), KeyMod.Shift | KeyCode.F12)
  add('mac.format', 'Dokument formatieren (Prettier des Projekts)', () => ide.formatTab(), KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF, '1_modification')
  add('mac.aiEdit', 'KI: Auswahl bearbeiten (lokales Modell) …', () => ide.openAiEdit(), KeyMod.CtrlCmd | KeyCode.KeyI, '0_ai')
  add('mac.aiExplain', 'KI: Auswahl im Chat erklären lassen', () => ide.explainSelection(), undefined, '0_ai')
  add('mac.aiRefactor', 'KI: Code refaktorieren', () => ide.prepareCodeTask('refactor'), undefined, '0_ai')
  add('mac.aiTests', 'KI: Tests generieren', () => ide.prepareCodeTask('tests'), undefined, '0_ai')
  add('mac.aiFix', 'KI: Fehler korrigieren', () => ide.prepareCodeTask('fix'), undefined, '0_ai')
  add('mac.aiReview', 'KI: Code-Review', () => ide.prepareCodeTask('review'), undefined, '0_ai')
  add('mac.history', 'Lokale Historie der Datei …', () => ide.openHistory(), undefined, '9_history')
  add('mac.diffHead', 'Änderungen gegenüber HEAD anzeigen', () => ide.diffWithHead(), undefined, '9_history')

  let diagnosticsTimer: number | undefined
  let gutterTimer: number | undefined
  let decorations = editor.createDecorationsCollection()
  let generation = 0

  const updateDiagnostics = async () => {
    const model = editor.getModel()
    const target = model ? parseUri(model.uri) : undefined
    if (!model || !target || !TS_LANGUAGES.includes(model.getLanguageId())) return
    const current = ++generation
    try {
      const result = await api.post<{ diagnostics: Array<Span & { severity: 'error' | 'warning' | 'info'; code: number; message: string }> }>(`/projects/${target.projectId}/ide/ts/diagnostics`, { path: target.path, content: model.getValue() })
      if (current !== generation || model.isDisposed()) return
      const own = result.diagnostics.filter((diagnostic) => diagnostic.path === target.path)
      monaco.editor.setModelMarkers(
        model,
        'project-ts',
        own.map((diagnostic) => ({
          severity: diagnostic.severity === 'error' ? monaco.MarkerSeverity.Error : diagnostic.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
          message: diagnostic.message,
          code: `TS${diagnostic.code}`,
          source: 'TypeScript',
          startLineNumber: diagnostic.line,
          startColumn: diagnostic.column,
          endLineNumber: diagnostic.endLine,
          endColumn: Math.max(diagnostic.endColumn, diagnostic.column + 1),
        })),
      )
      ide.setFileProblems(target.path, own.map((diagnostic): ProblemEntry => ({ path: target.path, line: diagnostic.line, column: diagnostic.column, severity: diagnostic.severity, message: diagnostic.message, code: `TS${diagnostic.code}`, source: 'TypeScript' })))
    } catch {
      // file outside the TypeScript program or runtime busy: keep the previous markers
    }
  }

  const updateGutter = async () => {
    const model = editor.getModel()
    const target = model ? parseUri(model.uri) : undefined
    if (!model || !target) {
      decorations.clear()
      return
    }
    const base = await headContent(target.projectId, target.path)
    if (editor.getModel() !== model || model.isDisposed()) return
    const changes = base === null ? [{ kind: 'added' as const, from: 1, to: model.getLineCount() }] : lineChanges(base, model.getValue())
    decorations.set(
      changes.map((change) => ({
        range: { startLineNumber: change.from, startColumn: 1, endLineNumber: Math.min(change.to, model.getLineCount()), endColumn: 1 },
        options: { isWholeLine: true, linesDecorationsClassName: `git-gutter-${change.kind}`, overviewRuler: { color: change.kind === 'added' ? '#2ea043' : change.kind === 'modified' ? '#1f6feb' : '#da3633', position: monaco.editor.OverviewRulerLane.Left } },
      })),
    )
  }

  const schedule = (diagnosticsDelay: number, gutterDelay: number) => {
    if (diagnosticsTimer !== undefined) window.clearTimeout(diagnosticsTimer)
    if (gutterTimer !== undefined) window.clearTimeout(gutterTimer)
    diagnosticsTimer = window.setTimeout(() => void updateDiagnostics(), diagnosticsDelay)
    gutterTimer = window.setTimeout(() => void updateGutter(), gutterDelay)
  }
  disposables.push(editor.onDidChangeModelContent(() => schedule(700, 500)))
  disposables.push(
    editor.onDidChangeModel(() => {
      decorations.clear()
      schedule(150, 100)
    }),
  )
  // saving (head unchanged) or committing (head changed) changes the markers
  const onGitChange = () => {
    headCache.clear()
    schedule(150, 100)
  }
  window.addEventListener('mac:git-changed', onGitChange)
  return () => {
    if (diagnosticsTimer !== undefined) window.clearTimeout(diagnosticsTimer)
    if (gutterTimer !== undefined) window.clearTimeout(gutterTimer)
    window.removeEventListener('mac:git-changed', onGitChange)
    decorations.clear()
    decorations = editor.createDecorationsCollection()
    for (const disposable of disposables) disposable.dispose()
  }
}
