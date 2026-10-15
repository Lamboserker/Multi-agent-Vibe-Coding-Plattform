/** Contract between preload (main world bridge) and renderer. */

export interface RuntimeStatus {
  state: 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'
  port?: number
  pid?: number
  restarts: number
  lastError?: string
  logFile: string
  log?: string[]
}

export interface AppEvent {
  channel: 'run' | 'models' | 'orchestrator' | 'jobs' | 'system' | 'project'
  type: string
  subject?: string
  data: Record<string, unknown>
  ts: string
}

export interface ApiResponse<T = unknown> {
  status: number
  data: T
}

export interface StateDocument<T = unknown> {
  version: number
  savedAt: string
  data: T
}

export type StateSetResult = { ok: true; version: number } | { ok: false; reason: 'stale_epoch' | 'too_large' | 'invalid' }

export interface DraftEntry {
  path: string
  content: string
  baseMtimeMs?: number
  savedAt: string
}

export interface FlushPayload {
  epoch: string
  writes?: Array<{ key: string; data: unknown }>
  drafts?: Array<{ projectKey: string; entry: { path: string; content: string; baseMtimeMs?: number } | null; path?: string }>
}

export interface TerminalInfo {
  id: string
  title: string
  cwd?: string
  command?: string[]
  projectId?: string
  pid?: number
  /** restored = output of a terminal from the previous app session (no process). */
  status: 'running' | 'exited' | 'restored'
  exitCode?: number
  startedAt: string
  endedAt?: string
}

export interface MacBridge {
  api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResponse<T>>
  /** Runtime events; the main process delivers them in batches through a single IPC channel. */
  onEvent(listener: (event: AppEvent) => void): () => void
  runtime: {
    status(): Promise<RuntimeStatus>
    restart(): Promise<RuntimeStatus>
    onStatus(listener: (status: RuntimeStatus) => void): () => void
  }
  app: {
    info(): Promise<{ version: string; platform: string; arch: string; electron: string; chrome: string; node: string; dataDir: string; packaged: boolean }>
    /** CPU and memory of every Electron process (diagnostics). */
    metrics(): Promise<Array<{ pid: number; type: string; name?: string; cpuPercent: number; workingSetMb: number }>>
    /** The app is quitting: write pending state, then call flushed(). */
    onFlushRequest(listener: () => void): () => void
    flushed(): void
  }
  dialog: {
    openFolder(title?: string): Promise<string | null>
    /** Save dialog + write; resolves with the chosen path or null when cancelled. */
    saveText(defaultName: string, content: string): Promise<string | null>
  }
  shell: { openExternal(url: string): Promise<boolean>; showItem(target: string): Promise<boolean> }
  /** Encrypted secrets (scope e.g. "plugin:github"); values can be written but never read back. */
  secrets: {
    set(scope: string, name: string, value: string): Promise<boolean>
    delete(scope: string, name: string): Promise<boolean>
    names(scope: string): Promise<{ available: boolean; names: string[] }>
  }
  state: {
    hello(epoch: string): Promise<boolean>
    get<T = unknown>(key: string): Promise<StateDocument<T> | null>
    set(key: string, data: unknown, epoch: string): Promise<StateSetResult>
    /** Synchronous write of everything pending (page unload). */
    flushSync(payload: FlushPayload): boolean
  }
  drafts: {
    put(projectKey: string, entry: { path: string; content: string; baseMtimeMs?: number }, epoch: string): Promise<StateSetResult>
    delete(projectKey: string, path: string, epoch: string): Promise<StateSetResult>
    list(projectKey: string): Promise<DraftEntry[]>
  }
  terminal: {
    history(id: string): Promise<string[]>
    create(options: { cols: number; rows: number; cwd?: string; command?: string[]; title?: string; projectId?: string; replaces?: string }): Promise<TerminalInfo>
    list(projectId?: string): Promise<TerminalInfo[]>
    attach(id: string): Promise<{ info: TerminalInfo; scrollback: string } | null>
    rename(id: string, title: string): Promise<boolean>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): Promise<boolean>
    kill(id: string): Promise<boolean>
    onData(listener: (id: string, data: string) => void): () => void
    onExit(listener: (id: string, exitCode: number) => void): () => void
    onChanged(listener: () => void): () => void
  }
}
