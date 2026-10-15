import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { killProcessTree, resolveExecutable, runProcess } from '../util/process.js'
import { windowsJobCommand } from '../util/windows-job.js'
import { OllamaClient } from './client.js'

export interface OllamaInstallation {
  installed: boolean
  binary?: string
  version?: string
  reachable: boolean
  serverVersion?: string
  baseUrl: string
}

export interface OllamaInstallPlan {
  method: 'winget' | 'brew' | 'manual' | 'script-manual'
  /** Command that will be executed after explicit user consent (winget/brew only). */
  command?: string[]
  /** Command the user runs themselves (Linux needs sudo; never executed by the app). */
  manualCommand?: string
  downloadUrl: string
  requiresAdmin: boolean
  explanation: string
}

const KNOWN_LOCATIONS: Record<string, string[]> = {
  win32: [path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe')],
  darwin: ['/Applications/Ollama.app/Contents/Resources/ollama', '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama'],
  linux: ['/usr/local/bin/ollama', '/usr/bin/ollama'],
}

export function findOllamaBinary(): string | undefined {
  return resolveExecutable('ollama') ?? (KNOWN_LOCATIONS[process.platform] ?? []).find((candidate) => existsSync(candidate))
}

export async function detectOllama(baseUrl: string): Promise<OllamaInstallation> {
  const binary = findOllamaBinary()
  let version: string | undefined
  if (binary) {
    const result = await runProcess(binary, ['--version'], { timeoutMs: 10_000 })
    version = `${result.stdout}\n${result.stderr}`.match(/(\d+\.\d+\.\d+)/)?.[1]
  }
  const client = new OllamaClient(baseUrl)
  let serverVersion: string | undefined
  try {
    serverVersion = await client.version()
  } catch {
    serverVersion = undefined
  }
  return { installed: Boolean(binary), binary, version, reachable: Boolean(serverVersion), serverVersion, baseUrl }
}

/**
 * Starts `ollama serve` in the background if Ollama is installed but not running.
 * OLLAMA_HOST/OLLAMA_MODELS are only set when explicitly configured.
 */
export async function startOllamaServer(input: { baseUrl: string; modelsDir?: string; timeoutMs?: number }): Promise<{ started: boolean; pid?: number; message: string }> {
  const key = new URL(input.baseUrl).origin
  const pending = starts.get(key)
  if (pending) return pending
  const promise = startOwnedOllama(input).finally(() => starts.delete(key))
  starts.set(key, promise)
  return promise
}

const ownedServers = new Map<string, ChildProcess>()
const starts = new Map<string, Promise<{ started: boolean; pid?: number; message: string }>>()
let ownershipEpoch = 0

/** Stops only process handles created by this runtime, never a discovered external server. */
export async function stopOwnedOllamaServers(): Promise<void> {
  ownershipEpoch++
  await Promise.all([...ownedServers.values()].map(async (child) => {
    const closed = new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once('close', () => resolve()) })
    killProcessTree(child)
    await Promise.race([closed, new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5000); timer.unref() })])
  }))
  ownedServers.clear()
}

async function startOwnedOllama(input: { baseUrl: string; modelsDir?: string; timeoutMs?: number }): Promise<{ started: boolean; pid?: number; message: string }> {
  const epoch = ownershipEpoch
  const client = new OllamaClient(input.baseUrl)
  if (await client.isReachable()) return { started: false, message: 'Ollama is already running.' }
  const key = new URL(input.baseUrl).origin
  if (ownedServers.has(key)) return { started: false, pid: ownedServers.get(key)?.pid, message: 'An owned Ollama start is already active; no duplicate was started.' }
  const binary = findOllamaBinary()
  if (!binary) return { started: false, message: 'Ollama is not installed.' }

  const url = new URL(input.baseUrl)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return { started: false, message: 'An unreachable remote Ollama endpoint cannot be started locally.' }
  const env: NodeJS.ProcessEnv = { ...process.env, OLLAMA_HOST: `${url.hostname}:${url.port || '11434'}` }
  if (input.modelsDir) env.OLLAMA_MODELS = input.modelsDir
  if (epoch !== ownershipEpoch) return { started: false, message: 'Ollama startup cancelled by runtime shutdown.' }
  const command = process.platform === 'win32' ? windowsJobCommand(binary, ['serve']) : { file: binary, args: ['serve'] }
  const child = spawn(command.file, command.args, { env, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true })
  ownedServers.set(key, child)
  let spawnError: string | undefined
  child.on('error', (error) => { spawnError = error.message; if (ownedServers.get(key) === child) ownedServers.delete(key) })
  child.once('close', () => { if (ownedServers.get(key) === child) ownedServers.delete(key) })
  child.unref()

  const deadline = Date.now() + (input.timeoutMs ?? 25_000)
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (spawnError) return { started: false, message: `Ollama could not be started: ${spawnError}` }
    if (child.exitCode !== null) return { started: false, message: `ollama serve exited with code ${child.exitCode}.` }
    if (await client.isReachable()) return { started: true, pid: child.pid, message: 'Ollama server started (owned by this runtime).' }
  }
  await stopOwnedServer(key, child)
  return { started: false, message: 'Ollama did not become reachable in time; the owned process was stopped.' }
}

async function stopOwnedServer(key: string, child: ChildProcess) {
  killProcessTree(child)
  await Promise.race([new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once('close', () => resolve()) }), new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5000); timer.unref() })])
  if (ownedServers.get(key) === child) ownedServers.delete(key)
}

export async function ollamaInstallPlan(): Promise<OllamaInstallPlan> {
  const downloadUrl = 'https://ollama.com/download'
  if (process.platform === 'win32') {
    if (resolveExecutable('winget')) {
      return {
        method: 'winget',
        command: ['winget', 'install', '--id', 'Ollama.Ollama', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'],
        downloadUrl,
        requiresAdmin: false,
        explanation: 'Installs the official Ollama package via winget (per-user installer, ~1 GB download).',
      }
    }
    return { method: 'manual', downloadUrl, requiresAdmin: false, explanation: 'Download and run OllamaSetup.exe from ollama.com.' }
  }
  if (process.platform === 'darwin') {
    if (resolveExecutable('brew')) {
      return {
        method: 'brew',
        command: ['brew', 'install', '--cask', 'ollama'],
        downloadUrl,
        requiresAdmin: false,
        explanation: 'Installs the official Ollama app via Homebrew.',
      }
    }
    return { method: 'manual', downloadUrl, requiresAdmin: false, explanation: 'Download Ollama.app from ollama.com and move it to Applications.' }
  }
  return {
    method: 'script-manual',
    manualCommand: 'curl -fsSL https://ollama.com/install.sh | sh',
    downloadUrl,
    requiresAdmin: true,
    explanation: 'The official Linux installer needs sudo. Run the command in a terminal yourself; the app never runs it.',
  }
}

/** Executes the consented install plan (winget / brew only). */
export async function runOllamaInstall(plan: OllamaInstallPlan, onOutput: (line: string) => void, signal?: AbortSignal) {
  if (!plan.command || (plan.method !== 'winget' && plan.method !== 'brew')) {
    throw new Error('This platform requires a manual Ollama installation.')
  }
  const [binary, ...args] = plan.command
  const result = await runProcess(binary!, args, {
    timeoutMs: 20 * 60_000,
    signal,
    onStdout: (chunk) => chunk.split(/\r?\n/).filter(Boolean).forEach(onOutput),
    onStderr: (chunk) => chunk.split(/\r?\n/).filter(Boolean).forEach(onOutput),
  })
  return { ok: result.exitCode === 0, exitCode: result.exitCode, output: (result.stdout + result.stderr).slice(-4000) }
}
