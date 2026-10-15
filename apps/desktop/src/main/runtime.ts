import { app, utilityProcess, type UtilityProcess } from 'electron'
import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs'
import path from 'node:path'
import { resourcePaths } from './paths.js'

export type RuntimeState = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'

export interface RuntimeStatus {
  state: RuntimeState
  port?: number
  pid?: number
  restarts: number
  lastError?: string
  logFile: string
}

type Listener = (status: RuntimeStatus) => void
type EventListener = (event: unknown) => void

/**
 * Supervises the local backend (NestJS runtime) as an Electron utility process:
 * random port on 127.0.0.1, per-launch bearer token, crash restart with backoff,
 * graceful shutdown, log file, and the Server-Sent-Events subscription.
 */
export class RuntimeManager {
  private child?: UtilityProcess
  private readonly token = randomBytes(32).toString('base64url')
  private status: RuntimeStatus
  private readonly listeners = new Set<Listener>()
  private readonly eventListeners = new Set<EventListener>()
  private readonly recentLog: string[] = []
  private log?: WriteStream
  private quitting = false
  private crashTimes: number[] = []
  private readyWaiters: Array<(port: number) => void> = []
  private sseAbort?: AbortController
  private shellHandler?: (method: string, params: Record<string, unknown>) => unknown

  constructor(private readonly dataDir: string) {
    const logsDir = path.join(dataDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    this.status = { state: 'stopped', restarts: 0, logFile: path.join(logsDir, 'runtime.log') }
  }

  get current(): RuntimeStatus {
    return { ...this.status }
  }

  logTail(): string[] {
    return [...this.recentLog]
  }

  onStatus(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Answers requests the runtime sends to the shell (e.g. secrets that only the shell can decrypt). */
  onShellRequest(handler: (method: string, params: Record<string, unknown>) => unknown) {
    this.shellHandler = handler
  }

  onEvent(listener: EventListener) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  private setStatus(patch: Partial<RuntimeStatus>) {
    this.status = { ...this.status, ...patch }
    for (const listener of this.listeners) listener(this.current)
  }

  private openLog() {
    try {
      if (statSync(this.status.logFile).size > 5 * 1024 * 1024) renameSync(this.status.logFile, `${this.status.logFile}.1`)
    } catch {
      // no previous log
    }
    this.log = createWriteStream(this.status.logFile, { flags: 'a' })
  }

  private writeLog(line: string) {
    const stamped = `[${new Date().toISOString()}] ${line}`
    this.recentLog.push(stamped)
    if (this.recentLog.length > 500) this.recentLog.shift()
    this.log?.write(`${stamped}\n`)
  }

  start() {
    if (this.child) return
    if (!this.log) this.openLog()
    const paths = resourcePaths()
    this.setStatus({ state: this.status.restarts ? 'restarting' : 'starting', port: undefined, lastError: undefined })
    this.writeLog(`starting runtime ${paths.backendEntry}`)

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
    Object.assign(env, {
      MAC_DESKTOP_TOKEN: this.token,
      MAC_PORT: '0',
      MAC_DATA_DIR: this.dataDir,
      MAC_MIGRATIONS_DIR: paths.migrationsDir,
      MAC_BUILTIN_PLUGINS_DIR: paths.pluginsDir,
      MAC_BUILTIN_SKILLS_DIR: paths.skillsDir,
      NODE_ENV: app.isPackaged ? 'production' : 'development',
    })
    delete env.DATABASE_URL // the runtime always uses the per-user SQLite database
    delete env.ELECTRON_RUN_AS_NODE

    const child = utilityProcess.fork(paths.backendEntry, [], { env, stdio: 'pipe', serviceName: 'Multi-AI Coder Runtime' })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/).filter(Boolean)) this.writeLog(line)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/).filter(Boolean)) this.writeLog(`ERR ${line}`)
    })
    child.on('message', (message: { type?: string; port?: number; id?: number; method?: string; params?: Record<string, unknown> }) => {
      if (message?.type === 'shell-request' && typeof message.id === 'number') {
        const id = message.id
        void Promise.resolve()
          .then(() => {
            if (!this.shellHandler) throw new Error('No shell handler.')
            return this.shellHandler(String(message.method), message.params ?? {})
          })
          .then(
            (value) => child.postMessage({ type: 'shell-response', id, ok: true, value: value ?? null }),
            (error: unknown) => child.postMessage({ type: 'shell-response', id, ok: false, error: error instanceof Error ? error.message : String(error) }),
          )
        return
      }
      if (message?.type === 'ready' && message.port) {
        this.setStatus({ state: 'ready', port: message.port, pid: child.pid })
        this.writeLog(`runtime ready on 127.0.0.1:${message.port}`)
        for (const waiter of this.readyWaiters.splice(0)) waiter(message.port)
        this.subscribeEvents(message.port)
      }
    })
    child.on('exit', (code) => {
      this.child = undefined
      this.sseAbort?.abort()
      this.writeLog(`runtime exited with code ${code}`)
      if (this.quitting) {
        this.setStatus({ state: 'stopped', port: undefined })
        return
      }
      const now = Date.now()
      this.crashTimes = [...this.crashTimes.filter((time) => now - time < 5 * 60_000), now]
      if (this.crashTimes.length > 5) {
        this.setStatus({ state: 'failed', port: undefined, lastError: `The local runtime crashed ${this.crashTimes.length} times in 5 minutes. See ${this.status.logFile}.` })
        return
      }
      const delay = Math.min(15_000, 1000 * 2 ** (this.crashTimes.length - 1))
      this.setStatus({ state: 'restarting', port: undefined, restarts: this.status.restarts + 1, lastError: `Runtime exited (code ${code}); restarting in ${delay / 1000}s.` })
      setTimeout(() => this.start(), delay)
    })
  }

  /** Resolves with the port once the runtime is ready (or rejects after a timeout). */
  ready(timeoutMs = 60_000): Promise<number> {
    if (this.status.state === 'ready' && this.status.port) return Promise.resolve(this.status.port)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Local runtime not ready after ${timeoutMs / 1000}s (${this.status.lastError ?? this.status.state}).`)), timeoutMs)
      this.readyWaiters.push((port) => {
        clearTimeout(timer)
        resolve(port)
      })
    })
  }

  /** Forwards a validated request to the runtime with the per-launch token. */
  async request(method: string, requestPath: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    let response: Response
    try {
      const port = await this.ready()
      response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      // Runtime restarting or stopping: report a clean "unavailable" instead of an IPC exception.
      return { status: 503, data: { message: `Die lokale Laufzeit ist gerade nicht erreichbar (${this.status.state}). ${error instanceof Error ? error.message : ''}`.trim() } }
    }
    const text = await response.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      // plain text response
    }
    return { status: response.status, data }
  }

  private subscribeEvents(port: number) {
    this.sseAbort?.abort()
    const controller = new AbortController()
    this.sseAbort = controller
    const connect = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/events`, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' }, signal: controller.signal })
          if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`)
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let separator = buffer.indexOf('\n\n')
            while (separator !== -1) {
              const block = buffer.slice(0, separator)
              buffer = buffer.slice(separator + 2)
              const data = block
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n')
              if (data) {
                try {
                  const event = JSON.parse(data) as unknown
                  for (const listener of this.eventListeners) listener(event)
                } catch {
                  // ignore malformed event
                }
              }
              separator = buffer.indexOf('\n\n')
            }
          }
        } catch {
          if (controller.signal.aborted) return
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }
    void connect()
  }

  /** Graceful shutdown: ask the runtime to stop (it marks active runs as interrupted), then kill after a timeout. */
  async stop(timeoutMs = 10_000) {
    this.quitting = true
    this.sseAbort?.abort()
    const child = this.child
    if (!child) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.postMessage({ type: 'shutdown' })
      } catch {
        child.kill()
      }
    })
    this.log?.end()
  }

  restart() {
    this.quitting = false
    this.crashTimes = []
    if (this.child) this.child.kill()
    else this.start()
  }
}
