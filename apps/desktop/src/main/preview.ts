import { session, shell, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import type { PreviewEvent } from '../shared/bridge.js'
import { isLocalPreviewUrl, localPreviewUrl } from '../shared/local-preview.js'
import { IpcValidationError, validateLinkUrl } from './validation.js'

export interface PreviewBounds {
  x: number
  y: number
  width: number
  height: number
}


const PARTITION = 'persist:mac-preview'

export function validatePreviewId(input: unknown): string {
  if (typeof input !== 'string' || !/^preview:https?:\/\/[\w.:[\]-]{1,200}$/.test(input)) throw new IpcValidationError('Invalid preview id.')
  return input
}

export function validatePreviewBounds(input: unknown): PreviewBounds {
  const bounds = input as Partial<PreviewBounds> | null
  const numbers = [bounds?.x, bounds?.y, bounds?.width, bounds?.height]
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000)) throw new IpcValidationError('Invalid preview bounds.')
  return { x: bounds!.x!, y: bounds!.y!, width: bounds!.width!, height: bounds!.height! }
}

export function validatePreviewUrl(input: unknown): string {
  const url = typeof input === 'string' && input.length <= 2048 ? localPreviewUrl(input) : undefined
  if (!url) throw new IpcValidationError('Only local addresses (localhost, 127.0.0.1) are shown in the preview.')
  return url
}

/**
 * Local dev servers in the code screen. Each preview is a native view with its own renderer process
 * and its own session: the page never competes with the app's UI thread (Monaco, terminals, …) and
 * its requests do not pass through the app's request hooks. The renderer only reports where the
 * preview area is on screen.
 */
export class PreviewManager {
  private readonly views = new Map<string, { view: WebContentsView; url: string; attached: boolean }>()
  private configured = false

  constructor(
    private readonly window: () => BrowserWindow | undefined,
    private readonly emit: (event: PreviewEvent) => void,
  ) {}

  /** The preview's web contents (navigation guards elsewhere must leave them alone). */
  owns(contents: WebContents): boolean {
    for (const entry of this.views.values()) if (entry.view.webContents === contents) return true
    return false
  }

  show(id: string, url: string, bounds: PreviewBounds) {
    const window = this.window()
    if (!window || window.isDestroyed()) return false
    let entry = this.views.get(id)
    if (!entry) {
      entry = { view: this.create(id), url: '', attached: false }
      this.views.set(id, entry)
    }
    if (entry.url !== url) {
      entry.url = url
      void entry.view.webContents.loadURL(url).catch(() => undefined)
    }
    // the renderer reports CSS pixels; the view is placed in window (DIP) coordinates
    const zoom = window.webContents.getZoomFactor()
    entry.view.setBounds({ x: Math.round(bounds.x * zoom), y: Math.round(bounds.y * zoom), width: Math.round(bounds.width * zoom), height: Math.round(bounds.height * zoom) })
    if (!entry.attached) {
      window.contentView.addChildView(entry.view)
      entry.attached = true
    }
    return true
  }

  hide(id: string) {
    const entry = this.views.get(id)
    const window = this.window()
    if (!entry?.attached) return false
    if (window && !window.isDestroyed()) window.contentView.removeChildView(entry.view)
    entry.attached = false
    return true
  }

  /** A still image of the page, shown by the renderer while a dialog covers the preview area. */
  async capture(id: string): Promise<string | null> {
    const entry = this.views.get(id)
    if (!entry?.attached) return null
    const image = await entry.view.webContents.capturePage().catch(() => undefined)
    return image && !image.isEmpty() ? image.toDataURL() : null
  }

  reload(id: string) {
    this.views.get(id)?.view.webContents.reload()
    return true
  }

  devTools(id: string) {
    this.views.get(id)?.view.webContents.openDevTools({ mode: 'detach' })
    return true
  }

  close(id: string) {
    const entry = this.views.get(id)
    if (!entry) return false
    this.hide(id)
    this.views.delete(id)
    entry.view.webContents.close()
    return true
  }

  /** The app's page is reloaded: the renderer shows its previews again once it is back. */
  hideAll() {
    for (const id of this.views.keys()) this.hide(id)
  }

  closeAll() {
    for (const id of [...this.views.keys()]) this.close(id)
  }

  private create(id: string) {
    const previewSession = session.fromPartition(PARTITION)
    if (!this.configured) {
      this.configured = true
      previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      previewSession.setPermissionCheckHandler(() => false)
    }
    const view = new WebContentsView({ webPreferences: { session: previewSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false } })
    view.setBackgroundColor('#ffffff')
    const contents = view.webContents
    const openOutside = (url: string) => {
      try {
        void shell.openExternal(validateLinkUrl(url))
      } catch {
        // non-web targets are dropped
      }
    }
    // the preview stays on local servers; any other web address opens in the browser
    contents.on('will-frame-navigate', (event) => {
      if (!/^https?:/i.test(event.url) || isLocalPreviewUrl(event.url)) return
      event.preventDefault()
      openOutside(event.url)
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (isLocalPreviewUrl(url)) void contents.loadURL(url).catch(() => undefined)
      else openOutside(url)
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('did-navigate', (_event, url) => this.navigated(id, url))
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => isMainFrame && this.navigated(id, url))
    contents.on('page-title-updated', (_event, title) => this.emit({ id, type: 'title', title }))
    contents.on('did-start-loading', () => this.emit({ id, type: 'loading', loading: true }))
    contents.on('did-stop-loading', () => this.emit({ id, type: 'loading', loading: false }))
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3: aborted (a newer navigation replaced it)
      if (isMainFrame && code !== -3) this.emit({ id, type: 'failed', message: `${description} (${url})` })
    })
    return view
  }

  private navigated(id: string, url: string) {
    const entry = this.views.get(id)
    if (entry && isLocalPreviewUrl(url)) entry.url = url
    this.emit({ id, type: 'navigated', url })
  }
}
