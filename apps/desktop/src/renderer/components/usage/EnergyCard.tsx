import { useEffect, useRef, useState } from 'react'
import { Pencil, Zap } from 'lucide-react'
import * as actions from '../../lib/actions'
import { api, errorMessage } from '../../lib/api'
import { useIsVisible } from '../../lib/hooks'
import { useAppState } from '../../lib/store'
import type { ElectricityTariff, EnergyStatus } from '../../lib/types'
import { Spinner } from '../common'
import { Dot, Eyebrow, Spark } from '../ui'

const euro = (value: number | null | undefined) => {
  if (value === null || value === undefined) return '–'
  // small amounts (a run, an hour) are shown in cents with more precision
  if (Math.abs(value) < 1) return `${(value * 100).toLocaleString('de-DE', { maximumFractionDigits: value * 100 < 1 ? 3 : 2, minimumFractionDigits: 2 })} ct`
  return value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
}
// below 1 kWh in Wh, so short sessions do not read as zero
const kwh = (value: number) => (value < 1 ? `${(value * 1000).toLocaleString('de-DE', { maximumFractionDigits: value * 1000 < 10 ? 1 : 0 })} Wh` : `${value.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kWh`)
const duration = (hours: number) => (hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toLocaleString('de-DE', { maximumFractionDigits: 1 })} h`)
const watts = (value: number | undefined) => (value === undefined ? '–' : `${Math.round(value).toLocaleString('de-DE')} W`)

/**
 * Electricity: live draw (GPU measured, rest of the PC estimated from the user's figures), energy per
 * day from the runtime's meter and costs from the user's tariff (unit price + pro-rata base price).
 */
export function EnergyCard({ days }: { days: number }) {
  const visible = useIsVisible()
  const gpuWatts = useAppState((state) => state.settings?.gpuWatts ?? null)
  const [status, setStatus] = useState<EnergyStatus>()
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState(false)
  const history = useRef<number[]>([])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const load = async () => {
      try {
        const next = await api.get<EnergyStatus>(`/system/energy?days=${days}`)
        if (cancelled) return
        history.current = [...history.current, next.live.totalW].slice(-40)
        setStatus(next)
        setError(undefined)
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught))
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [visible, days])

  if (!status) return <div className="side-card energy-card">{error ? <div className="callout error">{error}</div> : <Spinner />}</div>
  const { live, tariff, today, period } = status
  const maxDay = Math.max(0.001, ...status.daily.map((day) => day.kWh))
  const peak = Math.max(1, ...history.current)
  const showTariffForm = editing || !tariff
  return (
    <div className="side-card energy-card" data-testid="energy-card">
      <div className="row" style={{ gap: 8 }}>
        <span className="kind-icon" style={{ width: 26, height: 26, background: 'var(--tool-soft)', color: 'var(--tool)' }}><Zap size={14} /></span>
        <strong>Stromverbrauch & Stromkosten</strong>
        <span className="spacer" />
        <span className="row faint" style={{ gap: 6, fontSize: 11.5 }}>
          <Dot tone="ok" pulse />
          live · {Math.round(status.sampleIntervalMs / 1000)} s
        </span>
        {tariff && !editing ? (
          <button className="btn small" onClick={() => setEditing(true)}>
            <Pencil size={12} /> Tarif
          </button>
        ) : null}
      </div>

      <div className="energy-live">
        <div className="stack" style={{ gap: 2 }}>
          <span className="faint" style={{ fontSize: 12 }}>Leistung jetzt</span>
          <span className="energy-watts" data-testid="energy-live-watts">{watts(live.totalW)}</span>
          <span className="faint" style={{ fontSize: 11.5 }}>{live.inferenceActive ? 'ein lokales Modell arbeitet gerade' : 'kein lokales Modell aktiv'}</span>
        </div>
        <Spark values={history.current} tone="var(--tool)" max={peak} />
        <div className="stack" style={{ gap: 2, textAlign: 'right' }}>
          <span className="faint" style={{ fontSize: 12 }}>Kosten pro Stunde</span>
          <span className="energy-watts">{live.costPerHour ? euro(live.costPerHour.total) : '–'}</span>
          <span className="faint" style={{ fontSize: 11.5 }}>{live.costPerHour ? `${euro(live.costPerHour.energy)} Arbeitspreis + ${euro(live.costPerHour.base)} Grundpreis` : 'Tarif eintragen'}</span>
        </div>
      </div>

      <div className="kv-grid wide">
        <span>GPU</span>
        <span>{watts(live.gpuW)} · {live.gpuSource === 'nvidia-smi' ? 'gemessen (nvidia-smi)' : live.gpuSource === 'setting' ? 'angenommen aus der GPU-Leistung (nur während Inferenz)' : 'nicht messbar'}</span>
        <span>CPU & übriger PC</span>
        <span>{live.systemSource === 'estimate' ? `${watts(live.systemW)} · Schätzung aus deinen Angaben` : 'nicht berücksichtigt – Grundlast/CPU-Leistung im Tarif angeben'}</span>
      </div>

      <div className="grid-2" style={{ gap: 10 }}>
        <EnergyPeriod title="Heute" summary={today} />
        <EnergyPeriod title={period.days >= 366 ? 'Gesamt (365 Tage)' : `Letzte ${period.days} ${period.days === 1 ? 'Tag' : 'Tage'}`} summary={period} />
      </div>

      {status.daily.length > 1 ? (
        <div className="stack" style={{ gap: 6 }}>
          <Eyebrow>Verbrauch pro Tag</Eyebrow>
          <div className="energy-days" aria-label="Verbrauch pro Tag">
            {status.daily.slice(-60).map((day) => (
              <div key={day.date} title={`${new Date(day.date).toLocaleDateString('de-DE')}: ${kwh(day.kWh)} (davon KI ${kwh(day.inferenceKWh)})${day.energyCost !== null ? ` · ${euro(day.energyCost)}` : ''}`}>
                <div style={{ height: `${Math.max(2, (day.kWh / maxDay) * 100)}%` }}>
                  <div style={{ height: `${day.kWh ? (day.inferenceKWh / day.kWh) * 100 : 0}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="row muted" style={{ gap: 16, fontSize: 11.5 }}>
            <span className="row" style={{ gap: 6 }}><span className="legend" style={{ background: 'var(--tool)' }} />während lokaler KI-Arbeit</span>
            <span className="row" style={{ gap: 6 }}><span className="legend" style={{ background: 'color-mix(in oklch, var(--tool) 35%, transparent)' }} />übrige Zeit (App geöffnet)</span>
          </div>
        </div>
      ) : null}

      {showTariffForm ? <TariffForm tariff={tariff} gpuWatts={gpuWatts} needsGpuWatts={live.gpuSource !== 'nvidia-smi'} onDone={() => setEditing(false)} cancellable={Boolean(tariff)} /> : null}
      <div className="faint" style={{ fontSize: 11.5 }}>
        Gemessen wird, solange die App läuft{status.measuringSince ? ` (seit ${new Date(status.measuringSince).toLocaleDateString('de-DE')})` : ''}. Der Grundpreis fällt unabhängig von der Nutzung an und wird pro Kalendertag anteilig (Monatspreis × 12 / 365) ausgewiesen.
      </div>
    </div>
  )
}

function EnergyPeriod({ title, summary }: { title: string; summary: EnergyStatus['today'] }) {
  return (
    <div className="energy-period">
      <div className="row">
        <span className="faint" style={{ fontSize: 12 }}>{title}</span>
        <span className="spacer" />
        <span className="mono" style={{ fontSize: 16, fontWeight: 600 }}>{euro(summary.totalCost)}</span>
      </div>
      <div className="kv-grid">
        <span>Verbrauch</span><span>{kwh(summary.kWh)} in {duration(summary.hours)}</span>
        <span>davon KI</span><span>{kwh(summary.inferenceKWh)}</span>
        <span>Arbeitspreis</span><span>{euro(summary.energyCost)}</span>
        <span>Grundpreis anteilig</span><span>{euro(summary.baseCost)}</span>
      </div>
    </div>
  )
}

const parse = (value: string) => {
  const number = Number(value.replace(',', '.'))
  return value.trim() === '' || !Number.isFinite(number) ? undefined : number
}

function TariffForm({ tariff, gpuWatts, needsGpuWatts, onDone, cancellable }: { tariff: ElectricityTariff | null; gpuWatts: number | null; needsGpuWatts: boolean; onDone: () => void; cancellable: boolean }) {
  const [unit, setUnit] = useState(tariff ? String(Math.round(tariff.pricePerKwh * 10000) / 100).replace('.', ',') : '')
  const [base, setBase] = useState(tariff ? String(tariff.basePricePerMonth).replace('.', ',') : '')
  const [systemBase, setSystemBase] = useState(tariff?.systemBaseWatts != null ? String(tariff.systemBaseWatts) : '')
  const [cpuMax, setCpuMax] = useState(tariff?.cpuMaxWatts != null ? String(tariff.cpuMaxWatts) : '')
  const [gpu, setGpu] = useState(gpuWatts != null ? String(gpuWatts) : '')
  const unitCents = parse(unit)
  const basePrice = parse(base)
  const valid = unitCents !== undefined && unitCents >= 0 && unitCents < 1000 && basePrice !== undefined && basePrice >= 0 && basePrice < 1000
  const save = async () => {
    if (!valid) return
    const optional = (value: string) => {
      const number = parse(value)
      return number === undefined ? null : Math.max(0, Math.round(number))
    }
    try {
      await actions.updateSettings({
        electricity: { pricePerKwh: Math.round(unitCents! * 100) / 10000, basePricePerMonth: basePrice!, systemBaseWatts: optional(systemBase), cpuMaxWatts: optional(cpuMax) },
        ...(needsGpuWatts ? { gpuWatts: optional(gpu) || null } : {}),
      })
      actions.notify('Stromtarif gespeichert.', 'success')
      onDone()
    } catch {
      // the error is shown by updateSettings
    }
  }
  return (
    <form className="tariff-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <Eyebrow>Dein Stromtarif</Eyebrow>
      <div className="tariff-grid">
        <label>
          <span>Arbeitspreis (ct/kWh)</span>
          <input className="input" inputMode="decimal" placeholder="z. B. 32,5" value={unit} onChange={(event) => setUnit(event.target.value)} aria-label="Arbeitspreis in Cent pro kWh" />
        </label>
        <label>
          <span>Grundpreis (€/Monat)</span>
          <input className="input" inputMode="decimal" placeholder="z. B. 12,50" value={base} onChange={(event) => setBase(event.target.value)} aria-label="Grundpreis in Euro pro Monat" />
        </label>
        <label>
          <span>Grundlast PC (W, optional)</span>
          <input className="input" inputMode="numeric" placeholder="z. B. 60" value={systemBase} onChange={(event) => setSystemBase(event.target.value)} aria-label="Grundlast des PCs in Watt" />
        </label>
        <label>
          <span>CPU unter Volllast (W, optional)</span>
          <input className="input" inputMode="numeric" placeholder="z. B. 105" value={cpuMax} onChange={(event) => setCpuMax(event.target.value)} aria-label="CPU-Leistung unter Volllast in Watt" />
        </label>
        {needsGpuWatts ? (
          <label>
            <span>GPU unter Last (W)</span>
            <input className="input" inputMode="numeric" placeholder="z. B. 165" value={gpu} onChange={(event) => setGpu(event.target.value)} aria-label="GPU-Leistung unter Last in Watt" />
          </label>
        ) : null}
      </div>
      <div className="faint" style={{ fontSize: 11.5 }}>
        Arbeits- und Grundpreis stehen auf deiner Stromrechnung oder im Vertrag (brutto). Die GPU wird {needsGpuWatts ? 'ohne nvidia-smi nicht gemessen; ihre Leistung zählt dann nur, während ein lokales Modell arbeitet' : 'per nvidia-smi gemessen'}. Grundlast und CPU-Leistung sind deine Schätzung (Datenblatt oder Steckdosen-Messgerät); die CPU-Leistung wird mit der gemessenen Auslastung skaliert.
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button type="submit" className="btn primary small" disabled={!valid}>Tarif speichern</button>
        {cancellable ? <button type="button" className="btn small" onClick={onDone}>Abbrechen</button> : null}
      </div>
    </form>
  )
}
