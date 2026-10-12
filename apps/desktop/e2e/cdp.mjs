// Minimal Chrome-DevTools-Protocol harness for scenarios Playwright cannot follow (a crashed and
// reloaded renderer target). Starts the built app directly with a debugging port and reconnects to
// whatever page target is current.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { appDir, waitUntil } from './helpers.mjs'

const require = createRequire(import.meta.url)

export async function launchWithCdp(profile, port = 9300 + Math.floor(Math.random() * 500)) {
  const electron = require(path.join(appDir, 'node_modules', 'electron'))
  const env = { ...process.env, MAC_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], { cwd: appDir, env, stdio: 'ignore' })
  const exited = new Promise((resolve) => child.once('exit', resolve))

  async function pageTarget() {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return targets.find((target) => target.type === 'page' && target.url.startsWith('app://renderer'))
  }

  /** Evaluates an expression in the current page target (a new connection per call survives reloads). */
  async function evaluate(expression, timeoutMs = 5000) {
    const target = await pageTarget()
    if (!target) throw new Error('no page target')
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    try {
      await new Promise((resolve, reject) => {
        socket.onopen = resolve
        socket.onerror = () => reject(new Error('cdp connect failed'))
      })
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cdp evaluate timeout')), timeoutMs)
        socket.onmessage = (message) => {
          const data = JSON.parse(String(message.data))
          if (data.id !== 1) return
          clearTimeout(timer)
          if (data.error || data.result?.exceptionDetails) reject(new Error(JSON.stringify(data.error ?? data.result.exceptionDetails).slice(0, 300)))
          else resolve(data.result.result.value)
        }
        socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      })
    } finally {
      socket.close()
    }
  }

  /** Crashes the renderer process of the page (Chromium's own crash path). */
  async function crashRenderer() {
    const target = await pageTarget()
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve) => (socket.onopen = resolve))
    socket.send(JSON.stringify({ id: 1, method: 'Page.crash' }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    socket.close()
  }

  async function close() {
    await evaluate('window.close()', 2000).catch(() => undefined)
    const timer = setTimeout(() => child.kill(), 30_000)
    await exited
    clearTimeout(timer)
  }

  await waitUntil(async () => (await evaluate('window.mac.runtime.status().then((status) => status.state)')) === 'ready', 120_000, 'runtime ready (cdp)', 500)
  return { evaluate, crashRenderer, close, child }
}
