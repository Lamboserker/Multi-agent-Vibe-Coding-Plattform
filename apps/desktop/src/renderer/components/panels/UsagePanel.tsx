import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../../lib/api'
import { formatDuration, formatTokens, useLoader } from '../../lib/hooks'
import type { SuitabilityStats, UsageSummary } from '../../lib/types'
import { Badge, PanelHeader, Spinner } from '../common'

const CONFIDENCE: Record<SuitabilityStats['confidence'], { label: string; kind?: 'ok' | 'warn' | 'error' }> = {
  insufficient_data: { label: 'zu wenig Daten' },
  low: { label: 'niedrig', kind: 'error' },
  medium: { label: 'mittel', kind: 'warn' },
  high: { label: 'hoch', kind: 'ok' },
}

export function UsagePanel() {
  const [days, setDays] = useState<number | undefined>(30)
  const usage = useLoader(() => api.get<UsageSummary>(`/usage${days ? `?days=${days}` : ''}`), [days])
  const stats = useLoader(() => api.get<SuitabilityStats[]>('/stats/models'), [])
  const data = usage.data
  return (
    <>
      <PanelHeader title="Nutzung & Kosten">
        <select className="select" style={{ width: 'auto', padding: '2px 6px' }} value={days ?? ''} onChange={(event) => setDays(event.target.value ? Number(event.target.value) : undefined)}>
          <option value="1">24 h</option>
          <option value="7">7 Tage</option>
          <option value="30">30 Tage</option>
          <option value="">Gesamt</option>
        </select>
        <button className="icon-btn" onClick={() => { void usage.reload(); void stats.reload() }} title="Aktualisieren">
          <RefreshCw size={14} />
        </button>
      </PanelHeader>
      <div className="panel-body stack">
        {!data ? <Spinner /> : (
          <>
            <div className="card stack">
              <div className="row">
                <strong>Premium-Orchestrator</strong>
                <span className="spacer" />
                <Badge kind="premium">{data.premium.calls} Aufrufe</Badge>
              </div>
              <div className="kv">
                <span>Tokens (gemessen)</span>
                <span>{formatTokens(data.premium.inputTokens)} Input · {formatTokens(data.premium.outputTokens)} Output · {formatTokens(data.premium.cachedInputTokens)} aus Cache</span>
                <span>Messbasis</span>
                <span>{data.premium.measuredCalls} gemessen{data.premium.unmeasuredCalls ? `, ${data.premium.unmeasuredCalls} ohne Messung (fehlgeschlagen)` : ''}</span>
                <span>Aufrufe nach Zweck</span>
                <span>{Object.entries(data.premium.byPurpose).map(([purpose, count]) => `${purpose}: ${count}`).join(' · ') || '–'}</span>
                <span>Laufzeit</span>
                <span>{formatDuration(data.premium.durationMs)}</span>
                <span>API-Listenpreis-Äquivalent</span>
                <span>
                  {data.premium.apiEquivalentUsd.basis === 'none' ? '–' : `$${data.premium.apiEquivalentUsd.value.toFixed(4)}`}{' '}
                  <span className="faint">({data.premium.apiEquivalentUsd.reportedCalls} vom CLI gemeldet; unter Abonnement nicht berechnet)</span>
                </span>
              </div>
              {data.subscription?.map((entry) => (
                <div key={entry.id} className="faint" style={{ fontSize: 12 }}>
                  {entry.id}: {entry.authMethod ?? 'nicht angemeldet'}
                  {entry.rateLimit ? ` · Limit-Fenster ${entry.rateLimit.window ?? ''}: ${entry.rateLimit.status}${entry.rateLimit.resetsAt ? `, Reset ${new Date(entry.rateLimit.resetsAt).toLocaleString()}` : ''}` : ' · Limitstatus noch nicht gemeldet'}
                </div>
              ))}
            </div>
            <div className="card stack">
              <div className="row">
                <strong>Lokale Modelle</strong>
                <span className="spacer" />
                <Badge kind="local">{data.local.calls} Aufrufe</Badge>
              </div>
              <div className="kv">
                <span>Tokens (gemessen)</span>
                <span>{formatTokens(data.local.inputTokens)} Input · {formatTokens(data.local.outputTokens)} Output</span>
                <span>Inferenzzeit</span>
                <span>{formatDuration(data.local.durationMs)}</span>
                <span>Spitzen-Speicher</span>
                <span>{data.local.peakMemoryMb ? `${data.local.peakMemoryMb} MB (laut Ollama)` : '–'}</span>
                <span>Energie</span>
                <span>{data.local.energyWh ? `${data.local.energyWh.value} Wh – ${data.local.energyWh.label}` : 'keine Schätzung (GPU-Leistung in den Einstellungen angeben)'}</span>
              </div>
              {Object.entries(data.local.byModel).map(([model, entry]) => (
                <div key={model} className="row" style={{ fontSize: 12 }}>
                  <span className="mono">{model}</span>
                  <span className="spacer" />
                  <span className="faint">{entry.calls} Aufrufe · {formatTokens(entry.inputTokens + entry.outputTokens)} Tokens · {formatDuration(entry.durationMs)}</span>
                </div>
              ))}
            </div>
            <div className="card stack">
              <strong>Ausgaben</strong>
              <div className="kv">
                <span>Tatsächliche API-Kosten</span>
                <span>${data.spend.actualUsd.toFixed(4)}</span>
              </div>
              <div className="faint" style={{ fontSize: 12 }}>{data.spend.actualBasis}</div>
              {data.baseline ? (
                <div className="callout">
                  <strong>Schätzung:</strong> {data.baseline.label}: <strong>${data.baseline.localTokensAtPremiumPriceUsd.toFixed(4)}</strong>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {data.baseline.method} Effektiver Preis: ${data.baseline.effectiveInputPerMillion}/M Input, ${data.baseline.effectiveOutputPerMillion}/M Output.
                  </div>
                </div>
              ) : null}
              {data.notes.map((note, index) => (
                <div key={index} className="faint" style={{ fontSize: 12 }}>
                  {note}
                </div>
              ))}
            </div>
          </>
        )}
        <div className="card stack">
          <strong>Lernendes Routing – gemessene Eignung</strong>
          <div className="faint" style={{ fontSize: 12 }}>Erfolgsquote = Versuche, deren Patch die Validierung bestand. Die Untergrenze (Wilson, 90 %) berücksichtigt die Stichprobengröße; unter 5 Versuchen wird keine Einstufung vorgenommen.</div>
          {!stats.data?.length ? <div className="faint">Noch keine Messdaten.</div> : (
            <table className="table">
              <thead>
                <tr>
                  <th>Modell</th>
                  <th>Kategorie</th>
                  <th>Erfolg</th>
                  <th>Untergrenze</th>
                  <th>Eignung</th>
                  <th>Ø Dauer</th>
                </tr>
              </thead>
              <tbody>
                {stats.data.map((entry) => (
                  <tr key={`${entry.model}-${entry.category}`}>
                    <td className="mono">{entry.model}</td>
                    <td>{entry.category}</td>
                    <td>{entry.successes}/{entry.attempts}</td>
                    <td>{Math.round(entry.lowerBound * 100)} %</td>
                    <td><Badge kind={CONFIDENCE[entry.confidence].kind}>{CONFIDENCE[entry.confidence].label}</Badge></td>
                    <td>{formatDuration(entry.avgDurationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  )
}
