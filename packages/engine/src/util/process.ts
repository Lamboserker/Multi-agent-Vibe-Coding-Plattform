import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { windowsJobCommand } from './windows-job.js'

export interface RunProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Written to stdin, then stdin is closed. Prompts are passed this way to avoid shell quoting. */
  input?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Output beyond this many bytes per stream is dropped (the tail is kept). */
  maxOutputBytes?: number
  /** Fail rather than silently truncate a structured response. */
  failOnOutputLimit?: boolean
  /** Own all descendants through an OS job/process group, including successful completion. */
  cleanupChildren?: boolean
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  onSpawn?: (child: ChildProcess) => void
}

export interface ProcessResult {
  command: string
  args: string[]
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  durationMs: number
  /** Present when the binary could not be started at all (ENOENT etc.). */
  spawnError?: string
  outputLimitExceeded?: boolean
}

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024
const isWindows = process.platform === 'win32'

/** Owned stdio process for long-lived protocol clients such as language servers. */
export function spawnOwnedProcess(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}): ChildProcessWithoutNullStreams {
  const owned = isWindows ? windowsJobCommand(command, args) : { file: command, args }
  const child = spawn(owned.file, owned.args, { ...options, detached: !isWindows, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  if (!isWindows) child.once('exit', () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* group gone */ } })
  return child
}

/** Resolves a binary on PATH (honouring PATHEXT on Windows). Returns undefined when not found. */
export function resolveExecutable(command: string, envPath = process.env.PATH ?? process.env.Path ?? ''): string | undefined {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return isFile(command) ? command : undefined
  }
  const extensions = isWindows
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase())]
    : ['']
  for (const directory of envPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension)
      // On Windows an extension-less file (e.g. npm's POSIX shim) is not directly executable.
      if (isWindows && extension === '' && !path.extname(command)) continue
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

function isFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Resolves the JavaScript entry point behind an npm/cmd-shim wrapper (e.g. claude.cmd, codex.cmd)
 * so that it can be started with node directly. Returns undefined for other .cmd files.
 */
export function resolveNodeShim(cmdPath: string): string | undefined {
  let content: string
  try {
    content = readFileSync(cmdPath, 'utf8')
  } catch {
    return undefined
  }
  const match = content.match(/"%~?dp0%?\\?([^"%]+?\.[cm]?js)"/i)
  if (!match?.[1]) return undefined
  const target = path.join(path.dirname(cmdPath), match[1].replace(/^\\+/, ''))
  return existsSync(target) ? target : undefined
}

/** Quotes one argument for cmd.exe (used only for .cmd/.bat shims such as npm.cmd / pnpm.cmd). */
export function quoteForCmd(arg: string): string {
  if (/[\r\n]/.test(arg)) throw new Error('Arguments for .cmd/.bat shims must not contain line breaks; pass them via stdin instead.')
  if (arg === '') return '""'
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').replace(/%/g, '"^%"')}"`
}

/**
 * Spawns a process without a shell. On Windows, .cmd/.bat shims are executed through cmd.exe
 * with strictly quoted arguments (Node refuses to spawn them directly since CVE-2024-27980).
 */
export function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  const started = Date.now()
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
  const env = options.env ?? process.env
  const resolved = resolveExecutable(command, env.PATH ?? env.Path ?? process.env.PATH ?? '') ?? command

  let file = resolved
  let finalArgs = args
  let windowsVerbatimArguments = false
  const shimTarget = isWindows && /\.(cmd|bat)$/i.test(resolved) ? resolveNodeShim(resolved) : undefined
  if (shimTarget) {
    // npm/cmd-shim wrapper: run the JS entry point with node directly (no cmd.exe quoting).
    const node = resolveExecutable('node', env.PATH ?? env.Path ?? process.env.PATH ?? '')
    file = node ?? process.execPath
    finalArgs = [shimTarget, ...args]
  } else if (isWindows && /\.(cmd|bat)$/i.test(resolved)) {
    file = process.env.ComSpec ?? 'cmd.exe'
    finalArgs = ['/d', '/s', '/c', `"${[quoteForCmd(resolved), ...args.map(quoteForCmd)].join(' ')}"`]
    windowsVerbatimArguments = true
  }

  const spawnEnv = shimTarget && !resolveExecutable('node', env.PATH ?? env.Path ?? process.env.PATH ?? '') ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env
  if (isWindows && options.cleanupChildren) {
    const owned = windowsJobCommand(file, finalArgs, windowsVerbatimArguments)
    file = owned.file
    finalArgs = owned.args
    windowsVerbatimArguments = false
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let child: ChildProcess
    let timer: NodeJS.Timeout | undefined
    let outputLimitExceeded = false
    let outputBytes = 0
    let callbackError: string | undefined
    const onAbort = () => { aborted = true; if (child) killProcessTree(child) }

    const finish = (result: Partial<ProcessResult>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        command,
        args,
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        aborted,
        outputLimitExceeded,
        durationMs: Date.now() - started,
        ...result,
      })
    }

    if (options.signal?.aborted) { aborted = true; finish({}); return }

    try {
      child = spawn(file, finalArgs, {
        cwd: options.cwd,
        env: spawnEnv,
        windowsHide: true,
        windowsVerbatimArguments,
        detached: !isWindows,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ spawnError: error instanceof Error ? error.message : String(error) })
      return
    }

    try { options.onSpawn?.(child) } catch (error) {
      killProcessTree(child)
      child.once('close', () => finish({ spawnError: error instanceof Error ? error.message : String(error) }))
    }
    timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          killProcessTree(child)
        }, options.timeoutMs)
      : undefined
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (options.failOnOutputLimit && outputBytes > maxOutput) { outputLimitExceeded = true; killProcessTree(child); return }
      stdout = appendCapped(stdout, chunk, maxOutput)
      try { options.onStdout?.(chunk) } catch (error) { callbackError = String(error); killProcessTree(child) }
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk, maxOutput)
      try { options.onStderr?.(chunk) } catch (error) { callbackError = String(error); killProcessTree(child) }
    })
    child.on('error', (error) => finish({ spawnError: error.message }))
    child.on('close', (exitCode, signal) => finish({ exitCode, signal, ...(callbackError ? { spawnError: callbackError } : {}) }))
    if (!isWindows && options.cleanupChildren) child.once('exit', () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* group already gone */ }
    })

    child.stdin?.on('error', () => {
      // The process may exit before reading stdin; that is reported through the exit code.
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
  })
}

function appendCapped(current: string, chunk: string, max: number): string {
  const next = current + chunk
  const bytes = Buffer.from(next)
  return bytes.length > max ? bytes.subarray(bytes.length - max).toString('utf8') : next
}

/** Kills a process and all of its children (taskkill /T on Windows, process group elsewhere). */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    if (isWindows) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { try { child.kill('SIGKILL') } catch { /* gone */ } })
    } else {
      process.kill(-child.pid, 'SIGTERM')
      setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }, 3000).unref()
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

const SECRET_ENV_PATTERN = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|SESSION|COOKIE|DATABASE_URL|_DSN$)/i

/**
 * Environment for untrusted commands (tests, typechecks, model-proposed commands): keeps what
 * toolchains need (PATH, HOME, temp, locale, proxy) and drops anything that looks like a secret.
 */
export function sanitizedEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (SECRET_ENV_PATTERN.test(key)) continue
    if (key.startsWith('MAC_')) continue
    env[key] = value
  }
  env.CI = env.CI ?? '1'
  env.FORCE_COLOR = '0'
  return { ...env, ...extra }
}

/** Removes keys that would silently switch a subscription-authenticated CLI to paid API billing. */
export function withoutApiBillingKeys(base: NodeJS.ProcessEnv, keys: string[]): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of keys) delete env[key]
  return env
}
