import { useState } from 'react'
import { Download, Play, Power, RefreshCw, Square, TestTube2, Trash2 } from 'lucide-react'
import { api, bridge, enc, errorMessage } from '../../lib/api'
import { loadSettings } from '../../lib/actions'
import { formatBytes, useAppEvents, useLoader } from '../../lib/hooks'
import { useJobsState } from '../../lib/store'
import { jobsStore } from '../../lib/stores'
import { useApp } from '../../lib/store'
import type { HardwareProfile, InstalledModel, LocalRole, ModelRecommendation, OllamaStatus } from '../../lib/types'
import { AsyncButton, Badge, Confirm, Spinner, StatusDot } from '../common'

const ROLE_LABEL: Record<LocalRole, string> = { fast: 'Fast', balanced: 'Balanced', advanced: 'Advanced' }

export function HardwareSummary({ hardware }: { hardware?: HardwareProfile }) {
  if (!hardware) return <div className="row"><Spinner /> Analysiere Hardware …</div>
  const disk = hardware.disks.ollamaModels
  return (
    <div className="stack">
      <div className="kv">
        <span>Betriebssystem</span>
        <span>{hardware.os.platform} {hardware.os.release} ({hardware.os.arch})</span>
        <span>CPU</span>
        <span>{hardware.cpu.model} · {hardware.cpu.physicalCores ?? '?'} Kerne / {hardware.cpu.logicalCores} Threads</span>
        <span>Arbeitsspeicher</span>
        <span>{formatBytes(hardware.memory.totalBytes)} (frei {formatBytes(hardware.memory.freeBytes)})</span>
        {hardware.gpus.map((gpu, index) => (
          <span key={`gpu-${index}`} style={{ display: 'contents' }}>
            <span>GPU {hardware.gpus.length > 1 ? index + 1 : ''}</span>
            <span>
              {gpu.name} · VRAM {gpu.vramTotalMb ? formatBytes(gpu.vramTotalMb * 1024 * 1024) : 'unbekannt'}
              {gpu.vramUsedMb ? ` (belegt ${formatBytes(gpu.vramUsedMb * 1024 * 1024)})` : ''} <span className="faint">[{gpu.vramReliable ? gpu.vramSource : `unzuverlässig: ${gpu.vramSource}`}]</span>
            </span>
          </span>
        ))}
        <span>Beschleunigung</span>
        <span>{hardware.acceleration.join(', ')}</span>
        <span>Modellspeicher</span>
        <span>
          <code>{hardware.ollamaModelsDir}</code> · frei {formatBytes(disk?.freeBytes)}
        </span>
      </div>
      {hardware.warnings.map((warning, index) => (
        <div key={index} className="callout warn">
          {warning}
        </div>
      ))}
    </div>
  )
}

export function LocalModelManager({ compact = false }: { compact?: boolean }) {
  const { notify, settings, updateSettings } = useApp()
  const ollama = useLoader(() => api.get<OllamaStatus>('/local-models/ollama'), [])
  const recs = useLoader(() => api.get<{ hardware: HardwareProfile; recommendations: ModelRecommendation[]; registryCheckedAt?: string; note: string }>('/local-models/recommendations'), [settings?.ollamaModelsDir])
  const installed = useLoader(() => (ollama.data?.reachable ? api.get<InstalledModel[]>('/local-models/installed') : Promise.resolve([] as InstalledModel[])), [ollama.data?.reachable])
  // Download progress lives in the runtime job queue (jobsStore), not in this view: it survives navigation.
  const progress = useJobsState((state) => state.pulls)
  const installLog = useJobsState((state) => state.installLog)
  const [confirmPull, setConfirmPull] = useState<ModelRecommendation | { model: string; downloadBytes?: number }>()
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [custom, setCustom] = useState('')
  const [testing, setTesting] = useState<string>()

  useAppEvents((event) => {
    if (event.channel !== 'models') return
    const data = event.data as Record<string, unknown>
    if (event.type === 'pull_finished') {
      void installed.reload()
      void recs.reload()
    }
    if (event.type === 'install_finished') void ollama.reload()
  })

  const status = ollama.data
  const hardware = recs.data?.hardware
  const assign = async (role: LocalRole, model: string | null) => {
    try {
      await api.put('/local-models/roles', { [role]: model })
      await loadSettings()
      await installed.reload()
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }

  return (
    <div className="stack">
      {/* Ollama runtime */}
      <div className="card stack">
        <div className="row">
          <strong>Ollama</strong>
          <StatusDot status={status?.reachable ? 'ok' : status?.installed ? 'warn' : 'error'} />
          <span className="muted">{!status ? 'prüfe …' : status.reachable ? `läuft (v${status.serverVersion}) auf ${status.baseUrl}` : status.installed ? `installiert (v${status.version ?? '?'}), nicht gestartet` : 'nicht installiert'}</span>
          <span className="spacer" />
          <button className="icon-btn" title="Neu prüfen" onClick={() => void ollama.reload()}>
            <RefreshCw size={14} />
          </button>
        </div>
        {status?.installed && !status.reachable ? (
          <AsyncButton className="btn primary" onClick={async () => { const result = await api.post<{ started: boolean; message: string }>('/local-models/ollama/start'); notify(result.message, result.started ? 'success' : 'info'); await ollama.reload() }}>
            <Power size={14} /> Ollama starten
          </AsyncButton>
        ) : null}
        {status && !status.installed && status.installPlan ? (
          <div className="stack">
            <div className="muted">{status.installPlan.explanation}</div>
            {status.installPlan.command ? (
              <button className="btn primary" onClick={() => setConfirmInstall(true)}>
                <Download size={14} /> Ollama installieren ({status.installPlan.method})
              </button>
            ) : status.installPlan.manualCommand ? (
              <pre className="pre">{status.installPlan.manualCommand}</pre>
            ) : null}
            <button className="btn ghost" onClick={() => void bridge().shell.openExternal(status.installPlan!.downloadUrl)}>
              Download-Seite öffnen
            </button>
            {installLog.length ? <pre className="pre">{installLog.join('\n')}</pre> : null}
          </div>
        ) : null}
        <details>
          <summary className="muted">Modellspeicher & Verbindung</summary>
          <div className="stack" style={{ marginTop: 6 }}>
            <label className="stack" style={{ gap: 3 }}>
              <span className="muted">Modellordner (wird gesetzt, wenn Multi-AI Coder Ollama selbst startet)</span>
              <div className="row">
                <input className="input" value={settings?.ollamaModelsDir ?? ''} placeholder={hardware?.ollamaModelsDir ?? 'Ollama-Standard'} readOnly />
                <button className="btn" onClick={async () => { const folder = await bridge().dialog.openFolder('Ordner für Modelle wählen'); if (folder) await updateSettings({ ollamaModelsDir: folder }) }}>
                  Wählen …
                </button>
                {settings?.ollamaModelsDir ? <button className="btn ghost" onClick={() => void updateSettings({ ollamaModelsDir: null })}>Standard</button> : null}
              </div>
            </label>
            <label className="stack" style={{ gap: 3 }}>
              <span className="muted">Ollama-Adresse (nur lokal). Ein eigener Port (z. B. 11435) startet eine separate Instanz mit obigem Modellordner, ohne deine bestehende Ollama-Installation zu verändern.</span>
              <input className="input" defaultValue={settings?.ollamaBaseUrl} onBlur={(event) => event.target.value !== settings?.ollamaBaseUrl && void updateSettings({ ollamaBaseUrl: event.target.value }).then(() => ollama.reload())} />
            </label>
          </div>
        </details>
      </div>

      {!compact ? (
        <div className="card">
          <div className="section-title" style={{ marginBottom: 6 }}>Hardware</div>
          <HardwareSummary hardware={hardware} />
        </div>
      ) : null}

      {/* Installed */}
      {status?.reachable ? (
        <div className="card stack">
          <div className="row">
            <strong>Installierte Modelle</strong>
            <span className="spacer" />
            <button className="icon-btn" onClick={() => void installed.reload()} title="Aktualisieren">
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="row wrap">
            {(['fast', 'balanced', 'advanced'] as LocalRole[]).map((role) => (
              <label key={role} className="stack" style={{ gap: 2, minWidth: 150, flex: 1 }}>
                <span className="muted" style={{ fontSize: 11.5 }}>Rolle „{ROLE_LABEL[role]}“</span>
                <select className="select" value={settings?.modelRoles[role] ?? ''} onChange={(event) => void assign(role, event.target.value || null)}>
                  <option value="">– keine –</option>
                  {installed.data?.map((model) => (
                    <option key={model.name} value={model.name}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {!installed.data?.length ? <div className="faint">Noch keine Modelle installiert.</div> : null}
          {installed.data?.map((model) => (
            <div key={model.name} className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 6, gap: 4 }}>
              <div className="row wrap">
                <strong className="mono">{model.name}</strong>
                <span className="faint">{formatBytes(model.sizeBytes)} · {model.parameterSize} {model.quantization}</span>
                {model.roles.map((role) => <Badge key={role} kind="local">{ROLE_LABEL[role]}</Badge>)}
                {model.capabilities.includes('tools') ? <Badge kind={model.selfTest?.toolCalling === 'failed' ? 'error' : model.selfTest?.toolCalling === 'verified' ? 'ok' : model.selfTest?.toolCalling === 'text_format' ? 'warn' : undefined}>Tools {model.selfTest?.toolCalling === 'verified' ? '✓ getestet' : model.selfTest?.toolCalling === 'text_format' ? '✓ als Text (wird erkannt)' : model.selfTest?.toolCalling === 'failed' ? '✗ Test fehlgeschlagen' : '(Template)'}</Badge> : <Badge>JSON-Patch-Modus</Badge>}
                {model.loaded ? <Badge kind="accent">geladen {model.vramBytes ? `· ${formatBytes(model.vramBytes)} VRAM` : ''}</Badge> : null}
                <span className="spacer" />
                {model.loaded ? (
                  <AsyncButton className="icon-btn" title="Entladen (Stop)" onClick={async () => { await api.post(`/local-models/${enc(model.name)}/unload`); await installed.reload() }}>
                    <Square size={13} />
                  </AsyncButton>
                ) : (
                  <AsyncButton className="icon-btn" title="Laden (Start)" onClick={async () => { await api.post(`/local-models/${enc(model.name)}/load`); await installed.reload() }}>
                    <Play size={13} />
                  </AsyncButton>
                )}
                <button
                  className="icon-btn"
                  title="Inferenz-Selbsttest (echter Aufruf)"
                  disabled={testing === model.name}
                  onClick={async () => {
                    setTesting(model.name)
                    try {
                      const result = await api.post<{ ok: boolean; tokensPerSecond?: number; error?: string }>(`/local-models/${enc(model.name)}/self-test`)
                      notify(result.ok ? `${model.name}: Selbsttest ok (${result.tokensPerSecond ?? '?'} Token/s)` : `${model.name}: ${result.error ?? 'Selbsttest fehlgeschlagen'}`, result.ok ? 'success' : 'error')
                      await installed.reload()
                    } catch (error) {
                      notify(errorMessage(error), 'error')
                    } finally {
                      setTesting(undefined)
                    }
                  }}
                >
                  {testing === model.name ? <Spinner /> : <TestTube2 size={14} />}
                </button>
                <button className="icon-btn" title="Deinstallieren" onClick={() => setConfirmDelete(model.name)}>
                  <Trash2 size={14} />
                </button>
              </div>
              {model.selfTest ? (
                <div className="faint" style={{ fontSize: 11.5 }}>
                  Selbsttest {new Date(model.selfTest.at).toLocaleString()}: {model.selfTest.ok ? 'ok' : 'fehlgeschlagen'}
                  {model.selfTest.tokensPerSecond ? ` · ${model.selfTest.tokensPerSecond} Token/s` : ''}
                  {model.selfTest.loadMs ? ` · Laden ${(model.selfTest.loadMs / 1000).toFixed(1)} s` : ''}
                  {model.selfTest.structuredOutput ? ' · strukturierte Ausgabe ok' : ''}
                  {model.selfTest.error ? ` · ${model.selfTest.error}` : ''}
                </div>
              ) : null}
              {progress[model.name] && progress[model.name]!.percent !== 100 ? <PullProgress value={progress[model.name]!} /> : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* Recommendations */}
      <div className="card stack">
        <div className="row">
          <strong>Empfohlene Coding-Modelle</strong>
          <span className="spacer" />
          <button className="icon-btn" title="Registry neu abfragen" onClick={() => void recs.reload()}>
            {recs.loading ? <Spinner /> : <RefreshCw size={14} />}
          </button>
        </div>
        <div className="faint" style={{ fontSize: 12 }}>{recs.data?.note} {recs.data?.registryCheckedAt ? `Stand der Registry-Abfrage: ${new Date(recs.data.registryCheckedAt).toLocaleString()}.` : ''}</div>
        {recs.error ? <div className="callout error">{recs.error}</div> : null}
        <table className="table">
          <thead>
            <tr>
              <th>Modell</th>
              <th>Download</th>
              <th>Passt auf</th>
              <th>Tools</th>
              <th>Rollen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {recs.data?.recommendations
              .filter((rec) => !compact || rec.recommended || rec.fit === 'gpu')
              .map((rec) => {
                const isInstalled = installed.data?.some((model) => model.name === rec.model)
                const pull = progress[rec.model]
                return (
                  <tr key={rec.model}>
                    <td>
                      <div className="mono">{rec.model}</div>
                      <div className="faint" style={{ fontSize: 11 }} title={rec.notes}>{rec.family} · {rec.license}</div>
                    </td>
                    <td>{formatBytes(rec.downloadBytes)}</td>
                    <td title={rec.fitExplanation}>
                      <Badge kind={rec.fit === 'gpu' ? 'ok' : rec.fit === 'too_large' ? 'error' : 'warn'}>{{ gpu: 'GPU', partial_offload: 'GPU+RAM', cpu: 'CPU', too_large: 'zu groß' }[rec.fit]}</Badge>
                      {!rec.diskOk ? <div className="error-text" style={{ fontSize: 11 }}>zu wenig Speicherplatz</div> : null}
                    </td>
                    <td>{{ verified: 'geprüft', template: 'laut Template', unknown: 'unbekannt', none: 'nein' }[rec.toolCalling]}</td>
                    <td>{rec.roles.map((role) => <Badge key={role} kind="accent">{ROLE_LABEL[role]}</Badge>)}</td>
                    <td>
                      {isInstalled ? (
                        <Badge kind="ok">installiert</Badge>
                      ) : pull && pull.percent !== 100 ? (
                        <PullProgress value={pull} />
                      ) : (
                        <button className="btn small" disabled={!status?.reachable && !status?.installed} onClick={() => setConfirmPull(rec)}>
                          <Download size={12} /> Laden
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
        <div className="row">
          <input className="input" placeholder="Anderes Ollama-Modell, z. B. qwen3-coder:30b" value={custom} onChange={(event) => setCustom(event.target.value)} />
          <button className="btn" disabled={!custom.trim()} onClick={() => setConfirmPull({ model: custom.trim() })}>
            Laden …
          </button>
        </div>
      </div>

      {confirmPull ? (
        <Confirm
          title={`Modell ${confirmPull.model} herunterladen?`}
          confirmLabel="Download starten"
          onCancel={() => setConfirmPull(undefined)}
          onConfirm={async () => {
            const target = confirmPull
            setConfirmPull(undefined)
            try {
              await api.post('/local-models/pull', { model: target.model, consent: true })
              jobsStore.set((state) => ({ pulls: { ...state.pulls, [target.model]: { status: 'gestartet' } } }))
            } catch (error) {
              notify(errorMessage(error), 'error')
            }
          }}
        >
          <div className="stack">
            <div>
              Größe: <strong>{confirmPull.downloadBytes ? formatBytes(confirmPull.downloadBytes) : 'wird von der Registry ermittelt'}</strong>
            </div>
            <div>
              Ziel: <code>{hardware?.ollamaModelsDir}</code> (frei: {formatBytes(hardware?.disks.ollamaModels?.freeBytes)})
            </div>
            <div className="faint">Der Download läuft im Hintergrund, kann pausieren und wird nach Unterbrechungen fortgesetzt.</div>
          </div>
        </Confirm>
      ) : null}
      {confirmInstall && status?.installPlan?.command ? (
        <Confirm
          title="Ollama installieren?"
          confirmLabel="Installation starten"
          onCancel={() => setConfirmInstall(false)}
          onConfirm={async () => {
            setConfirmInstall(false)
            try {
              await api.post('/local-models/ollama/install', { consent: true })
              jobsStore.set({ installLog: ['Installation gestartet …'] })
            } catch (error) {
              notify(errorMessage(error), 'error')
            }
          }}
        >
          <div className="stack">
            <div>{status.installPlan.explanation}</div>
            <code>{status.installPlan.command.join(' ')}</code>
          </div>
        </Confirm>
      ) : null}
      {confirmDelete ? (
        <Confirm
          title={`${confirmDelete} deinstallieren?`}
          danger
          confirmLabel="Deinstallieren"
          onCancel={() => setConfirmDelete(undefined)}
          onConfirm={async () => {
            const model = confirmDelete
            setConfirmDelete(undefined)
            try {
              await api.del(`/local-models/${enc(model)}`)
              await installed.reload()
              await loadSettings()
            } catch (error) {
              notify(errorMessage(error), 'error')
            }
          }}
        >
          Das Modell wird aus Ollama entfernt und aus allen Rollen ausgetragen.
        </Confirm>
      ) : null}
    </div>
  )
}

function PullProgress({ value }: { value: { percent?: number; status: string } }) {
  return (
    <div className="stack" style={{ gap: 2, minWidth: 120 }}>
      <div className="progress">
        <div style={{ width: `${value.percent ?? 2}%` }} />
      </div>
      <span className="faint" style={{ fontSize: 11 }}>
        {value.status} {value.percent !== undefined ? `${value.percent}%` : ''}
      </span>
    </div>
  )
}
