import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, screen, session, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resourcePaths } from './paths.js'
import { RuntimeManager } from './runtime.js'
import { SecretVault } from './secret-vault.js'
import { isValidProjectKey, isValidStateKey, StateStore } from './state-store.js'
import { normalizeForCompare, TerminalManager, type PersistedTerminal } from './terminal.js'
import {
  isAllowedCommand,
  isAllowedCwd,
  IpcValidationError,
  validateApiRequest,
  validateExternalUrl,
  validateTerminalCreate,
  validateTerminalData,
  validateTerminalId,
  validateTerminalTitle,
} from './validation.js'

const DEV_RENDERER_URL = process.env.MAC_DEV_RENDERER_URL
const isDev = !app.isPackaged && Boolean(DEV_RENDERER_URL)

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }])

app.setName('Multi-AI Coder')
// Isolated profile for automated tests (never set in normal use). Must be set before the
// single-instance lock, which is scoped to the user-data directory.
if (process.env.MAC_USER_DATA_DIR) app.setPath('userData', process.env.MAC_USER_DATA_DIR)

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const dataDir = app.getPath('userData')
const runtime = new RuntimeManager(dataDir)
const state = new StateStore(path.join(dataDir, 'state'))
const vault = new SecretVault(dataDir)
// The runtime reads a secret only through this channel, after checking the plugin's/server's grant.
runtime.onShellRequest((method, params) => {
  if (method === 'secret:get') return vault.get(String(params.scope), String(params.name))
  // used when importing MCP configurations: credential values go straight into the vault
  if (method === 'secret:set' && /^mcp:/.test(String(params.scope))) {
    vault.set(String(params.scope), String(params.name), String(params.value))
    return true
  }
  if (method === 'secret:delete' && /^mcp:/.test(String(params.scope))) {
    vault.delete(String(params.scope), String(params.name))
    return true
  }
  throw new Error(`Unknown shell request ${method}.`)
})
let mainWindow: BrowserWindow | undefined

// --- batched delivery to the renderer ------------------------------------------
// Agents can emit hundreds of log events per second and terminals stream large outputs. Sending each
// as its own IPC message costs a renderer task per message; batching keeps the UI responsive.

const runtimeBatch: unknown[] = []
let runtimeTimer: NodeJS.Timeout | undefined
function flushRuntimeEvents() {
  if (runtimeTimer) clearTimeout(runtimeTimer)
  runtimeTimer = undefined
  if (!runtimeBatch.length) return
  const batch = runtimeBatch.splice(0)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:events', batch)
}
function queueRuntimeEvent(event: unknown) {
  runtimeBatch.push(event)
  if (runtimeBatch.length >= 250) flushRuntimeEvents()
  else if (!runtimeTimer) runtimeTimer = setTimeout(flushRuntimeEvents, 16)
}

const terminalOutput = new Map<string, string[]>()
let terminalTimer: NodeJS.Timeout | undefined
function flushTerminalOutput() {
  if (terminalTimer) clearTimeout(terminalTimer)
  terminalTimer = undefined
  if (!terminalOutput.size) return
  const batch = [...terminalOutput.entries()].map(([id, chunks]) => ({ id, data: chunks.join('') }))
  terminalOutput.clear()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:data', batch)
}

const terminals = new TerminalManager(
  (id, data) => {
    const chunks = terminalOutput.get(id)
    if (chunks) chunks.push(data)
    else terminalOutput.set(id, [data])
    if (!terminalTimer) terminalTimer = setTimeout(flushTerminalOutput, 8)
  },
  (id, exitCode) => {
    flushTerminalOutput()
    mainWindow?.webContents.send('terminal:exit', { id, exitCode })
  },
  () => mainWindow?.webContents.send('terminal:changed'),
)
terminals.restore((state.get<PersistedTerminal[]>('terminals')?.data ?? []).filter((item) => typeof item?.scrollback === 'string'))

const CSP = [
  "default-src 'self'",
  `script-src 'self'${isDev ? " 'unsafe-inline'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  `connect-src 'self'${isDev ? ` ${DEV_RENDERER_URL} ws://localhost:* ws://127.0.0.1:*` : ''}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ')

function isTrustedSender(event: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  // Top-level URL of the sending window: the frame object can be briefly unavailable during reloads.
  if (event.sender !== mainWindow?.webContents) return false
  const url = event.sender.getURL()
  return url.startsWith('app://renderer/') || (isDev && url.startsWith(DEV_RENDERER_URL!))
}

function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender.')
    try {
      return await listener(event, ...args)
    } catch (error) {
      if (error instanceof IpcValidationError) throw new Error(`Invalid request: ${error.message}`)
      throw error
    }
  })
}

/** Commands the terminal may start directly: the official login/install commands the runtime reports. */
async function allowedCommands(): Promise<string[][]> {
  const allowed: string[][] = []
  try {
    const overview = (await runtime.request('GET', '/orchestrator')).data as {
      orchestrators?: Array<{ id: string; detection?: { binary?: string; installHint?: { commands?: Array<{ command: string[] }> } } }>
    }
    for (const orchestrator of overview.orchestrators ?? []) {
      const binary = orchestrator.detection?.binary
      if (binary) allowed.push(orchestrator.id === 'claude-code' ? [binary, 'auth', 'login'] : [binary, 'login'])
      for (const hint of orchestrator.detection?.installHint?.commands ?? []) allowed.push(hint.command)
    }
    const ollama = (await runtime.request('GET', '/local-models/ollama')).data as { installPlan?: { command?: string[] } }
    if (ollama.installPlan?.command) allowed.push(ollama.installPlan.command)
  } catch {
    // runtime unavailable: no direct commands
  }
  return allowed
}

async function allowedRoots(): Promise<string[]> {
  const roots = [os.homedir()]
  try {
    const projects = (await runtime.request('GET', '/projects')).data as Array<{ repoPath: string }>
    roots.push(...projects.map((project) => project.repoPath))
  } catch {
    // ignore
  }
  return roots
}

function registerIpc() {
  // --- persistent UI state (see state-store.ts) ---
  handle('state:hello', (_event, epoch) => {
    if (typeof epoch !== 'string' || epoch.length > 64) throw new IpcValidationError('Invalid epoch.')
    state.registerEpoch(epoch)
    return true
  })
  handle('state:get', (_event, key) => {
    if (!isValidStateKey(key)) throw new IpcValidationError('Invalid state key.')
    return state.get(key) ?? null
  })
  handle('state:set', (_event, key, data, epoch) => {
    if (!isValidStateKey(key)) throw new IpcValidationError('Invalid state key.')
    return state.set(key, data, typeof epoch === 'string' ? epoch : undefined)
  })
  handle('draft:put', (_event, projectKey, entry, epoch) => state.putDraft(String(projectKey), entry as never, typeof epoch === 'string' ? epoch : undefined))
  handle('draft:delete', (_event, projectKey, filePath, epoch) => state.deleteDraft(String(projectKey), String(filePath), typeof epoch === 'string' ? epoch : undefined))
  handle('draft:list', (_event, projectKey) => {
    if (!isValidProjectKey(projectKey)) throw new IpcValidationError('Invalid project.')
    return state.listDrafts(projectKey)
  })
  // Synchronous variant: used while the page unloads (reload/close), where async IPC may not finish.
  ipcMain.on('state:flush-sync', (event, payload: { writes?: Array<{ key: string; data: unknown }>; drafts?: Array<{ projectKey: string; entry: { path: string; content: string; baseMtimeMs?: number } | null; path?: string }>; epoch?: string }) => {
    if (!isTrustedSender(event)) {
      event.returnValue = false
      return
    }
    for (const write of payload?.writes ?? []) if (isValidStateKey(write.key)) state.set(write.key, write.data, payload.epoch)
    for (const draft of payload?.drafts ?? []) {
      if (draft.entry) state.putDraft(draft.projectKey, draft.entry, payload.epoch)
      else if (draft.path) state.deleteDraft(draft.projectKey, draft.path, payload.epoch)
    }
    try {
      state.flushSync()
    } catch {
      // reported on the next flush
    }
    event.returnValue = true
  })

  handle('api:request', async (_event, input) => {
    const request = validateApiRequest(input)
    return runtime.request(request.method, request.path, request.body)
  })

  handle('runtime:status', () => ({ ...runtime.current, log: runtime.logTail().slice(-80) }))
  handle('runtime:restart', () => {
    runtime.restart()
    return runtime.current
  })

  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dataDir,
    packaged: app.isPackaged,
  }))

  handle('app:metrics', () =>
    app.getAppMetrics().map((entry) => ({ pid: entry.pid, type: entry.type, name: entry.name ?? entry.serviceName, cpuPercent: Math.round(entry.cpu.percentCPUUsage * 10) / 10, workingSetMb: Math.round(entry.memory.workingSetSize / 1024) })),
  )

  handle('dialog:openFolder', async (_event, title) => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: typeof title === 'string' ? title.slice(0, 100) : 'Ordner öffnen', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  handle('dialog:saveText', async (_event, defaultName, content) => {
    if (typeof defaultName !== 'string' || typeof content !== 'string' || content.length > 50 * 1024 * 1024) throw new IpcValidationError('Invalid export.')
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: path.basename(defaultName).replace(/[^\w.-]+/g, '_').slice(0, 120) })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, content, 'utf8')
    return result.filePath
  })

  // secrets: the renderer can set, delete and list names, but never read values back
  handle('secrets:set', (_event, scope, name, value) => {
    vault.set(String(scope), String(name), String(value))
    return true
  })
  handle('secrets:delete', (_event, scope, name) => {
    vault.delete(String(scope), String(name))
    return true
  })
  handle('secrets:names', (_event, scope) => ({ available: vault.available, names: vault.names(String(scope)) }))
  handle('shell:openExternal', async (_event, url) => {
    await shell.openExternal(validateExternalUrl(url))
    return true
  })

  handle('shell:showItem', async (_event, target) => {
    if (typeof target !== 'string') throw new IpcValidationError('Invalid path.')
    if (!isAllowedCwd(target, [...(await allowedRoots()), dataDir], normalizeForCompare)) throw new IpcValidationError('Path is outside the opened projects.')
    shell.showItemInFolder(target)
    return true
  })

  handle('terminal:create', async (_event, input) => {
    const request = validateTerminalCreate(input)
    if (request.cwd && !isAllowedCwd(request.cwd, await allowedRoots(), normalizeForCompare)) throw new IpcValidationError('Terminal working directory must be inside an opened project or your home folder.')
    if (request.command && !isAllowedCommand(request.command, await allowedCommands())) throw new IpcValidationError('This command cannot be started directly. Use an interactive terminal instead.')
    return terminals.create(request)
  })
  handle('terminal:list', (_event, projectId) => terminals.list(typeof projectId === 'string' ? projectId : undefined))
  handle('terminal:attach', (_event, id) => terminals.attach(validateTerminalId(id)) ?? null)
  handle('terminal:history', (_event, id) => terminals.history(validateTerminalId(id)))
  handle('terminal:rename', (_event, id, title) => {
    terminals.rename(validateTerminalId(id), validateTerminalTitle(title))
    return true
  })
  ipcMain.on('terminal:write', (event, payload: { id?: unknown; data?: unknown }) => {
    if (!isTrustedSender(event)) return
    try {
      terminals.write(validateTerminalId(payload?.id), validateTerminalData(payload?.data))
    } catch {
      // ignore invalid input
    }
  })
  handle('terminal:resize', (_event, input) => {
    const payload = input as { id?: unknown; cols?: unknown; rows?: unknown }
    const size = validateTerminalCreate({ cols: payload?.cols, rows: payload?.rows })
    terminals.resize(validateTerminalId(payload?.id), size.cols, size.rows)
    return true
  })
  handle('terminal:kill', (_event, id) => {
    terminals.kill(validateTerminalId(id))
    return true
  })
}

function serveRenderer() {
  const root = resourcePaths().rendererDir
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'renderer') return new Response('Not found', { status: 404 })
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const target = path.resolve(root, relative)
    if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) return new Response('Forbidden', { status: 403 })
    const file = existsSync(target) ? target : path.join(root, 'index.html')
    const response = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(response.headers)
    headers.set('Content-Security-Policy', CSP)
    headers.set('X-Content-Type-Options', 'nosniff')
    return new Response(response.body, { status: response.status, headers })
  })
}

function hardenSession() {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } })
  })
}

interface WindowLayout {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

/** Last window bounds, if they are still (mostly) visible on a connected display. */
function restoredBounds(): WindowLayout | undefined {
  const saved = state.get<WindowLayout>('window')?.data
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') return undefined
  const width = Math.max(1024, Math.min(saved.width, 10_000))
  const height = Math.max(640, Math.min(saved.height, 10_000))
  if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return { width, height, maximized: Boolean(saved.maximized) }
  const area = screen.getDisplayMatching({ x: saved.x, y: saved.y, width, height }).workArea
  const visible = saved.x + 80 < area.x + area.width && saved.x + width - 80 > area.x && saved.y >= area.y - 20 && saved.y + 40 < area.y + area.height
  return visible ? { x: saved.x, y: saved.y, width, height, maximized: Boolean(saved.maximized) } : { width, height, maximized: Boolean(saved.maximized) }
}

function trackWindowLayout(window: BrowserWindow) {
  let timer: NodeJS.Timeout | undefined
  const save = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
    const bounds = window.getNormalBounds()
    state.set('window', { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized: window.isMaximized() })
  }
  const later = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 400)
  }
  window.on('resize', later)
  window.on('move', later)
  window.on('maximize', save)
  window.on('unmaximize', save)
  window.on('close', save)
}

async function createWindow() {
  const paths = resourcePaths()
  const layout = restoredBounds()
  mainWindow = new BrowserWindow({
    width: layout?.width ?? 1480,
    height: layout?.height ?? 920,
    ...(layout?.x !== undefined && layout.y !== undefined ? { x: layout.x, y: layout.y } : {}),
    minWidth: 1024,
    minHeight: 640,
    title: 'Multi-AI Coder',
    backgroundColor: '#0d1117',
    show: false,
    icon: existsSync(paths.icon) ? paths.icon : undefined,
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      webviewTag: false,
    },
  })
  mainWindow.once('ready-to-show', () => {
    if (layout?.maximized) mainWindow?.maximize()
    mainWindow?.show()
  })
  trackWindowLayout(mainWindow)
  // A crashed renderer is reloaded; the UI state comes back from the state store and the runtime.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
    }, 500)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(validateExternalUrl(url))
    } catch {
      // non-https targets are dropped
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!(url.startsWith('app://renderer/') || (isDev && url.startsWith(DEV_RENDERER_URL!)))) event.preventDefault()
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
  await mainWindow.loadURL(isDev ? DEV_RENDERER_URL! : 'app://renderer/index.html')
  if (isDev && process.env.MAC_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' })
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'Datei', submenu: [{ role: 'quit', label: 'Beenden' }] },
    { label: 'Bearbeiten', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'Ansicht',
      submenu: [{ role: 'reload' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  hardenSession()
  serveRenderer()
  registerIpc()
  buildMenu()
  runtime.onStatus((status) => mainWindow?.webContents.send('runtime:status', status))
  runtime.onEvent((event) => queueRuntimeEvent(event))
  runtime.start()
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!(url.startsWith('app://renderer/') || (isDev && url.startsWith(DEV_RENDERER_URL!)))) event.preventDefault()
  })
})

/** Asks the renderer to write its pending (debounced) state, waiting at most timeoutMs. */
function requestRendererFlush(timeoutMs = 1500): Promise<void> {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined
  if (!contents) return Promise.resolve()
  return new Promise((resolve) => {
    const onFlushed = (event: Electron.IpcMainEvent) => {
      if (event.sender === contents) done()
    }
    const done = () => {
      clearTimeout(timer)
      ipcMain.removeListener('app:flushed', onFlushed)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    ipcMain.on('app:flushed', onFlushed)
    contents.send('app:flush')
  })
}

let shuttingDown = false
app.on('before-quit', (event) => {
  if (shuttingDown) return
  shuttingDown = true
  event.preventDefault()
  void (async () => {
    await requestRendererFlush()
    // Terminal output and configuration survive as history; the processes end with the app.
    state.set('terminals', terminals.snapshot())
    terminals.killAll()
    try {
      state.flushSync()
    } catch {
      // nothing more we can do while quitting
    }
    // The runtime marks active runs as interrupted so they can be resumed after the next start.
    await runtime.stop().catch(() => undefined)
    app.exit(0)
  })()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
