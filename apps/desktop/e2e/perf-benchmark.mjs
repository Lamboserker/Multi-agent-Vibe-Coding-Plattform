// Reproducible UI/runtime benchmark for the desktop app (Phase 0.3, 2.1/2.2).
// Works against the current build and against a build of an older version (same selectors), so
// before/after numbers come from the same procedure.
//
//   node e2e/perf-benchmark.mjs --label after  [--app <apps/desktop dir>] [--rounds 5] [--launches 3]
//
// Measurements inside the renderer run from the triggering DOM event to the next painted frame
// (two requestAnimationFrame callbacks), so Playwright round-trips are not included.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { appDir as defaultAppDir, newProfile, percentiles, prepareRepository, resultsDir, waitUntil } from './helpers.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []))
const label = args.label ?? 'run'
const appDir = path.resolve(args.app ?? defaultAppDir)
const rounds = Number(args.rounds ?? 5)
const launches = Number(args.launches ?? 3)
const results = { label, appDir, startedAt: new Date().toISOString(), environment: environment(), metrics: {} }

function environment() {
  return { os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1024 ** 3), node: process.version }
}

function record(name, values, extra = {}) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  results.metrics[name] = { ...percentiles(numbers), values: numbers.map((value) => Math.round(value * 10) / 10), ...extra }
  console.log(`[perf:${label}] ${name}`, JSON.stringify({ p50: results.metrics[name].p50, p95: results.metrics[name].p95, n: numbers.length }))
}

const { _electron: electron } = await import(pathToFileURL(path.join(defaultAppDir, 'node_modules', 'playwright-core', 'index.mjs')).href)

async function start(profile) {
  const env = { ...process.env, MAC_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const launchedAt = Date.now()
  // Same Chromium switches for every measured version: no throttling of occluded/background windows.
  const app = await electron.launch({ cwd: appDir, args: ['.', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion'], env })
  const page = await app.firstWindow()
  const api = (method, url, body) => page.evaluate(([m, u, b]) => window.mac.api(m, u, b), [method, url, body])
  // Frame-based measurements need a visible, unthrottled window (an occluded window gets ~1 frame/s).
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setBackgroundThrottling(false)
    window.showInactive()
  })
  return { app, page, api, launchedAt }
}

async function stop(app) {
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined)
  await waitUntil(async () => app.process().exitCode !== null, 30_000, 'exit').catch(() => app.close())
}

/** Installs measurement helpers in the page. */
async function instrument(page) {
  await page.evaluate(() => {
    const paint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const channel = new MessageChannel()
    const queue = []
    channel.port1.onmessage = () => queue.shift()?.()
    /** Yields one macrotask (not tied to frames, so it is not affected by frame throttling). */
    const tick = () => new Promise((resolve) => {
      queue.push(resolve)
      channel.port2.postMessage(0)
    })
    window.__perf = {
      paintSamples: [],
      longTasks: [],
      visibleHeader() {
        return [...document.querySelectorAll('.side-panel .panel-header h2')].find((element) => element.offsetParent !== null)?.textContent ?? ''
      },
      /** Clicks `selector` and resolves with the ms until `done()` is true and a frame was painted. */
      /** Median interval of 10 animation frames (≈16.7 ms when frames are not throttled). */
      async frameInterval() {
        const times = []
        let last = performance.now()
        for (let index = 0; index < 10; index += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve))
          const now = performance.now()
          times.push(now - last)
          last = now
        }
        return times.sort((a, b) => a - b)[5]
      },
      async clickUntil(selector, doneSource, timeoutMs = 10_000) {
        const done = new Function(`return (${doneSource})`)()
        const target = typeof selector === 'string' ? document.querySelector(selector) : selector
        if (!target) throw new Error(`missing ${selector}`)
        const started = performance.now()
        target.click()
        while (!done()) {
          if (performance.now() - started > timeoutMs) throw new Error(`timeout after click on ${selector}`)
          await tick()
        }
        const domMs = performance.now() - started
        await paint()
        window.__perf.paintSamples.push(performance.now() - started)
        return domMs
      },
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__perf.longTasks.push(entry.duration)
      }).observe({ type: 'longtask', buffered: true })
    } catch {
      // long task API unavailable
    }
  })
}

const VIEW_TITLES = [['Projekte'], ['Explorer'], ['Git'], ['Sitzungen', 'Aufgaben'], ['Agenten'], ['Modelle'], ['Nutzung & Kosten'], ['Einstellungen']]

async function viewSelector(page, titles) {
  for (const title of titles) if (await page.locator(`nav.activity-bar button[title="${title}"]`).count()) return `nav.activity-bar button[title="${title}"]`
  throw new Error(`no view button for ${titles.join('/')}`)
}

async function measureNavigation(page) {
  const cold = []
  const warm = []
  const perView = {}
  for (let round = 0; round < rounds + 1; round += 1) {
    for (const titles of VIEW_TITLES) {
      const selector = await viewSelector(page, titles)
      if (await page.locator(`${selector}.active`).count()) continue
      const ms = await page.evaluate(async (target) => {
        const before = window.__perf.visibleHeader()
        return window.__perf.clickUntil(target, `() => { const header = window.__perf.visibleHeader(); return header && header !== ${JSON.stringify(before)} && ![...document.querySelectorAll('.side-panel .spinner')].some((spinner) => spinner.offsetParent !== null) }`)
      }, selector)
      ;(round === 0 ? cold : warm).push(ms)
      if (round === 0) perView[titles[0]] = Math.round(ms)
    }
  }
  record('navigation_first_visit_ms', cold, { perView })
  record('navigation_ms', warm)
}

/**
 * Frame-dependent measurements (Monaco renders in animation frames) need an unthrottled window: it is
 * put on top without taking the keyboard focus, and the frame rate is checked before measuring.
 */
async function withFrames(app, page, name, fn) {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setAlwaysOnTop(true)
    window.showInactive()
  })
  let interval = await page.evaluate(() => window.__perf.frameInterval())
  for (let attempt = 0; interval > 40 && attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    interval = await page.evaluate(() => window.__perf.frameInterval())
  }
  try {
    const value = await fn()
    results.frameChecks = { ...(results.frameChecks ?? {}), [name]: { intervalMs: Math.round(interval * 10) / 10, valid: interval <= 40 } }
    return value
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setAlwaysOnTop(false))
  }
}

async function openFileMs(page, file, marker) {
  return page.evaluate(
    async ([path, text]) => {
      const item = [...document.querySelectorAll('.tree-item')].find((element) => element.getAttribute('title') === path && element.offsetParent !== null)
      if (!item) throw new Error(`no tree item ${path}`)
      return window.__perf.clickUntil(item, `() => [...document.querySelectorAll('.editor-host .view-lines')].some((lines) => lines.offsetParent !== null && lines.textContent.replace(/\\u00a0/g, ' ').includes(${JSON.stringify(text)}))`, 20_000)
    },
    [file, marker],
  )
}

async function main() {
  const repo = prepareRepository()
  const profile = newProfile()
  mkdirSync(resultsDir, { recursive: true })

  // --- first launch: configure, open project, create two planned tasks (fallback planner, no model) ---
  let session = await start(profile)
  let { app, page, api } = session
  await waitUntil(async () => (await page.evaluate(() => window.mac.runtime.status())).state === 'ready', 120_000, 'ready')
  await api('PATCH', '/settings', { orchestrator: null, planApproval: true })
  await api('POST', '/onboarding/complete')
  const opened = (await api('POST', '/projects/open', { path: repo })).data
  await page.reload()
  await page.waitForSelector('.ide', { timeout: 60_000 })
  await instrument(page)

  // API latencies (IPC + HTTP + SQLite)
  const apiTimes = {}
  for (const [name, url] of [['settings', '/settings'], ['projects', '/projects'], ['tree', `/projects/${opened.id}/tree?dir=src`], ['file', `/projects/${opened.id}/file?path=src%2FApp.tsx`], ['orchestrator_cached', '/orchestrator'], ['tasks', `/tasks?projectId=${opened.id}`]]) {
    apiTimes[name] = []
    for (let index = 0; index < 20; index += 1) {
      apiTimes[name].push(await page.evaluate(async (target) => {
        const started = performance.now()
        await window.mac.api('GET', target)
        return performance.now() - started
      }, url))
    }
    record(`api_${name}_ms`, apiTimes[name])
  }

  // planning without a model (repository analysis + routing + persistence)
  const planMs = []
  const hasSessions = (await api('GET', `/projects/${opened.id}/sessions`)).status === 200
  for (const prompt of ['Ergänze in src/App.tsx eine Überschrift', 'Füge der Badge-Komponente eine optionale Farbe hinzu']) {
    const started = Date.now()
    let taskId
    if (hasSessions) {
      const created = (await api('POST', `/projects/${opened.id}/sessions`, {})).data
      await api('POST', `/sessions/${created.id}/messages`, { content: prompt, mode: 'task' })
      taskId = await waitUntil(async () => (await api('GET', `/sessions/${created.id}`)).data.activeTaskId, 30_000, 'task')
    } else {
      taskId = (await api('POST', '/workspace/chat', { projectId: opened.id, content: prompt })).data.task.id
    }
    await waitUntil(async () => ['awaiting_plan_approval', 'planned'].includes((await api('GET', `/tasks/${taskId}`)).data.currentStep), 120_000, 'planned', 50)
    planMs.push(Date.now() - started)
  }
  record('fallback_plan_ms', planMs)

  results.frameIntervalMs = await page.evaluate(() => window.__perf.frameInterval())
  results.paintValid = results.frameIntervalMs < 40
  console.log(`[perf:${label}] frame interval ${results.frameIntervalMs.toFixed(1)} ms (paint timings ${results.paintValid ? 'valid' : 'NOT valid: frames throttled'})`)
  await measureNavigation(page)

  // switching between two loaded conversations (sessions / tasks)
  await page.locator(await viewSelector(page, ['Sitzungen', 'Aufgaben'])).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.side-panel .tree-item')].filter((element) => element.offsetParent !== null).length >= 2, null, { timeout: 30_000 })
  const switchMs = []
  for (let index = 0; index < rounds * 2; index += 1) {
    switchMs.push(await page.evaluate(async (position) => {
      const items = [...document.querySelectorAll('.side-panel .tree-item')].filter((element) => element.offsetParent !== null)
      const target = items[position % 2]
      const title = target.querySelector('.truncate')?.textContent?.slice(0, 20) ?? ''
      return window.__perf.clickUntil(target, `() => [...document.querySelectorAll('.chat-messages .msg.user')].some((message) => message.textContent.includes(${JSON.stringify(title)}))`)
    }, index))
  }
  record('open_loaded_chat_ms', switchMs)

  // open small files (first open includes loading the editor), switch tabs
  await page.locator(await viewSelector(page, ['Explorer'])).click()
  await page.locator('.tree-item[title="src"]:visible').first().click()
  await page.locator('.tree-item[title="src/components"]:visible').first().click()
  const { firstOpen, opens } = await withFrames(app, page, 'open_file', async () => {
    const firstOpen = await openFileMs(page, 'src/App.tsx', 'Badge label')
    const opens = []
    for (const [file, marker] of [['src/components/Badge.tsx', 'export'], ['src/components/Badge.test.tsx', 'renderToStaticMarkup'], ['package.json', 'scripts']]) opens.push(await openFileMs(page, file, marker))
    return { firstOpen, opens }
  })
  record('open_file_first_ms', [firstOpen])
  record('open_small_file_ms', opens)
  const tabSwitch = await withFrames(app, page, 'tab_switch', async () => {
    const times = []
    const markers = { 'App.tsx': 'Badge label', 'Badge.tsx': 'export', 'Badge.test.tsx': 'renderToStaticMarkup', 'package.json': 'scripts' }
    for (let index = 0; index < rounds * 2; index += 1) {
      times.push(await page.evaluate(async ([position, markerMap]) => {
        const tabs = [...document.querySelectorAll('.tabs .tab')]
        const target = tabs[position % tabs.length]
        const name = target.textContent.trim()
        const marker = markerMap[name] ?? ''
        return window.__perf.clickUntil(target, `() => document.querySelector('.tabs .tab.active')?.textContent.trim() === ${JSON.stringify(name)} && [...document.querySelectorAll('.editor-host .view-lines')].some((lines) => lines.offsetParent !== null && lines.textContent.replace(/\\u00a0/g, ' ').includes(${JSON.stringify(marker)}))`)
      }, [index, markers]))
    }
    return times
  })
  record('tab_switch_ms', tabSwitch)

  // background job start: click "Ausführung starten" → status visible (no local model: the run
  // ends quickly as blocked/failed, which is also a status the UI must show immediately)
  await page.locator(await viewSelector(page, ['Sitzungen', 'Aufgaben'])).click()
  const startButton = page.locator('button:has-text("Ausführung starten")')
  if (await startButton.count()) {
    const startMs = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((element) => element.textContent?.includes('Ausführung starten'))
      return window.__perf.clickUntil(button, `() => [...document.querySelectorAll('.chat-panel .msg.system, .chat-panel .callout, [data-testid="run-running"]')].some((element) => /Ausführung (läuft|pausiert)|fehlgeschlagen|No task|blockiert|Freigabe/.test(element.textContent))`, 30_000)
    })
    record('job_start_status_ms', [startMs])
  }
  const shownExecution = await waitUntil(async () => {
    const id = await page.evaluate(async () => {
      const response = await window.mac.api('GET', '/activity')
      return response.status
    })
    void id
    const projectTasks = (await api('GET', `/tasks?projectId=${opened.id}`)).data
    const run = projectTasks.map((task) => task.executions?.[0]).find((execution) => execution && !['pending', 'running', 'integrating'].includes(execution.status))
    return run?.id
  }, 60_000, 'run finished', 250).catch(() => undefined)

  // input latency: chat textarea (React-controlled input) – keydown to painted frame
  await page.locator('#chat-input').click()
  const typing = await page.evaluate(async () => {
    const input = document.querySelector('#chat-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    const times = []
    for (let index = 0; index < 40; index += 1) {
      const started = performance.now()
      setter.call(input, `${input.value}x`)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      // React re-renders synchronously for discrete input; one macrotask covers effects scheduled by it
      await new Promise((resolve) => setTimeout(resolve, 0))
      times.push(performance.now() - started)
    }
    return times
  })
  record('chat_input_frame_ms', typing)

  // event storm: 2,000 run events for the displayed execution-less session (delivered like the runtime does)
  const longTasksBefore = await page.evaluate(() => window.__perf.longTasks.length)
  await page.locator('nav.activity-bar button[title="Agenten"]').click()
  const rendererCpu = () => app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const pid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
    const metric = electronApp.getAppMetrics().find((entry) => entry.pid === pid)
    return metric?.cpu?.cumulativeCPUUsage ?? null
  })
  const cpuBefore = await rendererCpu()
  const stormMs = await app.evaluate(async ({ BrowserWindow }, executionId) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const started = Date.now()
    const events = Array.from({ length: 2000 }, (_, index) => ({ channel: 'run', type: 'tool_call', data: { executionId, level: 'debug', message: `line ${index}` }, ts: new Date().toISOString() }))
    for (let index = 0; index < events.length; index += 50) {
      const batch = events.slice(index, index + 50)
      contents.send('runtime:events', batch)
      for (const event of batch) contents.send('runtime:event', event)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return Date.now() - started
  }, shownExecution ?? 'none')
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)))
  const cpuAfter = await rendererCpu()
  const stormLongTasks = await page.evaluate((from) => window.__perf.longTasks.slice(from), longTasksBefore)
  results.metrics.event_storm = { events: 2000, executionShown: Boolean(shownExecution), rendererCpuMs: cpuBefore !== null && cpuAfter !== null ? Math.round((cpuAfter - cpuBefore) * 1000) : null, sendMs: stormMs, longTasks: stormLongTasks.length, longTaskTotalMs: Math.round(stormLongTasks.reduce((sum, value) => sum + value, 0)) }
  console.log(`[perf:${label}] event_storm`, JSON.stringify(results.metrics.event_storm))

  const paintSamples = await page.evaluate(() => window.__perf.paintSamples)
  record('click_to_paint_ms', paintSamples, { valid: results.paintValid, note: 'all click measurements incl. two painted frames; only meaningful when frames are not throttled' })

  // memory
  const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((entry) => ({ type: entry.type, name: entry.name, workingSetMb: Math.round(entry.memory.workingSetSize / 1024) })))
  const heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) : null))
  results.metrics.memory = { processes: metrics, rendererHeapMb: heap }

  // restore after reload
  const reloads = []
  const restoredTabs = []
  let tabsRestoredCount = 0
  for (let index = 0; index < rounds; index += 1) {
    const started = Date.now()
    await page.reload()
    await page.waitForFunction(() => document.querySelector('.ide') && !document.querySelector('.splash'), null, { timeout: 60_000 })
    reloads.push(Date.now() - started)
    const tabs = await page.waitForFunction(() => document.querySelectorAll('.tabs .tab').length > 0, null, { timeout: 3000 }).then(() => true).catch(() => false)
    if (tabs) {
      tabsRestoredCount += 1
      restoredTabs.push(Date.now() - started)
    }
  }
  record('reload_to_ide_ms', reloads, { note: 'reload → IDE visible' })
  record('reload_to_restored_tabs_ms', restoredTabs, { note: 'reload → previously open editor tabs visible again', restoredInRounds: tabsRestoredCount, rounds })
  await stop(app)

  // --- launches (warm start): process start → first paint / IDE with restored workspace ---
  const fcp = []
  const ide = []
  const runtimeReady = []
  const modelsAfterRestart = []
  const workspaceRestored = []
  for (let index = 0; index < launches; index += 1) {
    session = await start(profile)
    ;({ app, page } = session)
    await page.waitForSelector('.ide', { timeout: 120_000 })
    const timing = await page.evaluate(() => ({ origin: performance.timeOrigin, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, now: performance.now() }))
    ide.push(timing.origin + timing.now - session.launchedAt)
    // project, tabs and session list back (marks exist only in versions that restore the workspace)
    const restored = await page.waitForFunction(() => performance.getEntriesByName('mac:workspace-restored')[0]?.startTime, null, { timeout: 15_000 }).then((handle) => handle.jsonValue()).catch(() => null)
    if (restored) workspaceRestored.push(timing.origin + restored - session.launchedAt)
    if (timing.fcp !== null) fcp.push(timing.origin + timing.fcp - session.launchedAt)
    const log = readFileSync(path.join(profile, 'logs', 'runtime.log'), 'utf8').split(/\r?\n/)
    const startLine = [...log].reverse().find((line) => line.includes('starting runtime'))
    const readyLine = [...log].reverse().find((line) => line.includes('runtime ready'))
    if (startLine && readyLine) runtimeReady.push(new Date(readyLine.slice(1, 25)).getTime() - new Date(startLine.slice(1, 25)).getTime())
    await instrument(page)
    await page.locator('nav.activity-bar button[title="Explorer"]').click()
    modelsAfterRestart.push(await page.evaluate(async (selector) => {
      const before = window.__perf.visibleHeader()
      return window.__perf.clickUntil(selector, `() => { const header = window.__perf.visibleHeader(); return header && header !== ${JSON.stringify(before)} && ![...document.querySelectorAll('.side-panel .spinner')].some((spinner) => spinner.offsetParent !== null) && document.querySelector('.side-panel table.table tbody tr') }`, 30_000)
    }, 'nav.activity-bar button[title="Modelle"]'))
    await stop(app)
  }
  record('startup_first_paint_ms', fcp, { note: 'process launch → first contentful paint' })
  record('startup_ide_ms', ide, { note: 'process launch → IDE visible' })
  record('startup_workspace_restored_ms', workspaceRestored, { note: 'process launch → project, tabs and sessions restored from the runtime' })
  record('models_view_after_restart_ms', modelsAfterRestart, { note: 'first visit of the Models view after an app restart (recommendations table visible)' })
  record('runtime_start_ms', runtimeReady, { note: 'utility process fork → NestJS listening (migrations, recovery included)' })

  results.finishedAt = new Date().toISOString()
  const file = path.join(resultsDir, `perf-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify(results, null, 2))
  console.log(`[perf:${label}] written ${file}`)
}

await main()
