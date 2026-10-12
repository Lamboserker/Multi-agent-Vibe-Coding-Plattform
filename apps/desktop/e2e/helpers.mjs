// Shared helpers for the GUI end-to-end tests (Playwright for Electron, real app, real runtime).
import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const here = path.dirname(fileURLToPath(import.meta.url))
export const appDir = path.resolve(here, '..')
export const resultsDir = path.join(here, 'results')

/** Polls an async condition from the test process. */
export async function waitUntil(condition, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await condition()
      if (last) return last
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for: ${label}${last instanceof Error ? ` (${last.message})` : ''}`)
}

const run = (command, args, cwd) => execSync([command, ...args].join(' '), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** A throwaway git repository with the React fixture (optionally with installed dependencies). */
export function prepareRepository({ install = false } = {}) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'mac-e2e-repo-'))
  cpSync(path.join(here, 'fixtures', 'react-app'), repo, { recursive: true })
  if (install) run('pnpm', ['install', '--ignore-workspace', '--prefer-offline', '--silent'], repo)
  run('git', ['init', '-q', '-b', 'main'], repo)
  run('git', ['add', '-A'], repo)
  run('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'fixture'], repo)
  return repo
}

export function newProfile() {
  return mkdtempSync(path.join(os.tmpdir(), 'mac-e2e-profile-'))
}

/** Launches the built desktop app with an isolated user-data directory. */
export async function launch(profile, extraEnv = {}) {
  const { _electron: electron } = await import(pathToFileURL(path.join(appDir, 'node_modules', 'playwright-core', 'index.mjs')).href)
  const env = { ...process.env, MAC_USER_DATA_DIR: profile, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ cwd: appDir, args: ['.'], env })
  const page = await app.firstWindow()
  const consoleErrors = []
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()))
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  const api = async (method, url, body) => {
    const response = await page.evaluate(([m, u, b]) => window.mac.api(m, u, b), [method, url, body])
    return response
  }
  await waitUntil(async () => (await page.evaluate(() => window.mac.runtime.status())).state === 'ready', 120_000, 'runtime ready')
  return { app, page, api, consoleErrors }
}

/** Gracefully quits the app (before-quit flushes the UI state and stops the runtime). */
export async function quit(app) {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined)
  await waitUntil(async () => app.process().exitCode !== null, 30_000, 'app exit').catch(async () => app.close())
}

export function stamp() {
  mkdirSync(resultsDir, { recursive: true })
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Answers the native folder dialog with `folder`. */
export async function answerFolderDialog(app, folder) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, folder)
}

/** p50/p95 of a list of numbers. */
export function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1), min: sorted[0] }
}
