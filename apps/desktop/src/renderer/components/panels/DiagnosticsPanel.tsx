import { useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { notify } from '../../lib/actions'
import { api, apiTimings, bridge, errorMessage } from '../../lib/api'
import { formatDuration, useIsVisible } from '../../lib/hooks'
import { Badge, PanelHeader, Spinner } from '../common'

interface Summary {
  n: number
  p50: number | null
  p95: number | null
  max: number | null
}

interface Diagnostics {
  collectedAt: string
  runtime: { pid: number; uptimeSec: number; rssMb: number; heapUsedMb: number; cpuUserMs: number; cpuSystemMs: number }
  system: { platform: string; cpuModel?: string; logicalCores: number; cpuLoadPercent: number; memoryTotalMb: number; memoryFreeMb: number }
  gpu: Array<{ name: string; vramTotalMb: number; vramUsedMb: number; utilizationPercent: number; temperatureC: number }> | null
  models: {
    loaded: Array<{ name: string; vramMb: number; sizeMb: number; expiresAt: string }>
    inference: Array<{ model: string; calls: number; tokensPerSecond: number | null; durationMs: Summary }>
    warmups: Array<{ model: string; reason: string; loadMs?: number; skipped?: string; at: string }>
    firstTokenMs?: Summary
  }
  orchestrator: { cliStatusMs: Array<{ id: string; ms: number }>; cliDetectMs: Array<{ id: string; ms: number }>; premiumCallMs: Array<{ key: string } & Summary>; firstOutputMs?: Array<{ orchestrator: string; kind: 'token' | 'event' } & Summary> }
  queue: Array<{ type: string; waitMs: Summary; runMs: Summary }>
  validation: Array<{ kind: string } & Summary>
  caches: { repoIndex: { hits: number; incremental: number; full: number; lastMs: number; lastMode?: string; hitRatio: number | null }; orchestratorStatus: { hits: number; misses: number; hitRatio: number | null }; cliDetection: { hits: number; misses: number } }
  requests: Array<{ route: string } & Summary>
  slowOperations: Array<{ method: string; route: string; status: number; ms: number; at: string }>
}

const ms = (value: number | null | undefined) => (value === null || value === undefined ? '–' : formatDuration(Math.round(value)))

function percentile(values: number[], q: number) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!
}

/** Renderer-side measurements: API round trips, long tasks and the startup marks. */
function rendererMetrics() {
  const routes = new Map<string, number[]>()
  for (const timing of apiTimings) routes.set(`${timing.method} ${timing.route}`, [...(routes.get(`${timing.method} ${timing.route}`) ?? []), timing.ms])
  const marks = Object.fromEntries(performance.getEntriesByType('mark').filter((mark) => mark.name.startsWith('mac:')).map((mark) => [mark.name.slice(4), Math.round(mark.startTime)]))
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  return {
    startupMarksMs: marks,
    longTasks: longTasks.slice(-20),
    heapMb: memory ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : null,
    apiRoundTrips: [...routes.entries()].map(([route, values]) => ({ route, n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) })).sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0)).slice(0, 15),
  }
}

const longTasks: Array<{ ms: number; at: number }> = []
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTasks.push({ ms: Math.round(entry.duration), at: Math.round(entry.startTime) })
      if (longTasks.length > 200) longTasks.shift()
    }
  }).observe({ type: 'longtask', buffered: true })
} catch {
  // long task API unavailable
}

/** Performance dashboard (measured values only; refreshes every 5 s while visible). */
export function DiagnosticsPanel() {
  const visible = useIsVisible()
  const [data, setData] = useState<Diagnostics>()
  const [processes, setProcesses] = useState<Awaited<ReturnType<NonNullable<typeof window.mac>["app"]["metrics"]>>>([])
  const [renderer, setRenderer] = useState(rendererMetrics())
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [snapshot, metrics] = await Promise.all([api.get<Diagnostics>('/system/diagnostics'), bridge().app.metrics()])
      setData(snapshot)
      setProcesses(metrics)
      setRenderer(rendererMetrics())
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!visible) return
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const exportReport = async () => {
    const info = await bridge().app.info()
    const report = { exportedAt: new Date().toISOString(), app: { version: info.version, electron: info.electron, platform: info.platform, arch: info.arch, packaged: info.packaged }, runtime: data, processes, renderer: rendererMetrics() }
    const saved = await bridge().dialog.saveText(`multi-ai-coder-diagnose-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, JSON.stringify(report, null, 2))
    if (saved) notify(`Diagnosebericht gespeichert: ${saved}`, 'success')
  }

  return (
    <>
      <PanelHeader title="Diagnose & Performance">
        <button className="icon-btn" title="Diagnosebericht exportieren (ohne Secrets)" onClick={() => void exportReport()}>
          <Download size={14} />
        </button>
        <button className="icon-btn" title="Aktualisieren" onClick={() => void load()}>
          {loading ? <Spinner /> : <RefreshCw size={14} />}
        </button>
      </PanelHeader>
      <div className="panel-body stack">
        {!data ? <Spinner /> : (
          <>
            <div className="card stack">
              <strong>System</strong>
              <div className="kv">
                <span>CPU</span>
                <span>{data.system.cpuLoadPercent} % · {data.system.cpuModel} ({data.system.logicalCores} Threads)</span>
                <span>Arbeitsspeicher</span>
                <span>{Math.round((data.system.memoryTotalMb - data.system.memoryFreeMb) / 1024 * 10) / 10} / {Math.round(data.system.memoryTotalMb / 1024 * 10) / 10} GB belegt</span>
                {(data.gpu ?? []).map((gpu) => (
                  <span key={gpu.name} style={{ display: 'contents' }}>
                    <span>GPU</span>
                    <span>{gpu.name} · {gpu.utilizationPercent} % · VRAM {Math.round(gpu.vramUsedMb / 1024 * 10) / 10} / {Math.round(gpu.vramTotalMb / 1024 * 10) / 10} GB · {gpu.temperatureC} °C</span>
                  </span>
                ))}
                {!data.gpu ? <><span>GPU</span><span className="faint">keine NVIDIA-Messung verfügbar</span></> : null}
              </div>
            </div>
            <div className="card stack">
              <strong>Prozesse</strong>
              <table className="table">
                <thead><tr><th>Prozess</th><th>CPU</th><th>Speicher</th></tr></thead>
                <tbody>
                  {processes.map((entry) => (
                    <tr key={entry.pid}><td>{entry.name ?? entry.type}</td><td>{entry.cpuPercent} %</td><td>{entry.workingSetMb} MB</td></tr>
                  ))}
                  <tr><td>Laufzeit (Heap)</td><td>–</td><td>{data.runtime.heapUsedMb} MB · läuft seit {formatDuration(data.runtime.uptimeSec * 1000)}</td></tr>
                </tbody>
              </table>
            </div>
            <div className="card stack">
              <strong>Lokale Modelle</strong>
              {data.models.loaded.length ? data.models.loaded.map((model) => (
                <div key={model.name} className="row"><span className="mono">{model.name}</span><Badge kind="accent">geladen · {model.vramMb} MB VRAM</Badge><span className="faint">bis {new Date(model.expiresAt).toLocaleTimeString()}</span></div>
              )) : <span className="faint">Kein Modell geladen.</span>}
              <table className="table">
                <thead><tr><th>Modell</th><th>Aufrufe (7 T.)</th><th>Tokens/s</th><th>Dauer p50 / p95</th></tr></thead>
                <tbody>
                  {data.models.inference.map((entry) => (
                    <tr key={entry.model}><td className="mono">{entry.model}</td><td>{entry.calls}</td><td>{entry.tokensPerSecond ? Math.round(entry.tokensPerSecond * 10) / 10 : '–'}</td><td>{ms(entry.durationMs.p50)} / {ms(entry.durationMs.p95)}</td></tr>
                  ))}
                </tbody>
              </table>
              {data.models.warmups.length ? (
                <div className="faint" style={{ fontSize: 12 }}>
                  Vorwärmen: {data.models.warmups.map((entry) => `${entry.model} ${entry.skipped ? `übersprungen (${entry.skipped})` : `${ms(entry.loadMs)}`} [${entry.reason}]`).join(' · ')}
                </div>
              ) : null}
            </div>
            <div className="card stack">
              <strong>Orchestrator & Warteschlange</strong>
              <div className="kv">
                <span>CLI-Status (Prozess)</span>
                <span>{data.orchestrator.cliStatusMs.map((entry) => `${entry.id} ${entry.ms} ms`).join(' · ') || '–'}</span>
                <span>Erster Token (TTFT)</span>
                <span data-testid="ttft">{[
                  data.models.firstTokenMs?.n ? `lokal p50 ${ms(data.models.firstTokenMs.p50)} · p95 ${ms(data.models.firstTokenMs.p95)} (${data.models.firstTokenMs.n})` : '',
                  ...(data.orchestrator.firstOutputMs ?? []).map((entry) => `${entry.orchestrator} ${entry.kind === 'token' ? 'erster Token' : 'erste Ausgabe'} p50 ${ms(entry.p50)} · p95 ${ms(entry.p95)} (${entry.n})`),
                ].filter(Boolean).join(' · ') || '– (noch kein Modellaufruf)'}</span>
                <span>CLI-Erkennung</span>
                <span>{data.orchestrator.cliDetectMs.map((entry) => `${entry.id} ${entry.ms} ms`).join(' · ') || '–'}</span>
                {data.orchestrator.premiumCallMs.map((entry) => (
                  <span key={entry.key} style={{ display: 'contents' }}><span>Premium {entry.key}</span><span>{entry.n} × · p50 {ms(entry.p50)} · p95 {ms(entry.p95)}</span></span>
                ))}
                {data.queue.map((entry) => (
                  <span key={entry.type} style={{ display: 'contents' }}><span>Job {entry.type}</span><span>Wartezeit p50 {ms(entry.waitMs.p50)} / p95 {ms(entry.waitMs.p95)} · Laufzeit p50 {ms(entry.runMs.p50)}</span></span>
                ))}
                {data.validation.map((entry) => (
                  <span key={entry.kind} style={{ display: 'contents' }}><span>Validierung {entry.kind}</span><span>{entry.n} × · p50 {ms(entry.p50)} · p95 {ms(entry.p95)}</span></span>
                ))}
              </div>
            </div>
            <div className="card stack">
              <strong>Caches</strong>
              <div className="kv">
                <span>Repository-Index</span>
                <span>Trefferquote {data.caches.repoIndex.hitRatio ?? '–'} · {data.caches.repoIndex.hits} ohne I/O, {data.caches.repoIndex.incremental} inkrementell, {data.caches.repoIndex.full} Vollscans · zuletzt {data.caches.repoIndex.lastMode ?? '–'} {data.caches.repoIndex.lastMs} ms</span>
                <span>Orchestrator-Status</span>
                <span>Trefferquote {data.caches.orchestratorStatus.hitRatio ?? '–'} ({data.caches.orchestratorStatus.hits} / {data.caches.orchestratorStatus.misses} Prozessaufrufe)</span>
                <span>CLI-Erkennung</span>
                <span>{data.caches.cliDetection.hits} Treffer / {data.caches.cliDetection.misses} Prozessaufrufe</span>
              </div>
            </div>
            <div className="card stack">
              <strong>Oberfläche</strong>
              <div className="kv">
                <span>Start (ms seit Seitenstart)</span>
                <span className="mono" style={{ fontSize: 11 }}>{Object.entries(renderer.startupMarksMs).map(([name, value]) => `${name} ${value}`).join(' · ')}</span>
                <span>Lange Tasks (&gt; 50 ms)</span>
                <span>{renderer.longTasks.length ? renderer.longTasks.slice(-8).map((task) => `${task.ms} ms`).join(', ') : 'keine'}</span>
                <span>Renderer-Heap</span>
                <span>{renderer.heapMb ?? '–'} MB</span>
              </div>
              <table className="table">
                <thead><tr><th>API (Renderer → Laufzeit)</th><th>n</th><th>p50</th><th>p95</th></tr></thead>
                <tbody>
                  {renderer.apiRoundTrips.map((entry) => <tr key={entry.route}><td className="mono" style={{ fontSize: 11 }}>{entry.route}</td><td>{entry.n}</td><td>{ms(entry.p50)}</td><td>{ms(entry.p95)}</td></tr>)}
                </tbody>
              </table>
            </div>
            <div className="card stack">
              <strong>Langsame Operationen (≥ 200 ms in der Laufzeit)</strong>
              {data.slowOperations.length ? data.slowOperations.map((entry, index) => (
                <div key={index} className="row" style={{ fontSize: 12 }}><span className="mono">{entry.method} {entry.route}</span><span className="spacer" /><span>{ms(entry.ms)}</span><span className="faint">{new Date(entry.at).toLocaleTimeString()}</span></div>
              )) : <span className="faint">Keine.</span>}
            </div>
          </>
        )}
      </div>
    </>
  )
}
