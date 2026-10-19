import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalInfo } from '../../../shared/bridge'
import * as actions from '../../lib/actions'
import { bridge } from '../../lib/api'
import { useAppState } from '../../lib/store'
import { findLinks, isLinkModifier } from '../../lib/terminal-links'

const THEMES = {
  // the app palette (sRGB form of the CSS tokens --bg / --text / --accent)
  dark: { background: '#0e0c0a', foreground: '#f1eee9', cursor: '#b58dff', selectionBackground: '#b58dff40' },
  light: { background: '#f9f6f2', foreground: '#1a1512', cursor: '#7a40da', selectionBackground: '#7a40da2e' },
}

const LINK_HINT = 'Link öffnen (Strg + Klick)'

/**
 * Web links in the output, opened in the default browser with Ctrl+click (Cmd+click on macOS).
 * A URL that the terminal wrapped over several rows is found as one link; positions are mapped per
 * cell, so wide characters before a link do not shift it.
 */
function webLinkProvider(terminal: Terminal, host: HTMLElement): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active
      let first = bufferLineNumber - 1
      while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1
      let last = bufferLineNumber - 1
      while (buffer.getLine(last + 1)?.isWrapped) last += 1
      let text = ''
      const cells: Array<{ x: number; y: number }> = []
      for (let y = first; y <= last; y += 1) {
        const line = buffer.getLine(y)
        if (!line) break
        for (let x = 0; x < line.length; x += 1) {
          const cell = line.getCell(x)
          const chars = cell?.getChars() ?? ''
          if (!cell || cell.getWidth() === 0) continue
          const value = chars || ' '
          for (let index = 0; index < value.length; index += 1) cells.push({ x: x + 1, y: y + 1 })
          text += value
        }
      }
      const found = findLinks(text)
        .map((link): ILink => {
          const start = cells[link.start]!
          const end = cells[link.end - 1]!
          return {
            range: { start, end },
            text: link.url,
            decorations: { pointerCursor: true, underline: true },
            activate: (event, url) => {
              if (!isLinkModifier(event)) return
              // local dev servers open inside the app (code screen), everything else in the browser
              if (actions.openPreview(url)) return
              void bridge().shell.openLink(url).catch((error: unknown) => actions.notify(error instanceof Error ? error.message : String(error), 'error'))
            },
            hover: () => {
              host.title = LINK_HINT
            },
            leave: () => {
              if (host.title === LINK_HINT) host.removeAttribute('title')
            },
          }
        })
        // only the links touching the requested row
        .filter((link) => link.range.start.y <= bufferLineNumber && link.range.end.y >= bufferLineNumber)
      callback(found.length ? found : undefined)
    },
  }
}

/**
 * View of a terminal process that lives in the main process. Mounting attaches (replaying the
 * scrollback), unmounting only detaches: the process is ended exclusively by closing the terminal.
 */
export function TerminalView({ terminalId, visible = true, onExit }: { terminalId: string; visible?: boolean; onExit?: (code: number) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  const termRef = useRef<Terminal | undefined>(undefined)
  const searchRef = useRef<SearchAddon | undefined>(undefined)
  const [search, setSearch] = useState<{ open: boolean; query: string; caseSensitive: boolean; found?: boolean }>({ open: false, query: '', caseSensitive: false })
  const theme = useAppState((state) => state.ui.theme)
  const [history, setHistory] = useState<string[] | null>(null)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  useEffect(() => {
    const terminal = new Terminal({ fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace", fontSize: 12.5, cursorBlink: true, allowProposedApi: false, scrollback: 5000, theme: THEMES[theme] })
    termRef.current = terminal
    const fit = new FitAddon()
    fitRef.current = fit
    terminal.loadAddon(fit)
    const searchAddon = new SearchAddon()
    searchRef.current = searchAddon
    terminal.loadAddon(searchAddon)
    // Ctrl+F opens the search bar of this terminal (instead of sending ^F to the shell)
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        setSearch((current) => ({ ...current, open: true }))
        return false
      }
      return true
    })
    terminal.open(host.current!)
    const links = terminal.registerLinkProvider(webLinkProvider(terminal, host.current!))
    let attached = false
    const buffered: string[] = []
    // Output that arrives while the scrollback is being fetched is appended after it.
    const offData = bridge().terminal.onData((id, data) => {
      if (id !== terminalId) return
      if (attached) terminal.write(data)
      else buffered.push(data)
    })
    const offExit = bridge().terminal.onExit((id, code) => {
      if (id !== terminalId) return
      terminal.write(`\r\n\x1b[90m[Prozess beendet mit Code ${code}]\x1b[0m\r\n`)
      onExitRef.current?.(code)
    })
    void bridge()
      .terminal.attach(terminalId)
      .then((state) => {
        if (state?.scrollback) terminal.write(state.scrollback)
        for (const chunk of buffered.splice(0)) terminal.write(chunk)
        attached = true
        try {
          fit.fit()
          void bridge().terminal.resize(terminalId, Math.max(terminal.cols, 20), Math.max(terminal.rows, 5))
        } catch {
          // hidden
        }
      })
    terminal.onData((data) => bridge().terminal.write(terminalId, data))
    terminal.onResize(({ cols, rows }) => void bridge().terminal.resize(terminalId, cols, rows))
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // hidden
      }
    })
    observer.observe(host.current!)
    return () => {
      observer.disconnect()
      links.dispose()
      offData()
      offExit()
      terminal.dispose()
      termRef.current = undefined
    }
    // bound to one terminal process
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme]
  }, [theme])

  useEffect(() => {
    if (!visible) return
    const timer = window.setTimeout(() => {
      try {
        fitRef.current?.fit()
        // never take the focus from an input the user is typing in (palette, chat, editor …)
        const focused = document.activeElement
        if (!focused || focused === document.body || host.current?.contains(focused)) termRef.current?.focus()
      } catch {
        // not laid out yet
      }
    }, 30)
    return () => window.clearTimeout(timer)
  }, [visible])

  const find = (direction: 'next' | 'previous', query = search.query) => {
    if (!query) return
    // the match is selected (decorations would need xterm's proposed API)
    const options = { caseSensitive: search.caseSensitive }
    const found = direction === 'next' ? searchRef.current?.findNext(query, options) : searchRef.current?.findPrevious(query, options)
    setSearch((current) => ({ ...current, found }))
  }
  const closeSearch = () => {
    searchRef.current?.clearDecorations()
    setSearch((current) => ({ ...current, open: false, found: undefined }))
    termRef.current?.focus()
  }

  return (
    <div className="terminal-wrapper" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="row"><button className="btn small" onClick={() => void bridge().terminal.history(terminalId).then(setHistory)}>Befehlshistorie</button></div>
      {history ? <div className="stack" style={{ maxHeight: 160, overflow: 'auto' }}>
        <button className="btn small" onClick={() => setHistory(null)}>Schließen</button>
        {history.length ? history.slice().reverse().map((command, index) => <button key={index} className="btn small mono" onClick={() => { bridge().terminal.write(terminalId, command); setHistory(null); termRef.current?.focus() }}>{command}</button>) : <span className="muted">Noch keine Shell-Befehle erfasst.</span>}
      </div> : null}
      {search.open ? (
        <div className="terminal-search" role="search">
          <input
            autoFocus
            className="input"
            placeholder="Im Terminal suchen"
            aria-label="Im Terminal suchen"
            value={search.query}
            onChange={(event) => {
              const query = event.target.value
              setSearch((current) => ({ ...current, query }))
              find('next', query)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') find(event.shiftKey ? 'previous' : 'next')
              if (event.key === 'Escape') closeSearch()
            }}
          />
          <button className={`toggle-btn ${search.caseSensitive ? 'on' : ''}`} title="Groß-/Kleinschreibung" onClick={() => setSearch((current) => ({ ...current, caseSensitive: !current.caseSensitive }))}>
            Aa
          </button>
          <button className="btn small" title="Vorheriger Treffer (Umschalt+Enter)" onClick={() => find('previous')}>
            ↑
          </button>
          <button className="btn small" title="Nächster Treffer (Enter)" onClick={() => find('next')}>
            ↓
          </button>
          <span className="faint">{search.found === false ? 'nicht gefunden' : ''}</span>
          <button className="btn small ghost" onClick={closeSearch}>
            ✕
          </button>
        </div>
      ) : null}
      <div ref={host} className="terminal-host" data-testid="terminal-host" data-terminal-id={terminalId} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}

const commandTerminals = new Map<string, Promise<TerminalInfo | undefined>>()

/**
 * A terminal that runs one allowlisted command (login/install). Creation is keyed, so a re-mount
 * (StrictMode, view switch) attaches to the same process instead of starting the command twice.
 */
export function CommandTerminal({ requestKey, command, title, onExit }: { requestKey: string; command: string[]; title: string; onExit?: (code: number) => void }) {
  const [info, setInfo] = useState<TerminalInfo>()
  useEffect(() => {
    let active = true
    if (!commandTerminals.has(requestKey)) commandTerminals.set(requestKey, actions.createTerminal({ command, title }))
    void commandTerminals.get(requestKey)!.then((created) => active && setInfo(created))
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])
  if (!info) return <div className="faint" style={{ padding: 8 }}>Terminal wird gestartet …</div>
  return <TerminalView terminalId={info.id} onExit={onExit} />
}
