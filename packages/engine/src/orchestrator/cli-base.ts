import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { killProcessTree, resolveExecutable, runProcess, withoutApiBillingKeys, type ProcessResult } from '../util/process.js'
import { OrchestratorError, type CallContext, type OrchestratorEvent } from './types.js'

export interface CliAdapterOptions {
  /** Explicit path to the CLI binary (otherwise PATH and known install locations are searched). */
  binaryPath?: string
  /** "subscription" strips API-key variables so the CLI cannot silently switch to paid API billing. */
  authMode?: 'subscription' | 'api_key'
  model?: string
  defaultTimeoutMs?: number
}

export abstract class CliOrchestratorBase {
  private readonly processes = new Map<string, Set<ChildProcess>>()
  private readonly cancelled = new Set<string>()

  constructor(protected readonly options: CliAdapterOptions = {}) {}

  protected abstract readonly binaryName: string
  protected abstract readonly knownLocations: string[]
  /** Env keys that would make the CLI bill an API key instead of the subscription. */
  protected abstract readonly apiBillingEnvKeys: string[]

  resolveBinary(): string | undefined {
    if (this.options.binaryPath) return existsSync(this.options.binaryPath) ? this.options.binaryPath : undefined
    return resolveExecutable(this.binaryName) ?? this.knownLocations.find((candidate) => existsSync(candidate))
  }

  protected requireBinary(): string {
    const binary = this.resolveBinary()
    if (!binary) throw new OrchestratorError(`${this.binaryName} CLI is not installed or not on PATH.`, 'not_installed', { retryable: false })
    return binary
  }

  protected childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env, NO_COLOR: '1' }
    return this.options.authMode === 'api_key' ? env : withoutApiBillingKeys(env, this.apiBillingEnvKeys)
  }

  /** Runs the CLI, parses JSONL from stdout and forwards each object to `onJson`. */
  protected async runJsonl(
    args: string[],
    ctx: CallContext,
    input: string,
    onJson: (event: Record<string, unknown>) => void,
  ): Promise<ProcessResult> {
    const binary = this.requireBinary()
    this.cancelled.delete(ctx.runId)
    let buffer = ''
    let handlerError: unknown
    const dispatch = (line: string) => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        return // non-JSON diagnostic line
      }
      try {
        onJson(parsed)
      } catch (error) {
        handlerError ??= error
      }
    }
    const handleChunk = (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('{')) dispatch(line)
        newline = buffer.indexOf('\n')
      }
    }

    const result = await runProcess(binary, args, {
      cwd: ctx.cwd,
      env: this.childEnv(),
      input,
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs ?? this.options.defaultTimeoutMs ?? 15 * 60_000,
      maxOutputBytes: 16 * 1024 * 1024,
      onStdout: handleChunk,
      onSpawn: (child) => this.track(ctx.runId, child),
    })
    if (buffer.trim().startsWith('{')) dispatch(buffer.trim())
    this.untrack(ctx.runId)

    if (result.spawnError) throw new OrchestratorError(`Could not start ${this.binaryName}: ${result.spawnError}`, 'not_installed', { retryable: false })
    if (this.cancelled.has(ctx.runId) || result.aborted) throw new OrchestratorError('Orchestrator call was cancelled.', 'cancelled', { retryable: false })
    if (result.timedOut) throw new OrchestratorError(`${this.binaryName} did not finish within the time limit.`, 'timeout', { retryable: true })
    if (handlerError) throw handlerError
    return result
  }

  protected emit(ctx: CallContext, event: OrchestratorEvent) {
    try {
      ctx.onEvent?.(event)
    } catch {
      // listeners must not break the call
    }
  }

  private track(runId: string, child: ChildProcess) {
    const set = this.processes.get(runId) ?? new Set<ChildProcess>()
    set.add(child)
    this.processes.set(runId, set)
    child.once('close', () => set.delete(child))
  }

  private untrack(runId: string) {
    const set = this.processes.get(runId)
    if (set && set.size === 0) this.processes.delete(runId)
  }

  async cancelRun(runId: string): Promise<void> {
    this.cancelled.add(runId)
    for (const child of this.processes.get(runId) ?? []) killProcessTree(child)
    this.processes.delete(runId)
  }

  protected async version(binary: string): Promise<string | undefined> {
    const result = await runProcess(binary, ['--version'], { timeoutMs: 15_000, env: this.childEnv() })
    return `${result.stdout} ${result.stderr}`.match(/(\d+\.\d+\.\d+[\w.-]*)/)?.[1]
  }
}

/** Shared classification of CLI failure text. */
export function classifyCliFailure(text: string, binaryName: string): OrchestratorError {
  const message = text.trim().slice(0, 1500) || `${binaryName} exited with an error.`
  if (/not supported when using .* with a ChatGPT account|model .*(not found|does not exist|not supported|unavailable)|unknown model/i.test(text)) {
    return new OrchestratorError(message, 'model_unavailable', { retryable: false })
  }
  if (/oauth token (has )?expired|token expired|session expired|refresh token/i.test(text)) {
    return new OrchestratorError(message, 'session_expired', { retryable: false })
  }
  if (/not logged in|please (run )?\/?login|invalid api key|authentication_error|unauthori[sz]ed|\b401\b|login required|codex login/i.test(text)) {
    return new OrchestratorError(message, 'not_authenticated', { retryable: false })
  }
  if (/usage limit|limit reached|quota|exceeded your current|out of credits|credit balance/i.test(text)) {
    const reset = text.match(/reset[s]?\s*(?:at|in)?\s*[:|]?\s*([0-9T:\-+.Z ]{8,}|\d{9,})/i)?.[1]?.trim()
    return new OrchestratorError(message, 'quota_exhausted', { retryable: false, resetsAt: reset })
  }
  if (/rate.?limit|\b429\b|overloaded|too many requests|\b529\b/i.test(text)) {
    return new OrchestratorError(message, 'rate_limited', { retryable: true })
  }
  return new OrchestratorError(message, 'process_failed', { retryable: true })
}
