import { useEffect, useState } from 'react'
import { Check, Sparkles } from 'lucide-react'
import { api, errorMessage } from '../../lib/api'
import { useLoader } from '../../lib/hooks'
import { useApp } from '../../lib/store'
import type { CostMode, HardwareProfile, OrchestratorOverview } from '../../lib/types'
import { CommandTerminal } from '../bottom/TerminalInstance'
import { AsyncButton, DiffText, Spinner, StatusDot } from '../common'
import { HardwareSummary, LocalModelManager } from '../models/LocalModelManager'
import { OrchestratorConnect } from '../orchestrator/OrchestratorConnect'
import { ProjectSetup } from '../panels/ProjectsPanel'

const STEPS = [
  { id: 'welcome', title: 'Willkommen' },
  { id: 'orchestrator', title: 'Orchestrator' },
  { id: 'hardware', title: 'Hardware' },
  { id: 'local_ai', title: 'Lokale KI' },
  { id: 'workspace', title: 'Workspace' },
  { id: 'cost_mode', title: 'Kostenmodus' },
  { id: 'function_test', title: 'Funktionstest' },
] as const

type StepId = (typeof STEPS)[number]['id']

export function Onboarding() {
  const { settings } = useApp()
  const [step, setStep] = useState<StepId>('welcome')
  const done = settings?.onboarding.steps ?? {}
  const index = STEPS.findIndex((entry) => entry.id === step)
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, index + 1)]!.id)

  return (
    <div className="onboarding">
      <aside>
        <div className="brand">
          <Sparkles size={20} color="var(--accent)" /> Multi-AI Coder
        </div>
        {STEPS.map((entry, position) => (
          <button key={entry.id} className={`step-link ${entry.id === step ? 'active' : ''} ${done[entry.id]?.ok ? 'done' : ''}`} onClick={() => setStep(entry.id)}>
            <span className="num">{done[entry.id]?.ok ? <Check size={12} /> : position + 1}</span>
            {entry.title}
          </button>
        ))}
      </aside>
      <main>
        <div className="content">
          {step === 'welcome' ? <Welcome onNext={next} /> : null}
          {step === 'orchestrator' ? <OrchestratorStep onNext={next} /> : null}
          {step === 'hardware' ? <HardwareStep onNext={next} /> : null}
          {step === 'local_ai' ? <LocalAiStep onNext={next} /> : null}
          {step === 'workspace' ? <WorkspaceStep onNext={next} /> : null}
          {step === 'cost_mode' ? <CostStep onNext={next} /> : null}
          {step === 'function_test' ? <FunctionTestStep /> : null}
        </div>
      </main>
    </div>
  )
}

async function markStep(step: string, ok: boolean, detail?: string) {
  await api.post('/onboarding/step', { step, ok, detail })
}

function Welcome({ onNext }: { onNext: () => void }) {
  const { reloadSettings } = useApp()
  const { data: info } = useLoader(() => api.get<{ git?: string; dataDir: string; platform: string }>('/system/info'), [])
  return (
    <>
      <h1>Willkommen bei Multi-AI Coder</h1>
      <p>
        Ein Premium-Modell – <strong>Claude Code</strong> oder <strong>OpenAI Codex</strong> mit deinem bestehenden Abonnement – plant und überwacht. Die eigentliche Implementierung übernehmen
        bevorzugt <strong>lokale Coding-Modelle</strong> über Ollama. Jede Änderung entsteht in einem isolierten Git-Worktree, wird automatisch geprüft und getestet und erst nach deiner Freigabe übernommen.
      </p>
      <div className="card stack">
        <div className="section-title">Systemvoraussetzungen</div>
        <div className="row">
          <StatusDot status={info?.git ? 'ok' : 'failed'} /> Git: {info?.git ?? 'nicht gefunden – bitte Git installieren (https://git-scm.com)'}
        </div>
        <div className="row">
          <StatusDot status="ok" /> Datenordner: <code>{info?.dataDir}</code>
        </div>
        <div className="faint">Claude Code bzw. Codex und Ollama werden in den nächsten Schritten erkannt und nur mit deiner Zustimmung installiert. Es werden keine Pakete heimlich installiert.</div>
      </div>
      <div className="row">
        <span className="spacer" />
        <AsyncButton className="btn primary" disabled={!info?.git} onClick={async () => { await markStep('welcome', true); await reloadSettings(); onNext() }}>
          Los geht’s
        </AsyncButton>
      </div>
    </>
  )
}

function OrchestratorStep({ onNext }: { onNext: () => void }) {
  const { reloadSettings, settings } = useApp()
  const [command, setCommand] = useState<{ command: string[]; title: string; key: number }>()
  const [overview, setOverview] = useState<OrchestratorOverview>()
  const status = overview?.orchestrators.find((entry) => entry.id === settings?.orchestrator)?.status
  useEffect(() => {
    void api.get<OrchestratorOverview>('/orchestrator?refresh=1').then(setOverview)
  }, [settings?.orchestrator, command?.key])
  const ready = Boolean(status?.authenticated && !status.usesApiKeyBilling)
  return (
    <>
      <h1>Orchestrator wählen</h1>
      <p className="muted">Der Orchestrator analysiert, plant, eskaliert und prüft. Die Anmeldung erfolgt ausschließlich über den offiziellen Login der jeweiligen CLI mit deinem Abonnement.</p>
      <OrchestratorConnect onRunCommand={(cmd, title) => setCommand({ command: cmd, title, key: Date.now() })} onChanged={setOverview} />
      {command ? (
        <div className="card stack">
          <div className="row">
            <strong>{command.title}</strong>
            <span className="spacer" />
            <button className="btn small" onClick={() => setCommand(undefined)}>Schließen</button>
          </div>
          <div style={{ height: 260 }}>
            <CommandTerminal key={command.key} requestKey={String(command.key)} command={command.command} title={command.title} onExit={() => void api.get<OrchestratorOverview>('/orchestrator?refresh=1').then(setOverview)} />
          </div>
        </div>
      ) : null}
      <div className="row">
        <span className="spacer" />
        <AsyncButton className="btn primary" disabled={!ready} onClick={async () => { await markStep('orchestrator', true, `${settings?.orchestrator}: ${status?.authMethod}`); await reloadSettings(); onNext() }}>
          Weiter
        </AsyncButton>
      </div>
    </>
  )
}

function HardwareStep({ onNext }: { onNext: () => void }) {
  const { reloadSettings } = useApp()
  const { data } = useLoader(() => api.get<HardwareProfile>('/local-models/hardware?refresh=1'), [])
  return (
    <>
      <h1>Hardwareanalyse</h1>
      <p className="muted">Aus diesen Werten werden passende lokale Modelle und die sinnvolle Parallelität abgeleitet.</p>
      <div className="card">
        <HardwareSummary hardware={data} />
      </div>
      <div className="row">
        <span className="spacer" />
        <AsyncButton className="btn primary" disabled={!data} onClick={async () => { await markStep('hardware', true); await reloadSettings(); onNext() }}>
          Weiter
        </AsyncButton>
      </div>
    </>
  )
}

function LocalAiStep({ onNext }: { onNext: () => void }) {
  const { reloadSettings, settings } = useApp()
  const hasRole = Boolean(settings?.modelRoles.fast || settings?.modelRoles.balanced || settings?.modelRoles.advanced)
  return (
    <>
      <h1>Lokale KI einrichten</h1>
      <p className="muted">Wähle, welche Modelle installiert werden – nichts wird ohne deine Bestätigung heruntergeladen. Danach jedem Modell eine Rolle zuweisen (ein Modell darf mehrere Rollen übernehmen) und den Inferenz-Selbsttest ausführen.</p>
      <LocalModelManager compact />
      <div className="row">
        {!hasRole ? <span className="warn-text">Ohne lokale Modelle übernimmt der Orchestrator alle Aufgaben (höherer Abo-Verbrauch).</span> : null}
        <span className="spacer" />
        <AsyncButton className="btn primary" onClick={async () => { await markStep('local_ai', hasRole, hasRole ? undefined : 'no local model'); await reloadSettings(); onNext() }}>
          {hasRole ? 'Weiter' : 'Ohne lokale Modelle weiter'}
        </AsyncButton>
      </div>
    </>
  )
}

function WorkspaceStep({ onNext }: { onNext: () => void }) {
  const { project, reloadSettings } = useApp()
  return (
    <>
      <h1>Workspace</h1>
      <p className="muted">Öffne ein bestehendes Git-Repository, lege ein neues Projekt an oder klone ein Repository.</p>
      <div className="card">
        <ProjectSetup />
      </div>
      {project ? <div className="callout ok">Geöffnet: <strong>{project.name}</strong> – <code>{project.repoPath}</code>{project.isGit === false ? ' (kein Git-Repository – Git kann im Git-Bereich initialisiert werden)' : ''}</div> : null}
      <div className="row">
        <span className="spacer" />
        <AsyncButton className="btn primary" onClick={async () => { await markStep('workspace', Boolean(project), project?.repoPath); await reloadSettings(); onNext() }}>
          {project ? 'Weiter' : 'Später öffnen'}
        </AsyncButton>
      </div>
    </>
  )
}

function CostStep({ onNext }: { onNext: () => void }) {
  const { settings, updateSettings, reloadSettings } = useApp()
  const options: Array<{ id: CostMode; title: string; text: string }> = [
    { id: 'cheapest', title: 'Cheapest', text: 'Premium nur für kritische Aufgaben (Sicherheit, Migrationen) und als letzte Eskalationsstufe.' },
    { id: 'balanced', title: 'Balanced', text: 'Routinearbeit lokal, schwierige oder riskante Teilaufgaben übernimmt der Orchestrator. Empfohlen.' },
    { id: 'quality', title: 'Quality', text: 'Premium für alles Nicht-Triviale, Premium-Review am Ende. Höchste Qualität, höchster Abo-Verbrauch.' },
  ]
  return (
    <>
      <h1>Kostenmodus</h1>
      <div className="choice-grid">
        {options.map((option) => (
          <button key={option.id} className={`choice ${settings?.costMode === option.id ? 'selected' : ''}`} onClick={() => void updateSettings({ costMode: option.id })}>
            <h3>{option.title}</h3>
            <span className="muted">{option.text}</span>
          </button>
        ))}
      </div>
      <div className="row">
        <span className="spacer" />
        <AsyncButton className="btn primary" onClick={async () => { await markStep('cost_mode', true, settings?.costMode); await reloadSettings(); onNext() }}>
          Weiter
        </AsyncButton>
      </div>
    </>
  )
}

interface SelfTestStatus {
  taskId: string
  status: string
  finished: boolean
  ok: boolean
  checks: Array<{ id: string; label: string; ok: boolean; detail: string }>
  diff: string | null
  error: string | null
}

function FunctionTestStep() {
  const { reloadSettings, updateSettings, settings, notify } = useApp()
  const [taskId, setTaskId] = useState<string>()
  const [status, setStatus] = useState<SelfTestStatus>()

  useEffect(() => {
    if (!taskId) return
    let active = true
    const poll = async () => {
      try {
        const next = await api.get<SelfTestStatus>(`/self-test/${taskId}`)
        if (!active) return
        setStatus(next)
        if (next.finished) {
          await markStep('function_test', next.ok, next.checks.map((check) => `${check.id}:${check.ok ? 'ok' : 'fail'}`).join(','))
          await reloadSettings()
          return
        }
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
      if (active) window.setTimeout(() => void poll(), 2500)
    }
    void poll()
    return () => {
      active = false
    }
  }, [taskId, reloadSettings, notify])

  const complete = async () => {
    await api.post('/onboarding/complete')
    await reloadSettings()
  }

  return (
    <>
      <h1>Funktionstest</h1>
      <p className="muted">
        Eine kleine Coding-Aufgabe wird tatsächlich ausgeführt – in einem eigenen Beispiel-Repository im Datenordner, nicht in deinem Projekt: Der Orchestrator plant, ein lokales Modell schreibt den Code,
        der Patch wird im isolierten Worktree geprüft und getestet, und der Diff wird angezeigt. Das verbraucht einen kleinen Teil deines Abo-Kontingents.
      </p>
      {!taskId ? (
        <AsyncButton className="btn primary" onClick={async () => setTaskId((await api.post<{ taskId: string }>('/self-test')).taskId)}>
          Funktionstest starten
        </AsyncButton>
      ) : null}
      {status ? (
        <div className="card stack">
          <div className="row">
            {status.finished ? <StatusDot status={status.ok ? 'ok' : 'failed'} /> : <Spinner />}
            <strong>{status.finished ? (status.ok ? 'Alle Prüfungen bestanden' : 'Nicht alle Prüfungen bestanden') : `Läuft … (${status.status})`}</strong>
          </div>
          {status.checks.map((check) => (
            <div key={check.id} className="row">
              <StatusDot status={check.ok ? 'ok' : status.finished ? 'failed' : 'pending'} />
              <span>{check.label}</span>
              <span className="faint">{check.detail}</span>
            </div>
          ))}
          {status.error ? <div className="callout error">{status.error}</div> : null}
          {status.diff ? <DiffText diff={status.diff} /> : null}
        </div>
      ) : taskId ? <div className="row"><Spinner /> Starte …</div> : null}
      <div className="row">
        {status?.finished && !status.ok ? (
          <button className="btn" onClick={() => { setTaskId(undefined); setStatus(undefined) }}>
            Erneut versuchen
          </button>
        ) : null}
        <span className="spacer" />
        {status?.finished && status.ok ? (
          <AsyncButton className="btn primary" onClick={complete}>
            Einrichtung abschließen
          </AsyncButton>
        ) : (
          <AsyncButton className="btn ghost" onClick={complete} title="Die Einrichtung gilt dann nicht als vollständig funktionsfähig.">
            Ohne erfolgreichen Funktionstest fortfahren
          </AsyncButton>
        )}
      </div>
      {settings?.onboarding.steps.function_test && !settings.onboarding.steps.function_test.ok ? (
        <div className="faint">Hinweis: Die Einrichtung ist erst vollständig funktionsfähig, wenn der Funktionstest bestanden ist.</div>
      ) : null}
    </>
  )
}
