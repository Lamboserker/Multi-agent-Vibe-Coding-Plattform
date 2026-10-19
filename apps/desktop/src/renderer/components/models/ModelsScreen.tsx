import { useMemo, useState } from 'react'
import { Brain, Cpu, Download, HardDrive, MemoryStick, Monitor, Play, Power, RefreshCw, Scale, Square, TestTube2, Trash2, Zap } from 'lucide-react'
import * as actions from '../../lib/actions'
import { api, bridge, enc, errorMessage } from '../../lib/api'
import { formatBytes, useAppEvents, useLoader } from '../../lib/hooks'
import { pct, resourceMetrics, useResourceMonitor, type ResourceMetric } from '../../lib/resources'
import { useApp, useJobsState } from '../../lib/store'
import { jobsStore } from '../../lib/stores'
import type { HardwareProfile, InstalledModel, LocalRole, ModelRecommendation, OllamaStatus, SuitabilityStats } from '../../lib/types'
import { AsyncButton, Confirm, Spinner } from '../common'
import { Bar, Chip, Dot, Eyebrow, ScreenHeader, StatTile } from '../ui'

const ROLES: Array<{ id: LocalRole; label: string; use: string; icon: typeof Zap }> = [
  { id: 'fast', label: 'Fast', use: 'kleine Edits', icon: Zap },
  { id: 'balanced', label: 'Balanced', use: 'Implementierung', icon: Scale },
  { id: 'advanced', label: 'Advanced', use: 'Tests, Refactoring', icon: Brain },
]
const FIT: Record<ModelRecommendation['fit'], { label: string; tone: 'ok' | 'tool' | 'err' }> = { gpu: { label: 'passt in VRAM', tone: 'ok' }, partial_offload: { label: 'teilweise CPU', tone: 'tool' }, cpu: { label: 'nur CPU', tone: 'tool' }, too_large: { label: 'zu groß', tone: 'err' } }

export function ModelsScreen() {
  const { settings, updateSettings, notify } = useApp()
  const snapshot = useResourceMonitor(3000)
  const ollama = useLoader(() => api.get<OllamaStatus>('/local-models/ollama'), [])
  const recs = useLoader(() => api.get<{ hardware: HardwareProfile; recommendations: ModelRecommendation[]; registryCheckedAt?: string; note: string }>('/local-models/recommendations'), [settings?.ollamaModelsDir])
  const installed = useLoader(() => (ollama.data?.reachable ? api.get<InstalledModel[]>('/local-models/installed') : Promise.resolve([] as InstalledModel[])), [ollama.data?.reachable])
  const stats = useLoader(() => api.get<SuitabilityStats[]>('/stats/models').catch(() => [] as SuitabilityStats[]), [])
  const pulls = useJobsState((state) => state.pulls)
  const installLog = useJobsState((state) => state.installLog)
  const [confirmPull, setConfirmPull] = useState<{ model: string; downloadBytes?: number }>()
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [testing, setTesting] = useState<string>()
  const [custom, setCustom] = useState('')

  useAppEvents((event) => {
    if (event.channel !== 'models') return
    if (event.type === 'pull_finished' || event.type === 'deleted' || event.type === 'loaded' || event.type === 'unloaded') {
      void installed.reload()
      if (event.type === 'pull_finished') void recs.reload()
    }
    if (event.type === 'install_finished') void ollama.reload()
  })

  const status = ollama.data
  const hardware = recs.data?.hardware
  const successByModel = useMemo(() => {
    const out: Record<string, { attempts: number; successes: number }> = {}
    for (const entry of stats.data ?? []) {
      const current = (out[entry.model] ??= { attempts: 0, successes: 0 })
      current.attempts += entry.attempts
      current.successes += entry.successes
    }
    return out
  }, [stats.data])
  const metrics = snapshot ? (Object.fromEntries(resourceMetrics(snapshot).map((metric) => [metric.id, metric])) as Record<ResourceMetric['id'], ResourceMetric>) : undefined
  const disk = snapshot?.disk ?? hardware?.disks.ollamaModels
  const usedBytes = (installed.data ?? []).reduce((sum, model) => sum + model.sizeBytes, 0)

  const assign = async (role: LocalRole, model: string | null) => {
    try {
      await api.put('/local-models/roles', { [role]: model })
      await actions.loadSettings()
      await installed.reload()
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }

  const selfTest = async (model: string) => {
    setTesting(model)
    try {
      const result = await api.post<{ ok: boolean; tokensPerSecond?: number; error?: string }>(`/local-models/${enc(model)}/self-test`)
      notify(result.ok ? `${model}: Selbsttest ok (${result.tokensPerSecond ?? '?'} Token/s)` : `${model}: ${result.error ?? 'Selbsttest fehlgeschlagen'}`, result.ok ? 'success' : 'error')
      await Promise.all([installed.reload(), actions.loadSettings()])
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setTesting(undefined)
    }
  }

  return (
    <div className="screen-scroll">
      <div className="screen-inner">
        <ScreenHeader title="Lokale Modelle" subtitle="Ollama führt die Implementierung aus. Jede Rolle bekommt ein Modell; der Router lernt, welches Modell welche Aufgabe zuverlässig löst.">
          <span className="pill">
            <Dot tone={status?.reachable ? 'ok' : status?.installed ? 'tool' : 'err'} />
            {!status ? 'prüfe …' : status.reachable ? `Ollama v${status.serverVersion} · ${status.baseUrl.replace(/^https?:\/\//, '')}` : status.installed ? 'Ollama nicht gestartet' : 'Ollama nicht installiert'}
          </span>
          <button className="hdr-icon" title="Neu prüfen" aria-label="Neu prüfen" onClick={() => { void ollama.reload(); void recs.reload(); void installed.reload() }}>
            <RefreshCw size={14} />
          </button>
        </ScreenHeader>

        {status && !status.reachable ? (
          <div className="side-card" style={{ borderColor: 'var(--tool)' }}>
            {status.installed ? (
              <div className="row" style={{ gap: 10 }}>
                <span style={{ flex: 1 }}>Ollama ist installiert (v{status.version ?? '?'}), läuft aber nicht.</span>
                <AsyncButton className="btn primary" onClick={async () => { const result = await api.post<{ started: boolean; message: string }>('/local-models/ollama/start'); notify(result.message, result.started ? 'success' : 'info'); await ollama.reload() }}>
                  <Power size={14} /> Ollama starten
                </AsyncButton>
              </div>
            ) : status.installPlan ? (
              <div className="stack">
                <div className="muted">{status.installPlan.explanation}</div>
                <div className="row wrap">
                  {status.installPlan.command ? <button className="btn primary" onClick={() => setConfirmInstall(true)}><Download size={14} /> Ollama installieren ({status.installPlan.method})</button> : null}
                  <button className="btn" onClick={() => void bridge().shell.openExternal(status.installPlan!.downloadUrl)}>Download-Seite öffnen</button>
                </div>
                {status.installPlan.manualCommand ? <pre className="pre">{status.installPlan.manualCommand}</pre> : null}
                {installLog.length ? <pre className="pre">{installLog.join('\n')}</pre> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="grid-4">
          <StatTile icon={Cpu} label="CPU" value={(hardware?.cpu.model ?? snapshot?.cpu.model)?.replace(/\s+\d+-Core Processor/i, '') ?? '–'} detail={`${metrics?.cpu.pct ?? '–'} % · ${hardware?.cpu.physicalCores ?? snapshot?.cpu.physicalCores ?? '?'} Kerne / ${hardware?.cpu.logicalCores ?? snapshot?.cpu.logicalCores ?? '?'} Threads`}>
            <Bar value={metrics?.cpu.pct} tone={metrics?.cpu.tone ?? 'muted'} />
          </StatTile>
          <StatTile icon={MemoryStick} label="RAM" value={formatBytes(hardware?.memory.totalBytes ?? snapshot?.ram.totalBytes)} detail={metrics ? `${metrics.ram.value} belegt` : '–'}>
            <Bar value={metrics?.ram.pct} tone={metrics?.ram.tone ?? 'muted'} />
          </StatTile>
          <StatTile icon={Monitor} label="GPU" value={snapshot?.gpu?.name.replace(/^NVIDIA (GeForce )?/, '') ?? hardware?.gpus[0]?.name ?? 'keine'} detail={metrics ? `VRAM ${metrics.vram.value} · Last ${metrics.gpu.pct === undefined ? '–' : `${metrics.gpu.pct} %`}` : '–'}>
            <Bar value={metrics?.vram.pct} tone={metrics?.vram.tone ?? 'local'} />
          </StatTile>
          <StatTile icon={HardDrive} label="Modellspeicher" value={disk?.freeBytes !== undefined ? `${formatBytes(disk.freeBytes)} frei` : '–'} detail={<span className="mono">{hardware?.ollamaModelsDir ?? disk?.path ?? ''}</span>}>
            <Bar value={pct(disk?.totalBytes && disk.freeBytes !== undefined ? disk.totalBytes - disk.freeBytes : undefined, disk?.totalBytes)} tone="muted" />
          </StatTile>
        </div>

        <div className="grid-3">
          {ROLES.map((role) => {
            const model = settings?.modelRoles[role.id] ?? null
            const test = model ? settings?.modelSelfTests[model] : undefined
            const success = model ? successByModel[model] : undefined
            return (
              <div key={role.id} className="side-card">
                <div className="row" style={{ gap: 8 }}>
                  <span className="kind-icon" style={{ width: 26, height: 26, background: 'var(--local-soft)', color: 'var(--local)' }}><role.icon size={14} /></span>
                  <strong>{role.label}</strong>
                  <span className="spacer" />
                  <span className="faint" style={{ fontSize: 11.5 }}>{role.use}</span>
                </div>
                <select className="select mono" aria-label={`Modell für ${role.label}`} value={model ?? ''} disabled={!installed.data?.length} onChange={(event) => void assign(role.id, event.target.value || null)}>
                  <option value="">– keine –</option>
                  {installed.data?.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
                </select>
                <div className="row faint" style={{ gap: 10, fontSize: 11.5 }}>
                  <span>{test?.tokensPerSecond ? `~${test.tokensPerSecond} Tok./s` : test ? (test.ok ? 'Selbsttest ok' : 'Selbsttest fehlgeschlagen') : 'kein Selbsttest'}</span>
                  <span>·</span>
                  <span>{success?.attempts ? `Erfolg ${Math.round((success.successes / success.attempts) * 100)} % (${success.attempts})` : 'noch keine Läufe'}</span>
                </div>
              </div>
            )
          })}
        </div>

        <div className="table-card">
          <div className="table-card-head">
            <strong>Installiert</strong>
            <span className="spacer" />
            <span className="faint" style={{ fontSize: 12 }}>{formatBytes(usedBytes)} belegt{disk?.freeBytes !== undefined ? ` · ${formatBytes(disk.freeBytes)} frei` : ''}</span>
          </div>
          {!status?.reachable ? <div className="faint table-empty">Ollama läuft nicht – installierte Modelle sind erst danach sichtbar.</div> : installed.loading && !installed.data ? <div className="table-empty"><Spinner /></div> : !installed.data?.length ? <div className="faint table-empty">Noch keine Modelle installiert. Unten gibt es Empfehlungen für deine Hardware.</div> : null}
          {installed.data?.map((model) => {
            const loaded = snapshot?.models.find((entry) => entry.name === model.name)
            return (
              <div key={model.name} className="model-row">
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span className="mono truncate" style={{ fontSize: 12.5 }}>{model.name}</span>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {model.capabilities.includes('tools') ? (model.selfTest?.toolCalling === 'verified' ? 'Tools geprüft' : model.selfTest?.toolCalling === 'text_format' ? 'Tools als Text (wird erkannt)' : model.selfTest?.toolCalling === 'failed' ? 'Tool-Test fehlgeschlagen → JSON-Patch-Modus' : 'Tools laut Template') : 'JSON-Patch-Modus'}
                    {loaded ? ` · geladen, ${Math.round(loaded.gpuShare * 100)} % GPU${loaded.agents.length ? ` · ${loaded.agents.join(', ')}` : ''}` : ''}
                  </span>
                </span>
                <span className="muted">{formatBytes(model.sizeBytes)}</span>
                <span className="mono faint" style={{ fontSize: 11 }}>{model.quantization ?? '–'}</span>
                <span className="row wrap" style={{ gap: 4 }}>{model.roles.length ? model.roles.map((role) => <Chip key={role} tone="local" mono={false}>{ROLES.find((entry) => entry.id === role)?.label}</Chip>) : <span className="faint" style={{ fontSize: 11.5 }}>keine Rolle</span>}</span>
                <span className="row" style={{ gap: 4 }}>
                  {model.loaded || loaded ? (
                    <AsyncButton className="icon-square" title="Entladen" onClick={async () => { await api.post(`/local-models/${enc(model.name)}/unload`); await installed.reload() }}><Square size={12} /></AsyncButton>
                  ) : (
                    <AsyncButton className="icon-square" title="Laden" onClick={async () => { await api.post(`/local-models/${enc(model.name)}/load`); await installed.reload() }}><Play size={13} /></AsyncButton>
                  )}
                  <button className="icon-square" title="Inferenz-Selbsttest (echter Aufruf)" aria-label="Selbsttest" disabled={testing === model.name} onClick={() => void selfTest(model.name)}>{testing === model.name ? <Spinner /> : <TestTube2 size={13} />}</button>
                  <button className="icon-square" title="Deinstallieren" aria-label="Deinstallieren" onClick={() => setConfirmDelete(model.name)}><Trash2 size={13} /></button>
                </span>
              </div>
            )
          })}
        </div>

        <div className="stack" style={{ gap: 10 }}>
          <div className="row">
            <Eyebrow>Empfohlen für deine Hardware</Eyebrow>
            <span className="spacer" />
            <span className="faint" style={{ fontSize: 11.5 }}>{recs.data?.registryCheckedAt ? `Registry geprüft ${new Date(recs.data.registryCheckedAt).toLocaleDateString('de-DE')}` : ''}</span>
          </div>
          {recs.error ? <div className="callout error">{recs.error}</div> : null}
          <div className="grid-3">
            {(recs.data?.recommendations ?? []).filter((rec) => rec.fit !== 'too_large' && !installed.data?.some((model) => model.name === rec.model)).slice(0, 6).map((rec) => {
              const pull = pulls[rec.model]
              return (
                <div key={rec.model} className="side-card">
                  <div className="row" style={{ gap: 8 }}>
                    <span className="mono truncate" style={{ fontSize: 12.5, flex: 1 }}>{rec.model}</span>
                    <span style={{ fontSize: 11, color: `var(--${FIT[rec.fit].tone})` }} title={rec.fitExplanation}>{FIT[rec.fit].label}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, textWrap: 'pretty' }}>{rec.notes}</div>
                  <div className="faint" style={{ fontSize: 11 }}>{rec.family} · {rec.license}{rec.roles.length ? ` · ${rec.roles.map((role) => ROLES.find((entry) => entry.id === role)?.label).join(', ')}` : ''}</div>
                  {pull && pull.percent !== 100 ? (
                    <div className="stack" style={{ gap: 4 }}>
                      <Bar value={pull.percent ?? 2} tone="local" height={5} />
                      <div className="row mono faint" style={{ fontSize: 10.5, justifyContent: 'space-between' }}><span>{pull.percent ?? 0} % von {formatBytes(rec.downloadBytes)}</span><span>{pull.status}</span></div>
                    </div>
                  ) : (
                    <button className="btn" style={{ justifyContent: 'center' }} disabled={!rec.diskOk || (!status?.reachable && !status?.installed)} title={rec.diskOk ? undefined : 'Zu wenig Speicherplatz'} onClick={() => setConfirmPull({ model: rec.model, downloadBytes: rec.downloadBytes })}>
                      <Download size={13} /> Laden · {formatBytes(rec.downloadBytes)}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="row">
            <input className="input" placeholder="Anderes Ollama-Modell, z. B. qwen3-coder:30b" value={custom} onChange={(event) => setCustom(event.target.value)} />
            <button className="btn" disabled={!custom.trim()} onClick={() => setConfirmPull({ model: custom.trim() })}>Laden …</button>
          </div>
        </div>

        <details className="side-card">
          <summary className="muted">Modellspeicher & Verbindung</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <label className="stack" style={{ gap: 3 }}>
              <span className="muted">Modellordner (gilt, wenn Multi-AI Coder Ollama selbst startet)</span>
              <div className="row">
                <input className="input" value={settings?.ollamaModelsDir ?? ''} placeholder={hardware?.ollamaModelsDir ?? 'Ollama-Standard'} readOnly />
                <button className="btn" onClick={async () => { const folder = await bridge().dialog.openFolder('Ordner für Modelle wählen'); if (folder) await updateSettings({ ollamaModelsDir: folder }) }}>Wählen …</button>
                {settings?.ollamaModelsDir ? <button className="btn ghost" onClick={() => void updateSettings({ ollamaModelsDir: null })}>Standard</button> : null}
              </div>
            </label>
            <label className="stack" style={{ gap: 3 }}>
              <span className="muted">Ollama-Adresse (nur lokal). Ein eigener Port startet eine separate Instanz mit obigem Modellordner.</span>
              <input className="input" defaultValue={settings?.ollamaBaseUrl} onBlur={(event) => event.target.value !== settings?.ollamaBaseUrl && void updateSettings({ ollamaBaseUrl: event.target.value }).then(() => ollama.reload())} />
            </label>
          </div>
        </details>
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
            <div>Größe: <strong>{confirmPull.downloadBytes ? formatBytes(confirmPull.downloadBytes) : 'wird von der Registry ermittelt'}</strong></div>
            <div>Ziel: <code>{hardware?.ollamaModelsDir}</code> (frei: {formatBytes(hardware?.disks.ollamaModels?.freeBytes)})</div>
            <div className="faint">Der Download läuft im Hintergrund und wird nach Unterbrechungen fortgesetzt.</div>
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
              await Promise.all([installed.reload(), actions.loadSettings()])
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
