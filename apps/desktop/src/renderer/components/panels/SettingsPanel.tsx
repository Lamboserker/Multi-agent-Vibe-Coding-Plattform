import { useEffect, useRef, useState, type ReactNode } from 'react'
import { bridge } from '../../lib/api'
import { useLoader } from '../../lib/hooks'
import { useApp } from '../../lib/store'
import type { Settings } from '../../lib/types'
import { OrchestratorConnect } from '../orchestrator/OrchestratorConnect'
import { runInTerminal } from '../bottom/BottomPanel'
import { PanelHeader } from '../common'
import { api } from '../../lib/api'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="stack" style={{ gap: 3 }}>
      <span>{label}</span>
      {children}
      {hint ? <span className="faint" style={{ fontSize: 11.5 }}>{hint}</span> : null}
    </label>
  )
}

export function SettingsPanel() {
  const { settings, updateSettings } = useApp()
  const { data: info } = useLoader(() => api.get<{ dataDir: string; isolation: Record<string, string>; git?: string }>('/system/info'), [])
  if (!settings) return null
  const set = (patch: Partial<Settings>) => void updateSettings(patch)
  const numberField = (key: keyof Settings, min: number, max: number) => (
    <NumberField value={settings[key] as number} min={min} max={max} onCommit={(value) => set({ [key]: value } as Partial<Settings>)} />
  )

  return (
    <>
      <PanelHeader title="Einstellungen" />
      <div className="panel-body stack" style={{ gap: 14 }}>
        <div className="card stack">
          <div className="section-title">Orchestrator</div>
          <OrchestratorConnect onRunCommand={(command, title) => runInTerminal(command, title)} />
          <Field label="Abrechnungsmodus der Orchestrator-CLI" hint="„Abonnement“ entfernt API-Key-Variablen aus der Umgebung der CLI, damit niemals unbemerkt pro Token abgerechnet wird.">
            <select className="select" value={settings.orchestratorAuthMode} onChange={(event) => set({ orchestratorAuthMode: event.target.value as Settings['orchestratorAuthMode'] })}>
              <option value="subscription">Abonnement (empfohlen)</option>
              <option value="api_key">API-Key ausdrücklich erlauben (kostenpflichtig)</option>
            </select>
          </Field>
        </div>

        <div className="card stack">
          <div className="section-title">Kosten & Routing</div>
          <Field label="Kostenmodus" hint="cheapest: Premium nur für kritische Aufgaben · balanced: Routine lokal, Schweres premium · quality: Premium für alles Nicht-Triviale">
            <select className="select" value={settings.costMode} onChange={(event) => set({ costMode: event.target.value as Settings['costMode'] })}>
              <option value="cheapest">Cheapest</option>
              <option value="balanced">Balanced</option>
              <option value="quality">Quality</option>
            </select>
          </Field>
          <label className="row"><input type="checkbox" checked={settings.premiumExecutionAllowed} onChange={(event) => set({ premiumExecutionAllowed: event.target.checked })} /> Premium darf Aufgaben selbst implementieren (sonst nur Planung/Review)</label>
          <Field label="Premium-Review" hint="Risikobasiert: bei sicherheitskritischen Dateien, Risiko ≥ 4, > 400 geänderten Zeilen, fehlgeschlagener Validierung oder ohne bestandene Tests.">
            <select className="select" value={settings.premiumReviewPolicy} onChange={(event) => set({ premiumReviewPolicy: event.target.value as Settings['premiumReviewPolicy'] })}>
              <option value="risk_based">Risikobasiert</option>
              <option value="always">Immer</option>
              <option value="never">Nie (nur automatische Prüfung)</option>
            </select>
          </Field>
          <div className="row wrap">
            <Field label="Max. Teilaufgaben">{numberField('maxTasks', 1, 20)}</Field>
            <Field label="Lokale Reparaturversuche">{numberField('maxLocalRepairs', 0, 4)}</Field>
            <Field label="Eskalationsstufen">{numberField('maxEscalationSteps', 0, 3)}</Field>
            <Field label="Review-Fix-Runden">{numberField('reviewFixRounds', 0, 2)}</Field>
          </div>
          <div className="row wrap">
            <Field label="Lokale Parallelität">
              <select className="select" value={String(settings.localParallelism)} onChange={(event) => set({ localParallelism: event.target.value === 'auto' ? 'auto' : Number(event.target.value) })}>
                <option value="auto">Automatisch (nach VRAM)</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </select>
            </Field>
            <Field label="Kontextfenster lokal (num_ctx)">{numberField('numCtx', 2048, 262144)}</Field>
            <Field label="Timeout pro Aufgabe (min)">{numberField('taskTimeoutMinutes', 2, 120)}</Field>
          </div>
        </div>

        <div className="card stack">
          <div className="section-title">Freigabe & Sicherheit</div>
          <Field label="Freigabemodus" hint="Automatische Modi greifen nur, wenn Validierung und Review bestanden sind und keine sicherheitskritischen Dateien betroffen sind. Es wird nie gepusht.">
            <select className="select" value={settings.approvalMode} onChange={(event) => set({ approvalMode: event.target.value as Settings['approvalMode'] })}>
              <option value="manual">Manuell (empfohlen)</option>
              <option value="auto_branch">Automatisch als Branch behalten</option>
              <option value="auto_working_tree">Automatisch in die Arbeitskopie übernehmen</option>
            </select>
          </Field>
          <label className="row"><input type="checkbox" checked={settings.planApproval} onChange={(event) => set({ planApproval: event.target.checked })} /> Plan vor der Ausführung bestätigen</label>
          <label className="row"><input type="checkbox" checked={settings.allowProjectCode} onChange={(event) => set({ allowProjectCode: event.target.checked })} /> Projekt-Skripte (Tests/Typecheck) im Worktree ausführen</label>
          <label className="row"><input type="checkbox" checked={settings.strictScope} onChange={(event) => set({ strictScope: event.target.checked })} /> Änderungen außerhalb des geplanten Dateiumfangs blockieren</label>
          {info ? (
            <div className="stack faint" style={{ fontSize: 12 }}>
              {Object.entries(info.isolation).map(([key, value]) => (
                <div key={key}>• {value}</div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="card stack">
          <div className="section-title">Kostenanzeige</div>
          <Field label="GPU-Leistungsaufnahme (W) für Energieschätzung" hint="Optional. Wird nur als gekennzeichnete Schätzung angezeigt.">
            <NumberField value={settings.gpuWatts} min={1} max={1999} allowEmpty onCommit={(value) => set({ gpuWatts: value })} />
          </Field>
        </div>

        <div className="card stack">
          <div className="section-title">System</div>
          <div className="kv" style={{ fontSize: 12 }}>
            <span>Datenordner</span>
            <span className="mono">{info?.dataDir}</span>
            <span>Git</span>
            <span>{info?.git ?? 'nicht gefunden'}</span>
          </div>
          <div className="row wrap">
            <button className="btn" onClick={() => info && void bridge().shell.showItem(info.dataDir)}>Datenordner öffnen</button>
            <button className="btn" onClick={() => set({ onboarding: { ...settings.onboarding, completed: false } })}>Einrichtungsassistent erneut öffnen</button>
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * Numeric setting with a local draft. The draft is committed on Enter, on blur, after a short pause
 * while typing and when the view unmounts, so a value is never lost by navigating away. External
 * changes (other views, the runtime) update the field unless it is being edited.
 */
function NumberField({ value, min, max, allowEmpty = false, onCommit }: { value: number | null; min: number; max: number; allowEmpty?: boolean; onCommit: (value: number | null) => void }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  const editing = useRef(false)
  const pending = useRef<string | undefined>(undefined)
  const timer = useRef<number | undefined>(undefined)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => {
    if (!editing.current) setDraft(value === null ? '' : String(value))
  }, [value])

  const commit = (raw: string | undefined) => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
    pending.current = undefined
    if (raw === undefined) return
    if (raw.trim() === '') {
      if (allowEmpty && valueRef.current !== null) commitRef.current(null)
      return
    }
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max || parsed === valueRef.current) return
    commitRef.current(parsed)
  }

  // unmount (view switch, window reload is handled by the debounce + blur)
  useEffect(() => () => commit(pending.current), [])

  return (
    <input
      className="input"
      type="number"
      min={min}
      max={max}
      value={draft}
      onFocus={() => {
        editing.current = true
      }}
      onChange={(event) => {
        setDraft(event.target.value)
        pending.current = event.target.value
        if (timer.current !== undefined) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => commit(pending.current), 700)
      }}
      onBlur={() => {
        editing.current = false
        commit(pending.current)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(pending.current)
      }}
    />
  )
}
