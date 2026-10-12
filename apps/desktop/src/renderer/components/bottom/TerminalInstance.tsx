import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalInfo } from '../../../shared/bridge'
import * as actions from '../../lib/actions'
import { bridge } from '../../lib/api'
import { useAppState } from '../../lib/store'

const THEMES = {
  dark: { background: '#10161e', foreground: '#d7dee8', cursor: '#e5a54b' },
  light: { background: '#eef1f5', foreground: '#1c2430', cursor: '#b9741c', selectionBackground: '#c9d6e6' },
}

/**
 * View of a terminal process that lives in the main process. Mounting attaches (replaying the
 * scrollback), unmounting only detaches: the process is ended exclusively by closing the terminal.
 */
export function TerminalView({ terminalId, visible = true, onExit }: { terminalId: string; visible?: boolean; onExit?: (code: number) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  const termRef = useRef<Terminal | undefined>(undefined)
  const theme = useAppState((state) => state.ui.theme)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  useEffect(() => {
    const terminal = new Terminal({ fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace", fontSize: 12.5, cursorBlink: true, allowProposedApi: false, scrollback: 5000, theme: THEMES[theme] })
    termRef.current = terminal
    const fit = new FitAddon()
    fitRef.current = fit
    terminal.loadAddon(fit)
    terminal.open(host.current!)
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
        termRef.current?.focus()
      } catch {
        // not laid out yet
      }
    }, 30)
    return () => window.clearTimeout(timer)
  }, [visible])

  return <div ref={host} className="terminal-host" data-testid="terminal-host" data-terminal-id={terminalId} style={{ display: visible ? 'block' : 'none' }} />
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
