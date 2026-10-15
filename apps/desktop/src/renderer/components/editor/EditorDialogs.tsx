import { useEffect, useMemo, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import * as actions from '../../lib/actions'
import { api, enc, errorMessage } from '../../lib/api'
import { commands, fuzzyScore } from '../../lib/commands'
import * as models from '../../lib/editor-models'
import * as ide from '../../lib/ide'
import { useStore } from '../../lib/store/core'
import { appStore, dialogStore, type EditorDialog } from '../../lib/stores'
import { AsyncButton, Badge, Spinner } from '../common'

const close = () => dialogStore.set({ dialog: undefined })

/** Dialogs opened by commands and shortcuts (quick open, palette, AI edit, history, shortcuts). */
export function EditorDialogs() {
  const dialog = useStore(dialogStore, (state) => state.dialog)
  if (!dialog) return null
  if (dialog.kind === 'quick-open') return <QuickOpen key={dialog.mode} mode={dialog.mode} />
  if (dialog.kind === 'ai-edit') return <AiEdit dialog={dialog} />
  if (dialog.kind === 'history') return <History dialog={dialog} />
  return <Shortcuts />
}

function Marked({ text, positions }: { text: string; positions: number[] }) {
  const set = new Set(positions)
  return <>{[...text].map((char, index) => (set.has(index) ? <mark key={index}>{char}</mark> : char))}</>
}

let fileCache: { projectId: string; at: number; files: string[] } | undefined

function QuickOpen({ mode: initialMode }: { mode: 'files' | 'commands' | 'line' }) {
  const [query, setQuery] = useState(initialMode === 'commands' ? '>' : initialMode === 'line' ? ':' : '')
  const [files, setFiles] = useState<string[]>(fileCache?.files ?? [])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const projectId = appStore.get().project?.id
  const mode = query.startsWith('>') ? 'commands' : query.startsWith(':') ? 'line' : 'files'
  const term = mode === 'files' ? query.trim() : query.slice(1).trim()

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    if (mode !== 'files' || !projectId) return
    if (fileCache?.projectId === projectId && Date.now() - fileCache.at < 30_000) return
    setLoading(true)
    void api
      .get<string[]>(`/projects/${projectId}/ide/files`)
      .then((list) => {
        fileCache = { projectId, at: Date.now(), files: list }
        setFiles(list)
      })
      .catch((error: unknown) => actions.notify(errorMessage(error), 'error'))
      .finally(() => setLoading(false))
  }, [mode, projectId])

  const items = useMemo(() => {
    if (mode === 'line') return []
    if (mode === 'commands') {
      return commands()
        .filter((command) => command.enabled?.() ?? true)
        .map((command) => ({ command, match: fuzzyScore(`${command.category}: ${command.label}`, term) }))
        .filter((entry) => entry.match)
        .sort((a, b) => (term ? b.match!.score - a.match!.score : 0))
        .slice(0, 80)
        .map((entry) => ({ key: entry.command.id, text: `${entry.command.category}: ${entry.command.label}`, positions: entry.match!.positions, hint: entry.command.shortcut, run: () => entry.command.run() }))
    }
    const scored: Array<{ file: string; score: number; positions: number[] }> = []
    for (const file of files) {
      const match = fuzzyScore(file, term)
      if (match) scored.push({ file, ...match })
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 60)
      .map((entry) => ({ key: entry.file, text: entry.file, positions: entry.positions, hint: undefined as string | undefined, run: () => ide.openFileAt(entry.file) }))
  }, [mode, term, files])

  useEffect(() => setSelected(0), [query])

  const accept = (index = selected) => {
    if (mode === 'line') {
      const [line, column] = term.split(/[:,]/).map(Number)
      const tabId = appStore.get().project ? (ide.modelContext()?.tabId ?? '') : ''
      if (line && tabId) models.requestReveal(tabId, { line, column: column || 1 })
      close()
      return
    }
    const item = items[index]
    if (!item) return
    close()
    void Promise.resolve(item.run()).catch((error: unknown) => actions.notify(errorMessage(error), 'error'))
  }

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" role="dialog" aria-label={mode === 'commands' ? 'Befehlspalette' : 'Datei öffnen'} onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={input}
          value={query}
          placeholder="Datei suchen · „>“ für Befehle · „:“ für Zeile"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close()
            else if (event.key === 'ArrowDown') {
              event.preventDefault()
              setSelected((value) => Math.min(value + 1, Math.max(items.length - 1, 0)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setSelected((value) => Math.max(value - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              accept()
            }
          }}
        />
        <div className="palette-list" role="listbox">
          {mode === 'line' ? <div className="palette-item">Zeile[:Spalte] eingeben und Enter drücken</div> : null}
          {loading && !items.length ? (
            <div className="palette-item">
              <Spinner /> Dateien werden geladen …
            </div>
          ) : null}
          {items.map((item, index) => (
            <button key={item.key} role="option" aria-selected={index === selected} className={`palette-item ${index === selected ? 'selected' : ''}`} onMouseEnter={() => setSelected(index)} onClick={() => accept(index)}>
              <span className="truncate">
                <Marked text={item.text} positions={item.positions} />
              </span>
              {item.hint ? <span className="hint">{item.hint}</span> : null}
            </button>
          ))}
          {mode !== 'line' && !loading && !items.length ? <div className="palette-item faint">Keine Treffer</div> : null}
        </div>
      </div>
    </div>
  )
}

/** Side-by-side diff in a modal (original vs proposal). */
function DiffPreview({ original, modified, language }: { original: string; modified: string; language?: string }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let disposed = false
    let cleanup = () => undefined as void
    void models.loadMonaco().then((monaco: typeof Monaco) => {
      if (disposed || !host.current) return
      const left = monaco.editor.createModel(original, language)
      const right = monaco.editor.createModel(modified, language)
      const editor = monaco.editor.createDiffEditor(host.current, { readOnly: true, automaticLayout: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12 })
      editor.setModel({ original: left, modified: right })
      cleanup = () => {
        editor.dispose()
        left.dispose()
        right.dispose()
      }
    })
    return () => {
      disposed = true
      cleanup()
    }
  }, [original, modified, language])
  return <div ref={host} style={{ height: 320, border: '1px solid var(--border)', borderRadius: 6 }} data-testid="ai-diff" />
}

function AiEdit({ dialog }: { dialog: Extract<EditorDialog, { kind: 'ai-edit' }> }) {
  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState<{ replacement: string; model: string; durationMs: number }>()
  const [busy, setBusy] = useState(false)
  const projectId = appStore.get().project?.id
  const model = models.getModel(dialog.tabId)
  const language = model?.getLanguageId()

  const run = async () => {
    if (!model || !projectId) return
    setBusy(true)
    try {
      const full = model.getValue()
      const startOffset = model.getOffsetAt({ lineNumber: dialog.selection.line, column: dialog.selection.column })
      const endOffset = model.getOffsetAt({ lineNumber: dialog.selection.endLine, column: dialog.selection.endColumn })
      setResult(await api.post(`/projects/${projectId}/ide/ai/edit`, { path: dialog.path, language, before: full.slice(0, startOffset), selection: dialog.text, after: full.slice(endOffset), instruction }))
    } catch (error) {
      actions.notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const apply = () => {
    if (!result) return
    // only if the selected text is still unchanged
    const current = model?.getValueInRange({ startLineNumber: dialog.selection.line, startColumn: dialog.selection.column, endLineNumber: dialog.selection.endLine, endColumn: dialog.selection.endColumn })
    if (current !== dialog.text) {
      actions.notify('Die Auswahl wurde inzwischen geändert – bitte erneut ausführen.', 'error')
      return
    }
    models.applyEdits(dialog.tabId, [{ range: dialog.selection, text: result.replacement }])
    models.getActiveEditor()?.focus()
    close()
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" style={{ width: 'min(900px, 94vw)' }} onClick={(event) => event.stopPropagation()}>
        <h3>KI: Auswahl bearbeiten</h3>
        <div className="muted">
          {dialog.path}, Zeilen {dialog.selection.line}–{dialog.selection.endLine} · lokales Modell (keine Premium-Kosten) · Ergebnis wird erst nach Prüfung übernommen
        </div>
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <input
            className="input"
            autoFocus
            placeholder="Anweisung, z. B. „Fehlerbehandlung ergänzen“ oder „in async/await umschreiben“"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && instruction.trim() && !busy && void run()}
          />
          <button className="btn primary" disabled={!instruction.trim() || busy} onClick={() => void run()}>
            {busy ? <Spinner /> : null} {result ? 'Erneut' : 'Ausführen'}
          </button>
        </div>
        {result ? (
          <div className="stack" style={{ gap: 6, marginTop: 10 }}>
            <div className="faint">
              {result.model} · {(result.durationMs / 1000).toFixed(1)} s
            </div>
            <DiffPreview original={dialog.text} modified={result.replacement} language={language} />
          </div>
        ) : null}
        <div className="row" style={{ marginTop: 10 }}>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={!result} onClick={apply}>
            Übernehmen
          </button>
        </div>
      </div>
    </div>
  )
}

function History({ dialog }: { dialog: Extract<EditorDialog, { kind: 'history' }> }) {
  const projectId = appStore.get().project?.id
  const [entries, setEntries] = useState<Array<{ id: string; at: string; size: number; reason: string }>>()
  const [selected, setSelected] = useState<{ id: string; content: string }>()
  const REASONS: Record<string, string> = { save: 'Speichern', replace: 'Ersetzen', rename: 'Umbenennen', format: 'Formatieren', 'ai-edit': 'KI-Bearbeitung', restore: 'Wiederherstellen' }

  useEffect(() => {
    if (!projectId) return
    void api
      .get<typeof entries>(`/projects/${projectId}/ide/history?path=${enc(dialog.path)}`)
      .then(setEntries)
      .catch((error: unknown) => actions.notify(errorMessage(error), 'error'))
  }, [projectId, dialog.path])

  const current = models.contentOf(dialog.tabId) ?? ''
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" style={{ width: 'min(1000px, 94vw)' }} onClick={(event) => event.stopPropagation()}>
        <h3>Lokale Historie: {dialog.path}</h3>
        <div className="muted">Vor jedem Überschreiben durch die App (Speichern, Ersetzen, Umbenennen, KI) wird die vorherige Fassung aufbewahrt (50 Fassungen, 30 Tage).</div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 10, marginTop: 8 }}>
          <div className="stack" style={{ width: 230, gap: 2, maxHeight: 360, overflow: 'auto' }}>
            {!entries ? <Spinner /> : null}
            {entries?.length === 0 ? <div className="faint">Noch keine früheren Fassungen.</div> : null}
            {entries?.map((entry) => (
              <button
                key={entry.id}
                className={`palette-item ${selected?.id === entry.id ? 'selected' : ''}`}
                onClick={() =>
                  void api
                    .get<{ id: string; content: string }>(`/projects/${projectId}/ide/history/entry?path=${enc(dialog.path)}&entry=${entry.id}`)
                    .then(setSelected)
                    .catch((error: unknown) => actions.notify(errorMessage(error), 'error'))
                }
              >
                <span>{new Date(entry.at).toLocaleString('de-DE')}</span>
                <span className="hint">
                  <Badge>{REASONS[entry.reason] ?? entry.reason}</Badge>
                </span>
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>{selected ? <DiffPreview original={selected.content} modified={current} language={models.getModel(dialog.tabId)?.getLanguageId()} /> : <div className="faint">Fassung wählen, um sie mit dem aktuellen Stand zu vergleichen (links: frühere Fassung).</div>}</div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Schließen
          </button>
          <AsyncButton
            className="btn primary"
            disabled={!selected}
            onClick={async () => {
              const model = models.getModel(dialog.tabId)
              if (!model || !selected) return
              models.applyEdits(dialog.tabId, [{ range: { line: 1, column: 1, endLine: model.getLineCount(), endColumn: model.getLineMaxColumn(model.getLineCount()) }, text: selected.content }])
              models.getActiveEditor()?.focus()
              actions.notify('Fassung in den Editor übernommen (noch nicht gespeichert, Rückgängig möglich).', 'success')
              close()
            }}
          >
            Diese Fassung wiederherstellen
          </AsyncButton>
        </div>
      </div>
    </div>
  )
}

function Shortcuts() {
  const list = commands().filter((command) => command.shortcut)
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" style={{ width: 'min(620px, 94vw)' }} onClick={(event) => event.stopPropagation()}>
        <h3>Tastenkürzel</h3>
        <table className="table">
          <tbody>
            {list.map((command) => (
              <tr key={command.id}>
                <td>{command.label}</td>
                <td>
                  <span className="kbd">{command.shortcut}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  )
}
