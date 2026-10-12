import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { X } from 'lucide-react'
import * as actions from '../../lib/actions'
import * as models from '../../lib/editor-models'
import { touchWorkspace } from '../../lib/persistence'
import { shallowEqual } from '../../lib/store/core'
import { useAppState, useEditorState } from '../../lib/store'
import type { EditorTab } from '../../lib/stores'
import { Confirm, Spinner } from '../common'
import { ProjectSetup } from '../panels/ProjectsPanel'

const EDITOR_FONT = "'Cascadia Code', 'JetBrains Mono', Consolas, monospace"

export function EditorArea() {
  const projectOpen = useAppState((state) => Boolean(state.project))
  const { tabs, activeTabId, restoring } = useEditorState((state) => ({ tabs: state.tabs, activeTabId: state.activeTabId, restoring: state.restoring }), shallowEqual)
  const active = tabs.find((tab) => tab.id === activeTabId)
  const [confirmClose, setConfirmClose] = useState<EditorTab>()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && activeTabId) {
        event.preventDefault()
        void actions.saveTab(activeTabId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTabId])

  if (!projectOpen) {
    return (
      <div className="editor-area">
        <div className="welcome">
          <h1>Multi-AI Coder</h1>
          <div>Öffne ein Git-Repository, um loszulegen.</div>
          <div style={{ width: 'min(440px, 90%)' }}>
            <ProjectSetup />
          </div>
        </div>
      </div>
    )
  }

  const close = (tab: EditorTab) => {
    if (actions.closeTab(tab.id) === 'needs_confirmation') setConfirmClose(tab)
  }
  const hasFileTab = tabs.some((tab) => tab.kind === 'file')

  return (
    <div className="editor-area">
      <div className="tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
            onClick={() => actions.setActiveTab(tab.id)}
            title={tab.path}
            onAuxClick={(event) => event.button === 1 && close(tab)}
          >
            <span>{tab.kind === 'diff' ? '⇄ ' : ''}{tab.title}</span>
            {tab.dirty ? <span className="dirty" title="Nicht gespeichert (als Entwurf gesichert)" /> : null}
            <button className="icon-btn" style={{ width: 20, height: 20 }} aria-label={`${tab.title} schließen`} onClick={(event) => { event.stopPropagation(); close(tab) }}>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      {active?.externalChange ? (
        <div className="editor-banner">
          Die Datei wurde außerhalb des Editors geändert. Deine ungespeicherten Änderungen sind erhalten.
          <span className="spacer" />
          <button className="btn small" onClick={() => void actions.reloadTabFromDisk(active.id)}>
            Neu laden (eigene Änderungen verwerfen)
          </button>
          <button className="btn small" onClick={() => void actions.saveTab(active.id, true)}>
            Überschreiben
          </button>
        </div>
      ) : null}
      <div className="editor-host">
        {hasFileTab ? <CodeEditor tab={active?.kind === 'file' ? active : undefined} visible={active?.kind === 'file'} /> : null}
        {active?.kind === 'diff' ? <DiffView key={active.id} tab={active} /> : null}
        {!active ? (
          <div className="welcome">
            {restoring ? <div className="row"><Spinner /> Stelle geöffnete Dateien wieder her …</div> : <div>Wähle eine Datei im Explorer oder beschreibe rechts eine Aufgabe.</div>}
            <div className="faint">Strg+S speichert · Ungespeicherte Änderungen werden automatisch als Entwurf gesichert</div>
          </div>
        ) : null}
      </div>
      {confirmClose ? (
        <Confirm
          title={`${confirmClose.title} schließen?`}
          danger
          confirmLabel="Ohne Speichern schließen"
          onCancel={() => setConfirmClose(undefined)}
          onConfirm={() => {
            actions.closeTab(confirmClose.id, true)
            setConfirmClose(undefined)
          }}
        >
          Die Datei hat ungespeicherte Änderungen. Beim Schließen ohne Speichern werden sie verworfen.
        </Confirm>
      ) : null}
    </div>
  )
}

/**
 * One Monaco editor instance for all file tabs: switching tabs swaps the text model and restores its
 * view state (cursor, selection, scroll, folding) instead of re-creating the editor.
 */
function CodeEditor({ tab, visible }: { tab?: EditorTab; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined)
  const currentTab = useRef<string | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const theme = useAppState((state) => state.ui.theme)

  useEffect(() => {
    let disposed = false
    let saveTimer: number | undefined
    void models.loadMonaco().then((monaco) => {
      if (disposed || !host.current) return
      const editor = monaco.editor.create(host.current, { automaticLayout: true, fontFamily: EDITOR_FONT, fontSize: 13, minimap: { enabled: true }, smoothScrolling: true, tabSize: 2, model: null })
      editorRef.current = editor
      // View states are kept per tab and persisted (debounced) with the workspace.
      const remember = () => {
        if (saveTimer !== undefined) window.clearTimeout(saveTimer)
        saveTimer = window.setTimeout(() => {
          if (currentTab.current) models.setViewState(currentTab.current, editor.saveViewState())
          touchWorkspace()
        }, 800)
      }
      editor.onDidChangeCursorPosition(remember)
      editor.onDidScrollChange(remember)
      setReady(true)
    })
    return () => {
      disposed = true
      if (saveTimer !== undefined) window.clearTimeout(saveTimer)
      const editor = editorRef.current
      if (editor && currentTab.current) models.setViewState(currentTab.current, editor.saveViewState())
      // Disposing the editor keeps the models (they belong to the tabs).
      editor?.dispose()
      editorRef.current = undefined
    }
  }, [])

  useEffect(() => {
    void models.loadMonaco().then((monaco) => monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs'))
  }, [theme])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !ready) return
    if (currentTab.current && currentTab.current !== tab?.id && editor.getModel()) models.setViewState(currentTab.current, editor.saveViewState())
    const model = tab ? models.getModel(tab.id) : null
    if (editor.getModel() !== model) editor.setModel(model)
    if (tab && model) {
      editor.updateOptions({ readOnly: tab.readOnly })
      const viewState = models.viewStateOf(tab.id)
      if (viewState) editor.restoreViewState(viewState)
      if (visible) editor.focus()
    }
    currentTab.current = tab?.id
  }, [tab?.id, tab?.readOnly, ready, visible])

  return (
    <div className="editor-stack" style={{ visibility: visible ? 'visible' : 'hidden' }}>
      {!ready ? <div className="welcome"><Spinner /></div> : null}
      <div ref={host} style={{ position: 'absolute', inset: 0 }} data-testid="code-editor" />
    </div>
  )
}

function DiffView({ tab }: { tab: EditorTab }) {
  const host = useRef<HTMLDivElement>(null)
  const theme = useAppState((state) => state.ui.theme)
  useEffect(() => {
    let disposed = false
    let cleanup = () => undefined as void
    void models.loadMonaco().then((monaco) => {
      if (disposed || !host.current) return
      monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
      if (tab.language === 'diff' || tab.original === '') {
        // unified patch: shown as text
        const model = monaco.editor.createModel(tab.content ?? '', 'diff')
        const editor = monaco.editor.create(host.current, { model, readOnly: true, automaticLayout: true, fontFamily: EDITOR_FONT, fontSize: 13, wordWrap: 'off' })
        cleanup = () => {
          editor.dispose()
          model.dispose()
        }
        return
      }
      const original = monaco.editor.createModel(tab.original ?? '', tab.language)
      const modified = monaco.editor.createModel(tab.content ?? '', tab.language)
      const editor = monaco.editor.createDiffEditor(host.current, { readOnly: true, automaticLayout: true, renderSideBySide: true, fontFamily: EDITOR_FONT, fontSize: 13 })
      editor.setModel({ original, modified })
      cleanup = () => {
        editor.dispose()
        original.dispose()
        modified.dispose()
      }
    })
    return () => {
      disposed = true
      cleanup()
    }
    // a diff tab's content never changes; the theme is applied globally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])
  return <div ref={host} className="editor-stack" data-testid="diff-editor" />
}
