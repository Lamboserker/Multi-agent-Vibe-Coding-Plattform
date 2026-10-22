import { useState } from 'react'
import { Cpu, RefreshCw, Sparkles } from 'lucide-react'
import { api } from '../../lib/api'
import { formatDuration, formatTokens, useVisibleLoader } from '../../lib/hooks'
import type { SuitabilityStats, UsageSummary } from '../../lib/types'
import { Spinner } from '../common'
import { Chip, ScreenHeader, Seg } from '../ui'
import { EnergyCard } from './EnergyCard'

type Range = '1' | '7' | '30' | 'all'
const CONFIDENCE: Record<SuitabilityStats['confidence'], { label: string; tone: 'ok' | 'tool' | 'err' | 'faint' }> = {
  insufficient_data: { label: 'zu wenig Daten', tone: 'faint' },
  low: { label: 'niedrig', tone: 'err' },
  medium: { label: 'mittel', tone: 'tool' },
  high: { label: 'hoch', tone: 'ok' },
}
const PURPOSE: Record<string, string> = { plan: 'Plan', review: 'Review', execute: 'Ausführung', repair: 'Reparatur', analyze: 'Analyse', chat: 'Frage', review_fix: 'Review-Fix', repair_hint: 'Premium-Hinweis' }
const fmtCompact = (value: number) => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1).replace('.', ',')}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value))

export function UsageScreen() {
  const [range, setRange] = useState<Range>('30')
  const usage = useVisibleLoader(() => api.get<UsageSummary>(`/usage${range === 'all' ? '' : `?days=${range}`}`), [range])
  const stats = useVisibleLoader(() => api.get<SuitabilityStats[]>('/stats/models'), [])
  const data = usage.data
  const local = data ? data.local.inputTokens + data.local.outputTokens : 0
  const premium = data ? data.premium.inputTokens + data.premium.outputTokens : 0
  const total = local + premium
  const share = total ? Math.round((local / total) * 100) : 0
  return (
    <div className="screen-scroll">
      <div className="screen-inner">
        <ScreenHeader title="Nutzung & Kosten" subtitle="Gemessen aus CLI- und Ollama-Antworten. Unter Abonnement fallen für den Orchestrator keine API-Kosten an.">
          <Seg label="Zeitraum" value={range} onChange={setRange} options={[{ id: '1', label: '24 h' }, { id: '7', label: '7 Tage' }, { id: '30', label: '30 Tage' }, { id: 'all', label: 'Gesamt' }]} />
          <button className="hdr-icon" title="Aktualisieren" aria-label="Aktualisieren" onClick={() => { void usage.reload(); void stats.reload() }}>
            {usage.loading ? <Spinner /> : <RefreshCw size={14} />}
          </button>
        </ScreenHeader>
        {!data ? (usage.error ? <div className="callout error">{usage.error}</div> : <Spinner />) : (
          <>
            <div className="side-card" style={{ padding: 18, gap: 12 }}>
              <div className="row" style={{ alignItems: 'baseline', gap: 10 }}>
                <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em' }}>{total ? `${share} %` : '–'}</span>
                <span className="muted">aller Tokens liefen lokal</span>
                <span className="spacer" />
                <span className="faint" style={{ fontSize: 12 }}>{fmtCompact(total)} Tokens gesamt (gemessen)</span>
              </div>
              <div className="share-bar">
                <div style={{ width: `${total ? share : 0}%`, background: 'var(--local)' }} />
                <div style={{ flex: 1, background: total ? 'var(--accent)' : 'var(--line)' }} />
              </div>
              <div className="row muted" style={{ gap: 18, fontSize: 12 }}>
                <span className="row" style={{ gap: 6 }}><span className="legend" style={{ background: 'var(--local)' }} />Lokale Modelle · {fmtCompact(local)}</span>
                <span className="row" style={{ gap: 6 }}><span className="legend" style={{ background: 'var(--accent)' }} />Premium-Orchestrator · {fmtCompact(premium)}</span>
              </div>
            </div>
            <div className="side-card grid-2" style={{ padding: 16 }}>
              <div className="stack" style={{ gap: 4 }}>
                <span className="faint" style={{ fontSize: 12 }}>Tatsächliche API-Kosten</span>
                <span className="mono" style={{ fontSize: 24, fontWeight: 600 }}>${data.spend.actualUsd.toFixed(4)}</span>
                <span className="faint" style={{ fontSize: 11.5 }}>{data.spend.actualBasis}</span>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <span className="faint" style={{ fontSize: 12 }}>Lokale Tokens zum Premium-Listenpreis</span>
                <span className="mono" style={{ fontSize: 24, fontWeight: 600, color: 'var(--ok)' }}>{data.baseline ? `$${data.baseline.localTokensAtPremiumPriceUsd.toFixed(2)}` : '–'}</span>
                <span className="faint" style={{ fontSize: 11.5 }}>{data.baseline ? `Schätzung: $${data.baseline.effectiveInputPerMillion}/M Input, $${data.baseline.effectiveOutputPerMillion}/M Output. ${data.baseline.method}` : 'Keine Preisbasis: das CLI hat keine Kosten gemeldet und in den Einstellungen ist kein Preis eingetragen.'}</span>
              </div>
            </div>
            <EnergyCard days={range === 'all' ? 366 : Number(range)} />
            <div className="grid-2">
              <div className="side-card" style={{ padding: 16, gap: 12 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="kind-icon" style={{ width: 26, height: 26, background: 'var(--accent-soft)', color: 'var(--accent)' }}><Sparkles size={14} /></span>
                  <strong>Premium-Orchestrator</strong>
                  <span className="spacer" />
                  <span style={{ fontSize: 12, color: 'var(--accent)' }}>{data.premium.calls} Aufrufe</span>
                </div>
                <div className="kv-grid wide">
                  <span>Tokens</span><span>{formatTokens(data.premium.inputTokens)} Input · {formatTokens(data.premium.outputTokens)} Output · {formatTokens(data.premium.cachedInputTokens)} Cache</span>
                  <span>Nach Zweck</span><span>{Object.entries(data.premium.byPurpose).map(([purpose, count]) => `${PURPOSE[purpose] ?? purpose}: ${count}`).join(' · ') || '–'}</span>
                  <span>Messbasis</span><span>{data.premium.measuredCalls} gemessen{data.premium.unmeasuredCalls ? `, ${data.premium.unmeasuredCalls} ohne Messung` : ''}</span>
                  <span>Laufzeit</span><span>{formatDuration(data.premium.durationMs)}</span>
                  <span>API-Äquivalent</span><span>{data.premium.apiEquivalentUsd.basis === 'none' ? '–' : `$${data.premium.apiEquivalentUsd.value.toFixed(2)} (unter Abo nicht berechnet)`}</span>
                </div>
                {data.subscription?.map((entry) => (
                  <div key={entry.id} className="faint" style={{ fontSize: 11.5 }}>
                    {entry.id}: {entry.authMethod ?? 'nicht angemeldet'}
                    {entry.rateLimit ? ` · Limit ${entry.rateLimit.window ?? ''}: ${entry.rateLimit.status}${entry.rateLimit.resetsAt ? `, Reset ${new Date(entry.rateLimit.resetsAt).toLocaleString('de-DE')}` : ''}` : ''}
                  </div>
                ))}
              </div>
              <div className="side-card" style={{ padding: 16, gap: 12 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="kind-icon" style={{ width: 26, height: 26, background: 'var(--local-soft)', color: 'var(--local)' }}><Cpu size={14} /></span>
                  <strong>Lokale Modelle</strong>
                  <span className="spacer" />
                  <span style={{ fontSize: 12, color: 'var(--local)' }}>{data.local.calls} Aufrufe</span>
                </div>
                <div className="kv-grid wide">
                  <span>Tokens</span><span>{formatTokens(data.local.inputTokens)} Input · {formatTokens(data.local.outputTokens)} Output</span>
                  <span>Inferenzzeit</span><span>{formatDuration(data.local.durationMs)}</span>
                  <span>Spitzen-Speicher</span><span>{data.local.peakMemoryMb ? `${data.local.peakMemoryMb.toLocaleString('de-DE')} MB (laut Ollama)` : '–'}</span>
                  <span>Energie</span><span>{data.local.energyWh ? `${(data.local.energyWh.value / 1000).toFixed(2).replace('.', ',')} kWh – ${data.local.energyWh.label}` : 'keine Schätzung (GPU-Leistung in den Einstellungen angeben)'}</span>
                </div>
                {Object.entries(data.local.byModel).map(([model, entry]) => (
                  <div key={model} className="row faint" style={{ fontSize: 11.5 }}>
                    <span className="mono">{model}</span>
                    <span className="spacer" />
                    <span>{entry.calls} · {formatTokens(entry.inputTokens + entry.outputTokens)} Tok. · {formatDuration(entry.durationMs)}</span>
                  </div>
                ))}
              </div>
            </div>
            {data.notes.map((note, index) => <div key={index} className="faint" style={{ fontSize: 12 }}>{note}</div>)}
          </>
        )}
        <div className="table-card">
          <div className="table-card-head" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
            <strong>Lernendes Routing – gemessene Eignung</strong>
            <span className="faint" style={{ fontSize: 12 }}>Erfolg = Patch bestand die Validierung. Untergrenze nach Wilson (90 %); unter 5 Versuchen keine Einstufung.</span>
          </div>
          <div className="routing-row head"><span>Modell</span><span>Kategorie</span><span>Erfolg</span><span>Untergrenze</span><span>Eignung</span><span>Ø Dauer</span></div>
          {!stats.data?.length ? <div className="faint table-empty">Noch keine Messdaten.</div> : stats.data.map((entry) => {
            const confidence = CONFIDENCE[entry.confidence]
            return (
              <div key={`${entry.model}-${entry.category}`} className="routing-row">
                <span className="mono truncate" style={{ fontSize: 12 }}>{entry.model}</span>
                <span className="muted">{entry.category}</span>
                <span className="mono" style={{ fontSize: 12 }}>{entry.successes}/{entry.attempts}</span>
                <span className="row" style={{ gap: 8 }}>
                  <span className="bar" style={{ flex: 1, height: 4 }}><span style={{ display: 'block', height: '100%', width: `${Math.round(entry.lowerBound * 100)}%`, background: `var(--${confidence.tone})` }} /></span>
                  <span className="mono" style={{ fontSize: 11, width: 34 }}>{entry.confidence === 'insufficient_data' ? '–' : `${Math.round(entry.lowerBound * 100)}%`}</span>
                </span>
                <span><Chip tone={confidence.tone} mono={false}>{confidence.label}</Chip></span>
                <span className="mono muted" style={{ fontSize: 11.5 }}>{formatDuration(entry.avgDurationMs)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
