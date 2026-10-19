import { useEffect, useRef, useState } from 'react'
import { Bug, ExternalLink, RotateCw } from 'lucide-react'
import * as actions from '../../lib/actions'
import { bridge } from '../../lib/api'
import type { EditorTab } from '../../lib/stores'
import { Spinner } from '../common'

/** App overlays that are drawn over the preview area: the native view must not cover them. */
const OVERLAYS = '.modal-backdrop, .modal, .popover, .popover-scrim, .palette-backdrop, .palette'

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/**
 * A local dev server inside the code screen (like VS Code's simple browser). The page itself is a
 * native view with its own process (main process, preview.ts): it never competes with the app's UI
 * for its thread, so it runs as smoothly as in a browser. This component only reserves the area,
 * keeps the view on top of it and hides it while the area is not visible or covered by a dialog –
 * showing a still image of the page meanwhile.
 */
export function PreviewView({ tab, visible }: { tab: EditorTab; visible: boolean }) {
  const area = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState(tab.path)
  const [still, setStill] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string>()
  useEffect(() => setAddress(tab.path), [tab.path])

  // events of this preview: the address follows navigation inside the page
  useEffect(
    () =>
      bridge().preview.onEvent((event) => {
        if (event.id !== tab.id) return
        if (event.type === 'navigated') {
          setFailure(undefined)
          if (event.url !== tab.path) actions.updatePreviewUrl(tab.id, event.url)
        } else if (event.type === 'loading') setLoading(event.loading)
        else if (event.type === 'failed') setFailure(event.message)
      }),
    [tab.id, tab.path],
  )

  // place the native view over the area; hide it while hidden, zero-sized or covered
  useEffect(() => {
    const element = area.current
    if (!element) return
    let frame = 0
    let shown = false
    let covered = false
    const sync = () => {
      frame = 0
      const rect = element.getBoundingClientRect()
      const onScreen = visible && rect.width > 1 && rect.height > 1 && element.offsetParent !== null
      const overlay = [...document.querySelectorAll<HTMLElement>(OVERLAYS)].some((node) => overlaps(node.getBoundingClientRect(), rect))
        || [...document.querySelectorAll<HTMLElement>('.toasts > *')].some((node) => overlaps(node.getBoundingClientRect(), rect))
      if (onScreen && !overlay) {
        covered = false
        setStill(null)
        shown = true
        void bridge().preview.show(tab.id, tab.path, { x: rect.left, y: rect.top, width: rect.width, height: rect.height }).catch(() => undefined)
        return
      }
      if (!shown) return
      shown = false
      if (onScreen && overlay && !covered) {
        // a still image keeps the page visible under the dialog
        covered = true
        void bridge().preview.capture(tab.id).then((image) => {
          setStill(image)
          return bridge().preview.hide(tab.id)
        }).catch(() => undefined)
      } else void bridge().preview.hide(tab.id).catch(() => undefined)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync)
    }
    schedule()
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    resize.observe(document.body)
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      void bridge().preview.hide(tab.id).catch(() => undefined)
    }
  }, [tab.id, tab.path, visible])

  // the page itself goes away when the tab is closed
  useEffect(() => () => void bridge().preview.close(tab.id).catch(() => undefined), [tab.id])

  const openInBrowser = () => void bridge().shell.openLink(tab.path).catch((error: unknown) => actions.notify(error instanceof Error ? error.message : String(error), 'error'))
  const go = () => {
    const target = address.trim()
    if (!target) return
    const url = /^[a-z]+:\/\//i.test(target) ? target : `http://${target}`
    // another local address stays in the app, anything else goes to the browser
    if (actions.openPreview(url)) return
    void bridge().shell.openLink(url).catch((error: unknown) => actions.notify(error instanceof Error ? error.message : String(error), 'error'))
    setAddress(tab.path)
  }

  return (
    <div className="editor-stack preview-view" style={{ display: visible ? 'flex' : 'none' }} data-testid="preview-view">
      <div className="preview-bar">
        <button className="icon-btn" title="Neu laden" aria-label="Vorschau neu laden" onClick={() => void bridge().preview.reload(tab.id)}>
          {loading ? <Spinner /> : <RotateCw size={14} />}
        </button>
        <input
          className="preview-address"
          aria-label="Adresse der Vorschau"
          value={address}
          spellCheck={false}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') go()
            if (event.key === 'Escape') setAddress(tab.path)
          }}
        />
        <button className="icon-btn" title="Entwicklertools der Seite" aria-label="Entwicklertools der Vorschau" onClick={() => void bridge().preview.devTools(tab.id)}>
          <Bug size={14} />
        </button>
        <button className="icon-btn" title="Im Browser öffnen" aria-label="Im Browser öffnen" onClick={openInBrowser}>
          <ExternalLink size={14} />
        </button>
      </div>
      <div ref={area} className="preview-area" data-testid="preview-area">
        {still ? <img className="preview-still" src={still} alt="" /> : null}
        {failure ? (
          <div className="preview-failure" role="alert">
            Die Seite konnte nicht geladen werden: {failure}
            <div className="faint">Läuft der Dev-Server noch? Starte ihn im Terminal neu und lade die Vorschau dann neu.</div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
