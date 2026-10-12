import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveExecutable, runProcess } from '../util/process.js'
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
  const client = new OllamaClient(input.baseUrl)
  if (await client.isReachable()) return { started: false, message: 'Ollama is already running.' }
  const binary = findOllamaBinary()
  if (!binary) return { started: false, message: 'Ollama is not installed.' }

  const url = new URL(input.baseUrl)
  const env: NodeJS.ProcessEnv = { ...process.env, OLLAMA_HOST: `${url.hostname}:${url.port || '11434'}` }
  if (input.modelsDir) env.OLLAMA_MODELS = input.modelsDir
  const child = spawn(binary, ['serve'], { env, detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()

  const deadline = Date.now() + (input.timeoutMs ?? 25_000)
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (await client.isReachable()) return { started: true, pid: child.pid, message: 'Ollama server started.' }
    if (child.exitCode !== null) return { started: false, message: `ollama serve exited with code ${child.exitCode}.` }
  }
  return { started: false, pid: child.pid, message: 'Ollama did not become reachable in time.' }
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
