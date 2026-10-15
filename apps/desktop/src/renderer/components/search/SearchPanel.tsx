import { useEffect, useRef, useState } from 'react'
import { Replace, X } from 'lucide-react'
import { notify } from '../../lib/actions'
import { errorMessage } from '../../lib/api'
import { useIsVisible } from '../../lib/hooks'
import * as ide from '../../lib/ide'
import { useStore } from '../../lib/store/core'
import { searchStore, type SearchMatch } from '../../lib/stores'
import { Confirm, Empty, PanelHeader, Spinner } from '../common'

function Highlight({ match }: { match: SearchMatch }) {
  // the preview starts up to 60 characters before the match
  const offset = Math.min(60, match.column - 1)
  const preview = match.preview
  return (
    <>
      <span className="faint">{match.line}: </span>
      {preview.slice(0, offset).trimStart()}
      <mark>{preview.slice(offset, offset + match.length)}</mark>
      {preview.slice(offset + match.length)}
    </>
  )
}

/** Workspace search and replace (and the result list of "find all references"). */
export function SearchPanel() {
  const state = useStore(searchStore, (value) => value)
  const visible = useIsVisible()
  const input = useRef<HTMLInputElement>(null)
  const [showReplace, setShowReplace] = useState(false)
  const [confirm, setConfirm] = useState<{ files?: string[]; count: number; fileCount: number }>()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (visible) input.current?.focus()
  }, [visible])

  // search as you type (debounced); option changes search immediately
  useEffect(() => {
    const timer = window.setTimeout(() => void ide.runSearch(), 250)
    return () => window.clearTimeout(timer)
  }, [state.query, state.regex, state.caseSensitive, state.wholeWord, state.include, state.exclude])

  const toggle = (key: 'regex' | 'caseSensitive' | 'wholeWord', label: string, title: string) => (
    <button className={`toggle-btn ${state[key] ? 'on' : ''}`} title={title} aria-pressed={state[key]} onClick={() => searchStore.set({ [key]: !state[key] })}>
      {label}
    </button>
  )

  const doReplace = async (files?: string[]) => {
    try {
      const result = await ide.replaceAll(files)
      notify(`${result.replacements} Ersetzung(en) in ${result.files} Datei(en). Offene Dateien wurden im Editor geändert (Rückgängig möglich), andere gespeichert – vorherige Fassungen liegen in der lokalen Historie.`, 'success')
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }

  return (
    <>
      <PanelHeader title="Suchen" />
      <div className="panel-body stack" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 4 }}>
          <button className="icon-btn" title="Ersetzen ein-/ausblenden" onClick={() => setShowReplace(!showReplace)}>
            <Replace size={14} />
          </button>
          <input ref={input} className="input" placeholder="Suchen (Strg+Umschalt+F)" value={state.query} onChange={(event) => searchStore.set({ query: event.target.value })} onKeyDown={(event) => event.key === 'Enter' && void ide.runSearch()} aria-label="Suchbegriff" />
          {toggle('caseSensitive', 'Aa', 'Groß-/Kleinschreibung beachten')}
          {toggle('wholeWord', 'ab', 'Nur ganze Wörter')}
          {toggle('regex', '.*', 'Regulärer Ausdruck')}
        </div>
        {showReplace ? (
          <div className="row" style={{ gap: 4 }}>
            <input className="input" placeholder={state.regex ? 'Ersetzen ($1, $& möglich)' : 'Ersetzen'} value={state.replacement} onChange={(event) => searchStore.set({ replacement: event.target.value })} aria-label="Ersetzen durch" />
            <button className="btn small" disabled={!state.results?.total} onClick={() => setConfirm({ count: state.results!.total, fileCount: state.results!.files.length })}>
              Alle ersetzen
            </button>
          </div>
        ) : null}
        <div className="row" style={{ gap: 4 }}>
          <input className="input" placeholder="Einschließen, z. B. src/**, *.ts" value={state.include} onChange={(event) => searchStore.set({ include: event.target.value })} />
          <input className="input" placeholder="Ausschließen, z. B. *.test.ts" value={state.exclude} onChange={(event) => searchStore.set({ exclude: event.target.value })} />
        </div>

        {state.references ? (
          <div className="stack" style={{ gap: 2 }}>
            <div className="row">
              <strong>{state.references.title}</strong>
              <span className="spacer" />
              <button className="icon-btn" title="Referenzliste schließen" onClick={() => searchStore.set({ references: undefined })}>
                <X size={13} />
              </button>
            </div>
            {state.references.items.map((item, index) => (
              <button key={index} className="search-hit" title={`${item.path}:${item.line}`} onClick={() => void ide.openFileAt(item.path, { line: item.line, column: item.column, endLine: item.endLine, endColumn: item.endColumn })}>
                <span className="faint">
                  {item.path}:{item.line}
                  {item.isDefinition ? ' (Definition)' : ''}{' '}
                </span>
                {item.preview}
              </button>
            ))}
          </div>
        ) : null}

        {state.loading ? <Spinner /> : null}
        {state.error ? <div className="callout error">{state.error}</div> : null}
        {state.results ? (
          <div className="faint">
            {state.results.total} Treffer in {state.results.files.length} Datei(en){state.results.truncated ? ' (gekürzt – Suche eingrenzen)' : ''}
          </div>
        ) : null}
        <div className="stack" style={{ gap: 0 }} data-testid="search-results">
          {state.results?.files.map((file) => (
            <div key={file.path}>
              <div className="search-file">
                <button className="btn small ghost" style={{ padding: '0 4px' }} onClick={() => setCollapsed({ ...collapsed, [file.path]: !collapsed[file.path] })}>
                  {collapsed[file.path] ? '▸' : '▾'}
                </button>
                <span className="truncate" title={file.path}>
                  {file.path}
                </span>
                <span className="faint">{file.matches.length}</span>
                <span className="spacer" />
                {showReplace ? (
                  <button className="btn small ghost" title="In dieser Datei ersetzen" onClick={() => setConfirm({ files: [file.path], count: file.matches.length, fileCount: 1 })}>
                    Ersetzen
                  </button>
                ) : null}
              </div>
              {collapsed[file.path]
                ? null
                : file.matches.map((match, index) => (
                    <button key={index} className="search-hit" onClick={() => void ide.openFileAt(file.path, { line: match.line, column: match.column, endLine: match.line, endColumn: match.column + match.length })}>
                      <Highlight match={match} />
                    </button>
                  ))}
            </div>
          ))}
          {state.results && !state.results.total && state.query ? <Empty>Keine Treffer.</Empty> : null}
        </div>
      </div>
      {confirm ? (
        <Confirm
          title="Ersetzen bestätigen"
          confirmLabel={`${confirm.count} ersetzen`}
          danger
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            const files = confirm.files
            setConfirm(undefined)
            void doReplace(files)
          }}
        >
          „{state.query}“ wird in {confirm.fileCount} Datei(en) {confirm.count}× durch „{state.replacement}“ ersetzt.
        </Confirm>
      ) : null}
    </>
  )
}
