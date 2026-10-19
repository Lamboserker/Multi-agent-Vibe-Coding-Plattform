import { useEffect, useState, type ReactNode } from 'react'
import * as actions from './lib/actions'
import { bridge } from './lib/api'
import { useRuntimeStatus, VisibilityContext } from './lib/hooks'
import { useAppState } from './lib/store'
import type { Screen } from './lib/stores'
import { commandForEvent } from './lib/commands'
import { Spinner, StatusDot, Toasts } from './components/common'
import { Onboarding } from './components/onboarding/Onboarding'
import { EditorDialogs } from './components/editor/EditorDialogs'
import { Footer, Header, NavRail } from './components/shell/Shell'
import { Leitstand } from './components/leitstand/Leitstand'
import { CodeScreen } from './components/code/CodeScreen'
import { ReviewScreen } from './components/review/ReviewScreen'
import { SessionsScreen } from './components/sessions/SessionsScreen'
import { ModelsScreen } from './components/models/ModelsScreen'
import { UsageScreen } from './components/usage/UsageScreen'
import { SetupScreen } from './components/setup/SetupScreen'

export function App() {
  const booted = useAppState((state) => state.booted)
  const onboardingDone = useAppState((state) => state.settings?.onboarding.completed)
  const hasSettings = useAppState((state) => Boolean(state.settings))

  if (!window.mac) return <div className="splash">Diese Oberfläche läuft nur in der Multi-AI-Coder-Desktop-App.</div>
  // The splash is only shown until the first successful start. Afterwards a runtime restart keeps the
  // IDE (and everything open in it) mounted; see ReconnectBanner.
  if (!booted || !hasSettings) return <RuntimeSplash />
  return (
    <>
      {onboardingDone ? <Workbench /> : <Onboarding />}
      <ReconnectBanner />
      <Toasts />
    </>
  )
}

function RuntimeSplash() {
  const runtime = useRuntimeStatus()
  const [log, setLog] = useState<string[]>([])
  useEffect(() => {
    const timer = window.setInterval(() => {
      void bridge()
        .runtime.status()
        .then((status) => setLog(status.log ?? []))
        .catch(() => undefined)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [])
  const failed = runtime?.state === 'failed'
  return (
    <div className="splash">
      <div className="row" style={{ fontSize: 18, fontWeight: 600 }}>
        {failed ? <StatusDot status="failed" /> : <Spinner />} Multi-AI Coder
      </div>
      <div className="muted">{failed ? 'Die lokale Laufzeit konnte nicht gestartet werden.' : runtime?.state === 'ready' ? 'Arbeitsstand wird wiederhergestellt …' : runtime?.state === 'restarting' ? 'Lokale Laufzeit wird neu gestartet …' : 'Lokale Laufzeit startet …'}</div>
      {runtime?.lastError ? <div className="callout error" style={{ maxWidth: 680 }}>{runtime.lastError}</div> : null}
      {failed ? (
        <button className="btn primary" onClick={() => void bridge().runtime.restart()}>
          Erneut starten
        </button>
      ) : null}
      {log.length && runtime?.state !== 'ready' ? <pre className="pre" style={{ width: 'min(900px, 90vw)', maxHeight: 260 }}>{log.slice(-30).join('\n')}</pre> : null}
    </div>
  )
}

/** Shown while the runtime restarts after a crash. Nothing below is unmounted or reset. */
function ReconnectBanner() {
  const reconnecting = useAppState((state) => state.reconnecting)
  const runtime = useRuntimeStatus()
  if (!reconnecting) return null
  return (
    <div className="reconnect-banner" role="status">
      {runtime?.state === 'failed' ? <StatusDot status="failed" /> : <Spinner />}
      <span>
        {runtime?.state === 'failed' ? 'Die lokale Laufzeit ist ausgefallen.' : 'Lokale Laufzeit startet neu …'} Offene Dateien, Sitzungen und Terminals bleiben erhalten; laufende Ausführungen werden danach korrekt als fortgesetzt oder unterbrochen angezeigt.
      </span>
      {runtime?.state === 'failed' ? (
        <button className="btn small" onClick={() => void bridge().runtime.restart()}>
          Erneut starten
        </button>
      ) : null}
    </div>
  )
}

const SCREENS: Record<Screen, (visible: boolean) => ReactNode> = {
  leitstand: () => <Leitstand />,
  code: (visible) => <CodeScreen visible={visible} />,
  review: () => <ReviewScreen />,
  sessions: () => <SessionsScreen />,
  models: () => <ModelsScreen />,
  usage: () => <UsageScreen />,
  setup: () => <SetupScreen />,
}

/**
 * Screens are mounted on first visit and then kept (hidden): the editor, terminals and forms keep
 * their state, and switching back is instant.
 */
function Screens({ screen }: { screen: Screen }) {
  // the Leitstand holds the chat composer (drafts, flush before editor hand-offs): always mounted
  const [mounted, setMounted] = useState<Screen[]>(() => [...new Set<Screen>(['leitstand', screen])])
  useEffect(() => setMounted((current) => (current.includes(screen) ? current : [...current, screen])), [screen])
  return (
    <>
      {mounted.map((id) => (
        <div key={id} className="screen" data-screen={id} style={{ display: id === screen ? 'flex' : 'none' }}>
          <VisibilityContext.Provider value={id === screen}>{SCREENS[id](id === screen)}</VisibilityContext.Provider>
        </div>
      ))}
    </>
  )
}

function Workbench() {
  const screen = useAppState((state) => state.ui.screen)

  // global shortcuts (command registry); editor-specific ones are bound inside Monaco
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = commandForEvent(event)
      if (!command || (command.enabled && !command.enabled())) return
      event.preventDefault()
      event.stopPropagation()
      void Promise.resolve(command.run()).catch((error: unknown) => actions.notify(error instanceof Error ? error.message : String(error), 'error'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="ide app-shell" data-screen={screen}>
      <Header />
      <NavRail />
      <main className="app-main">
        <Screens screen={screen} />
      </main>
      <Footer />
      <EditorDialogs />
    </div>
  )
}
