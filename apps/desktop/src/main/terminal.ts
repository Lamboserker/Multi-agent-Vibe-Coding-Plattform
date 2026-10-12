import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IPty } from '@lydell/node-pty'

type PtyModule = typeof import('@lydell/node-pty')

/** Scrollback kept per terminal in the main process (re-attach after navigation or window reload). */
export const SCROLLBACK_BYTES = 256 * 1024
/** Scrollback persisted per terminal when the app quits (shown as history after the next start). */
export const PERSISTED_SCROLLBACK_BYTES = 64 * 1024
const MAX_TERMINALS = 24

export type TerminalStatus = 'running' | 'exited' | 'restored'

export interface TerminalInfo {
  id: string
  title: string
  cwd?: string
  command?: string[]
  projectId?: string
  pid?: number
  status: TerminalStatus
  exitCode?: number
  startedAt: string
  endedAt?: string
}

export interface PersistedTerminal {
  title: string
  cwd?: string
  projectId?: string
  scrollback: string
  endedAt: string
}

/** Fixed-size text ring buffer (keeps the newest output). */
export class ScrollbackBuffer {
  private chunks: string[] = []
  private size = 0

  constructor(private readonly limit: number) {}

  append(data: string) {
    this.chunks.push(data)
    this.size += data.length
    while (this.size > this.limit) {
      const first = this.chunks[0]!
      const excess = this.size - this.limit
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.slice(excess)
        this.size -= excess
      }
    }
  }

  toString(limit = this.limit) {
    const all = this.chunks.join('')
    return all.length > limit ? all.slice(all.length - limit) : all
  }
}

interface Entry {
  info: TerminalInfo
  pty?: IPty
  buffer: ScrollbackBuffer
}

/**
 * Real terminal processes (PTY). They belong to the main process, not to a React component: switching
 * views, closing the panel or reloading the window only detaches the view; the process keeps running
 * and its scrollback is replayed on re-attach. Processes end only when the user closes the terminal
 * or the app quits; the last output is then kept as read-only history for the next start.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, Entry>()
  private counter = 0
  private pty?: PtyModule

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (id: string, exitCode: number) => void,
    private readonly onChange: () => void = () => undefined,
  ) {}

  private async module(): Promise<PtyModule> {
    if (!this.pty) this.pty = (await import('@lydell/node-pty')) as PtyModule
    return this.pty
  }

  defaultShell(): { file: string; args: string[] } {
    if (process.platform === 'win32') {
      const pwsh = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'].find((candidate) => existsSync(candidate))
      return { file: pwsh ?? 'powershell.exe', args: ['-NoLogo'] }
    }
    return { file: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] }
  }

  private nextId() {
    return `term-${++this.counter}`
  }

  async create(options: { cols: number; rows: number; cwd?: string; command?: string[]; title?: string; projectId?: string; replaces?: string }): Promise<TerminalInfo> {
    const running = [...this.terminals.values()].filter((entry) => entry.info.status === 'running').length
    if (running >= MAX_TERMINALS) throw new Error(`Too many terminals (${MAX_TERMINALS}). Close some first.`)
    const pty = await this.module()
    const id = this.nextId()
    let file: string
    let args: string[]
    if (options.command) {
      const [binary, ...rest] = options.command
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary!)) {
        file = process.env.ComSpec ?? 'cmd.exe'
        args = ['/d', '/c', binary!, ...rest]
      } else {
        file = binary!
        args = rest
      }
    } else {
      ;({ file, args } = this.defaultShell())
    }
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('MAC_') && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    const cwd = options.cwd && existsSync(options.cwd) ? options.cwd : os.homedir()
    const terminal = pty.spawn(file, args, { name: 'xterm-256color', cols: options.cols, rows: options.rows, cwd, env })
    const replaced = options.replaces ? this.terminals.get(options.replaces) : undefined
    const buffer = new ScrollbackBuffer(SCROLLBACK_BYTES)
    if (replaced) buffer.append(replaced.buffer.toString())
    const entry: Entry = {
      info: { id, title: options.title?.slice(0, 80) || path.basename(cwd) || `Terminal ${this.counter}`, cwd, command: options.command, projectId: options.projectId, pid: terminal.pid, status: 'running', startedAt: new Date().toISOString() },
      pty: terminal,
      buffer,
    }
    terminal.onData((data) => {
      entry.buffer.append(data)
      this.onData(id, data)
    })
    terminal.onExit(({ exitCode }) => {
      entry.pty = undefined
      entry.info = { ...entry.info, status: 'exited', exitCode, endedAt: new Date().toISOString(), pid: undefined }
      this.onExit(id, exitCode)
      this.onChange()
    })
    if (replaced) this.terminals.delete(options.replaces!)
    this.terminals.set(id, entry)
    this.onChange()
    return { ...entry.info }
  }

  list(projectId?: string): TerminalInfo[] {
    return [...this.terminals.values()].map((entry) => ({ ...entry.info })).filter((info) => !projectId || !info.projectId || info.projectId === projectId)
  }

  /** Current state and scrollback, for a view that (re-)attaches to the terminal. */
  attach(id: string): { info: TerminalInfo; scrollback: string } | undefined {
    const entry = this.terminals.get(id)
    return entry ? { info: { ...entry.info }, scrollback: entry.buffer.toString() } : undefined
  }

  write(id: string, data: string) {
    this.terminals.get(id)?.pty?.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    try {
      this.terminals.get(id)?.pty?.resize(cols, rows)
    } catch {
      // terminal already exited
    }
  }

  rename(id: string, title: string) {
    const entry = this.terminals.get(id)
    if (!entry) return
    entry.info = { ...entry.info, title: title.slice(0, 80) }
    this.onChange()
  }

  /** Ends the process (if any) and forgets the terminal. */
  kill(id: string) {
    const entry = this.terminals.get(id)
    if (!entry) return
    try {
      entry.pty?.kill()
    } catch {
      // already gone
    }
    this.terminals.delete(id)
    this.onChange()
  }

  killAll() {
    for (const entry of this.terminals.values()) {
      try {
        entry.pty?.kill()
      } catch {
        // already gone
      }
    }
  }

  /** Output and configuration of every terminal, persisted when the app quits. */
  snapshot(): PersistedTerminal[] {
    return [...this.terminals.values()].map((entry) => ({
      title: entry.info.title,
      cwd: entry.info.cwd,
      projectId: entry.info.projectId,
      scrollback: entry.buffer.toString(PERSISTED_SCROLLBACK_BYTES),
      endedAt: entry.info.endedAt ?? new Date().toISOString(),
    }))
  }

  /** Terminals of the previous app session: history and configuration only, no process. */
  restore(previous: PersistedTerminal[]) {
    for (const item of previous.slice(0, MAX_TERMINALS)) {
      const id = this.nextId()
      const buffer = new ScrollbackBuffer(SCROLLBACK_BYTES)
      buffer.append(item.scrollback)
      buffer.append(`\r\n\x1b[90m[Sitzung vom ${new Date(item.endedAt).toLocaleString()} – der Prozess wurde mit der App beendet. Verlauf wiederhergestellt.]\x1b[0m\r\n`)
      this.terminals.set(id, { info: { id, title: item.title, cwd: item.cwd, projectId: item.projectId, status: 'restored', startedAt: item.endedAt, endedAt: item.endedAt }, buffer })
    }
  }
}

export function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value).replaceAll('\\', '/')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
