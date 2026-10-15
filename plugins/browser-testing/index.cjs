// Browser Testing: drives a local Chromium-based browser through the DevTools protocol over a pipe
// (--remote-debugging-pipe: no TCP debugging port is opened). Needs the "native" permission to start
// the browser process.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function candidates(configured) {
  if (configured) return [configured]
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES || 'C:\\Program Files', process.env['PROGRAMFILES(X86)'] || process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.LOCALAPPDATA || '']
    return roots.filter(Boolean).flatMap((root) => [path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(root, 'Chromium', 'Application', 'chrome.exe')])
  }
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
}

class Browser {
  static async launch(configured, profile) {
    // the permission model does not allow probing the file system, so candidates are simply tried
    const args = ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', 'about:blank']
    let lastError
    for (const executable of candidates(configured)) {
      try {
        const child = await new Promise((resolve, reject) => {
          const started = spawn(executable, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true })
          started.once('error', reject)
          started.once('spawn', () => resolve(started))
        })
        const browser = new Browser(child, executable)
        await browser.send('Browser.getVersion')
        return browser
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(`Kein Chrome/Chromium/Edge gefunden${configured ? ` unter ${configured}` : ''} (${lastError ? lastError.message : 'unbekannt'}). Pfad in den Plugin-Einstellungen eintragen.`)
  }

  constructor(child, executable) {
    this.child = child
    this.executable = executable
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.buffer = ''
    child.stdio[4].on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      let index
      while ((index = this.buffer.indexOf('\0')) >= 0) {
        const raw = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        const message = JSON.parse(raw)
        if (message.id && this.pending.has(message.id)) {
          const waiter = this.pending.get(message.id)
          this.pending.delete(message.id)
          if (message.error) waiter.reject(new Error(message.error.message))
          else waiter.resolve(message.result)
        } else for (const listener of this.listeners) listener(message)
      }
    })
    child.once('exit', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('Browser beendet.'))
      this.pending.clear()
    })
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: keine Antwort nach ${timeoutMs / 1000} s.`))
      }, timeoutMs)
      this.pending.set(id, { resolve: (value) => (clearTimeout(timer), resolve(value)), reject: (error) => (clearTimeout(timer), reject(error)) })
      this.child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
    })
  }

  waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener)
        reject(new Error(`${label}: Timeout nach ${timeoutMs / 1000} s.`))
      }, timeoutMs)
      const listener = (message) => {
        if (!predicate(message)) return
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(message)
      }
      this.listeners.add(listener)
    })
  }

  async close() {
    const exited = new Promise((resolve) => (this.child.exitCode !== null ? resolve() : this.child.once('exit', resolve)))
    await this.send('Browser.close', {}, undefined, 5000).catch(() => undefined)
    const timer = setTimeout(() => this.child.kill(), 3000)
    await exited
    clearTimeout(timer)
  }
}

/** One page with collected console messages, exceptions and failed requests. */
async function openPage(browser, { width, height }) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const page = { sessionId, console: [], exceptions: [], failedRequests: [], mainStatus: undefined, requests: new Map() }
  browser.listeners.add((message) => {
    if (message.sessionId !== sessionId) return
    const params = message.params || {}
    if (message.method === 'Runtime.consoleAPICalled') page.console.push({ level: params.type, text: (params.args || []).map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type)).join(' ') })
    else if (message.method === 'Log.entryAdded') page.console.push({ level: params.entry.level, text: `${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ''}` })
    else if (message.method === 'Runtime.exceptionThrown') page.exceptions.push((params.exceptionDetails.exception && params.exceptionDetails.exception.description) || params.exceptionDetails.text)
    else if (message.method === 'Network.requestWillBeSent') page.requests.set(params.requestId, params.request.url)
    else if (message.method === 'Network.responseReceived') {
      if (params.type === 'Document' && page.mainStatus === undefined) page.mainStatus = params.response.status
      if (params.response.status >= 400) page.failedRequests.push({ url: params.response.url, status: String(params.response.status) })
    } else if (message.method === 'Network.loadingFailed' && !params.canceled) page.failedRequests.push({ url: page.requests.get(params.requestId) || params.requestId, status: params.errorText })
  })
  await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'].map((method) => browser.send(method, {}, sessionId)))
  await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId)
  return page
}

async function navigate(browser, page, url) {
  if (!/^(https?:|file:)/i.test(url)) throw new Error(`Ungültige URL: ${url}`)
  page.mainStatus = undefined
  const loaded = browser.waitFor((message) => message.sessionId === page.sessionId && message.method === 'Page.loadEventFired', 30000, 'Laden')
  const started = Date.now()
  const result = await browser.send('Page.navigate', { url }, page.sessionId)
  if (result.errorText) throw new Error(`${url}: ${result.errorText}`)
  await loaded
  return Date.now() - started
}

async function evaluate(browser, page, expression) {
  const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page.sessionId)
  if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text)
  return result.result.value
}

async function screenshot(browser, page) {
  const { data } = await browser.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 }, page.sessionId)
  return `data:image/jpeg;base64,${data}`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Steps, one per line: goto URL | click SELECTOR | type SELECTOR TEXT | press KEY | wait MS | waitFor SELECTOR | expectText TEXT | screenshot | eval JS */
function parseSteps(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [command, ...rest] = line.split(/\s+/)
      return { command: command.toLowerCase(), rest: line.slice(command.length).trim(), parts: rest, line }
    })
}

async function runSteps(browser, page, steps) {
  const results = []
  for (const step of steps) {
    const started = Date.now()
    try {
      let detail = ''
      if (step.command === 'goto') detail = `${await navigate(browser, page, step.rest)} ms, HTTP ${page.mainStatus ?? '?'}`
      else if (step.command === 'click') {
        const found = await evaluate(browser, page, `(() => { const el = document.querySelector(${JSON.stringify(step.rest)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true })()`)
        if (!found) throw new Error(`Element nicht gefunden: ${step.rest}`)
      } else if (step.command === 'type') {
        const selector = step.parts[0]
        const text = step.rest.slice(selector.length).trim()
        const found = await evaluate(browser, page, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true })()`)
        if (!found) throw new Error(`Element nicht gefunden: ${selector}`)
        await browser.send('Input.insertText', { text }, page.sessionId)
      } else if (step.command === 'press') {
        const key = step.rest || 'Enter'
        const code = key === 'Enter' ? 13 : key === 'Tab' ? 9 : key === 'Escape' ? 27 : 0
        for (const type of ['keyDown', 'keyUp']) await browser.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code, ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}) }, page.sessionId)
      } else if (step.command === 'wait') await sleep(Math.min(Number(step.rest) || 500, 30000))
      else if (step.command === 'waitfor') {
        const deadline = Date.now() + 10000
        while (!(await evaluate(browser, page, `Boolean(document.querySelector(${JSON.stringify(step.rest)}))`))) {
          if (Date.now() > deadline) throw new Error(`Element erscheint nicht: ${step.rest}`)
          await sleep(200)
        }
      } else if (step.command === 'expecttext') {
        const expected = step.rest.replace(/^"(.*)"$/, '$1')
        if (!(await evaluate(browser, page, `document.body.innerText.includes(${JSON.stringify(expected)})`))) throw new Error(`Text nicht gefunden: ${expected}`)
      } else if (step.command === 'screenshot') {
        results.push({ step: step.line, ok: true, ms: Date.now() - started, image: await screenshot(browser, page) })
        continue
      } else if (step.command === 'eval') detail = JSON.stringify(await evaluate(browser, page, step.rest))?.slice(0, 500) ?? 'undefined'
      else throw new Error(`Unbekannter Schritt "${step.command}".`)
      results.push({ step: step.line, ok: true, ms: Date.now() - started, detail })
    } catch (error) {
      results.push({ step: step.line, ok: false, ms: Date.now() - started, detail: error.message, image: await screenshot(browser, page).catch(() => undefined) })
      break // the following steps depend on this one
    }
  }
  return results
}

let queue = Promise.resolve()
/** One browser session at a time per plugin process; each launch gets a fresh profile in the plugin's data folder. */
function withBrowser(context, work) {
  const run = queue.then(async () => {
    const width = Math.min(Math.max(Number(await context.settings.get('width')) || 1280, 320), 3840)
    const height = Math.min(Math.max(Number(await context.settings.get('height')) || 800, 240), 2160)
    const profile = path.join(context.dataDir, 'profiles', `${process.pid}-${Date.now()}`)
    const browser = await Browser.launch(String((await context.settings.get('browserPath')) || '').trim() || undefined, profile)
    try {
      const page = await openPage(browser, { width, height })
      return await work(browser, page)
    } finally {
      await browser.close()
      // the profile is only for this run (Chrome may hold files briefly after exit)
      fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
    }
  })
  queue = run.catch(() => undefined)
  return run
}

function diagnosticsView(page) {
  const children = []
  const errors = page.console.filter((entry) => ['error', 'assert'].includes(entry.level))
  children.push({ type: 'kv', items: [{ label: 'HTTP-Status', value: String(page.mainStatus ?? '–') }, { label: 'Konsole', value: `${page.console.length} Meldung(en), ${errors.length} Fehler` }, { label: 'Exceptions', value: String(page.exceptions.length) }, { label: 'Fehlgeschlagene Requests', value: String(page.failedRequests.length) }] })
  if (page.exceptions.length) children.push({ type: 'code', content: page.exceptions.join('\n\n') })
  if (page.console.length) children.push({ type: 'table', columns: ['Level', 'Meldung'], rows: page.console.slice(0, 200).map((entry) => ({ cells: [entry.level, entry.text.slice(0, 500)] })) })
  if (page.failedRequests.length) children.push({ type: 'table', columns: ['URL', 'Status'], rows: page.failedRequests.slice(0, 100).map((entry) => ({ cells: [entry.url.slice(0, 200), entry.status] })) })
  return children
}

function summary(url, title, loadMs, page) {
  const lines = [`Browser-Prüfung ${url}`, `Titel: ${title}`, `HTTP-Status: ${page.mainStatus ?? 'unbekannt'}, geladen in ${loadMs} ms`]
  const problems = page.console.filter((entry) => ['error', 'warning', 'assert'].includes(entry.level))
  if (problems.length) lines.push('', 'Konsole:', ...problems.slice(0, 50).map((entry) => `- [${entry.level}] ${entry.text.slice(0, 400)}`))
  if (page.exceptions.length) lines.push('', 'Exceptions:', ...page.exceptions.slice(0, 20).map((text) => `- ${text.slice(0, 800)}`))
  if (page.failedRequests.length) lines.push('', 'Fehlgeschlagene Requests:', ...page.failedRequests.slice(0, 30).map((entry) => `- ${entry.status} ${entry.url}`))
  if (!problems.length && !page.exceptions.length && !page.failedRequests.length) lines.push('Keine Fehler, Warnungen oder fehlgeschlagenen Requests.')
  return lines.join('\n')
}

async function check(context, url) {
  return withBrowser(context, async (browser, page) => {
    const loadMs = await navigate(browser, page, url)
    await sleep(300) // late console output after load
    const title = await evaluate(browser, page, 'document.title')
    return { title, loadMs, page, image: await screenshot(browser, page), browser: browser.executable }
  })
}

module.exports = {
  parseSteps,
  activate(context) {
    context.views.register('main', async (input) => ({
      type: 'stack',
      children: [
        { type: 'heading', text: 'Seite prüfen' },
        { type: 'form', fields: [{ name: 'url', label: 'URL', type: 'text', value: input.url || 'http://localhost:5173', placeholder: 'http://localhost:3000' }], submit: { label: 'Prüfen', command: 'check' } },
        { type: 'heading', text: 'Automatisierung' },
        { type: 'text', tone: 'muted', text: 'Ein Schritt pro Zeile: goto URL · click SELEKTOR · type SELEKTOR TEXT · press Enter · wait MS · waitFor SELEKTOR · expectText TEXT · screenshot · eval JS' },
        { type: 'form', fields: [{ name: 'steps', label: 'Schritte', type: 'textarea', value: input.steps || 'goto http://localhost:5173\nwaitFor body\nscreenshot' }], submit: { label: 'Ausführen', command: 'run' } },
      ],
    }))

    context.commands.register('check', async (args) => {
      const url = String(args.url || '').trim()
      const result = await check(context, url)
      return {
        title: result.title || url,
        view: {
          type: 'stack',
          children: [
            { type: 'heading', text: result.title || url },
            { type: 'text', tone: 'muted', text: `${url} · ${result.loadMs} ms · ${path.basename(result.browser)}` },
            { type: 'image', dataUrl: result.image, alt: `Screenshot ${url}` },
            ...diagnosticsView(result.page),
            { type: 'actions', items: [{ label: 'Ergebnis in den Chat', command: 'toChat', args: { url }, resultTarget: 'chat' }] },
          ],
        },
      }
    })

    context.commands.register('run', async (args) => {
      const steps = parseSteps(args.steps)
      if (!steps.length) throw new Error('Keine Schritte.')
      const { results, page } = await withBrowser(context, async (browser, page) => ({ results: await runSteps(browser, page, steps), page }))
      const failed = results.find((result) => !result.ok)
      const children = [{ type: 'badge', text: failed ? `Fehlgeschlagen: ${failed.step}` : `${results.length} Schritt(e) erfolgreich`, tone: failed ? 'error' : 'ok' }]
      children.push({ type: 'table', columns: ['Schritt', 'Ergebnis', 'Dauer'], rows: results.map((result) => ({ cells: [result.step, result.ok ? result.detail || 'ok' : `Fehler: ${result.detail}`, `${result.ms} ms`] })) })
      for (const result of results) if (result.image) children.push({ type: 'image', dataUrl: result.image, alt: result.step })
      children.push(...diagnosticsView(page))
      return { title: 'Automatisierung', view: { type: 'stack', children } }
    })

    context.commands.register('toChat', async (args) => {
      const url = String(args.url || '').trim()
      const result = await check(context, url)
      return { text: summary(url, result.title, result.loadMs, result.page), message: 'Prüfergebnis in den Chat übernommen.' }
    })

    context.tools.register('browser_check', async (args) => {
      const url = String(args.url || '').trim()
      const result = await check(context, url)
      return summary(url, result.title, result.loadMs, result.page)
    })
  },
}
