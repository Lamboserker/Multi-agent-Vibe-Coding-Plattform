import { useEffect } from 'react'
import { api, errorMessage } from './api'
import { createStore, useStore } from './store/core'
import type { ResourceSnapshot } from './types'

/*
 * Live resource monitor. The runtime samples only when asked, so polling runs only while at least
 * one view needs it and the window is visible; the fastest requested interval wins.
 */

export const resourceStore = createStore<{ snapshot?: ResourceSnapshot; error?: string; loading: boolean }>({ loading: false })

const subscribers = new Map<number, number>()
let nextId = 1
let timer: number | undefined
let inflight = false

async function poll() {
  if (inflight || document.hidden) return
  inflight = true
  resourceStore.set({ loading: true })
  try {
    resourceStore.set({ snapshot: await api.get<ResourceSnapshot>('/system/resources'), error: undefined })
  } catch (error) {
    resourceStore.set({ error: errorMessage(error) })
  } finally {
    inflight = false
    resourceStore.set({ loading: false })
  }
}

function reschedule() {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
  if (!subscribers.size) return
  const interval = Math.min(...subscribers.values())
  timer = window.setInterval(() => void poll(), interval)
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => !document.hidden && subscribers.size && void poll())

/** Keeps the monitor polling at `intervalMs` while the calling component is mounted (and `active`). */
export function useResourceMonitor(intervalMs = 3000, active = true) {
  useEffect(() => {
    if (!active) return
    const id = nextId++
    subscribers.set(id, intervalMs)
    reschedule()
    void poll()
    return () => {
      subscribers.delete(id)
      reschedule()
    }
  }, [intervalMs, active])
  return useStore(resourceStore, (state) => state.snapshot)
}

export const pct = (value: number | undefined, total: number | undefined) => (value === undefined || !total ? undefined : Math.max(0, Math.min(100, Math.round((value / total) * 100))))

/** Colour of a load value: amber from 85 %, red from 95 %. */
export const loadTone = (value: number | undefined, base = 'var(--local)') => (value === undefined ? 'var(--faint)' : value >= 95 ? 'var(--err)' : value >= 85 ? 'var(--tool)' : base)

export interface ResourceMetric {
  id: 'gpu' | 'vram' | 'cpu' | 'ram'
  label: string
  pct?: number
  value: string
  sub: string
  tone: string
  bars: number[]
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')}`

/** The four metrics of the monitor with their recent history (bars as 0–100). */
export function resourceMetrics(snapshot: ResourceSnapshot): ResourceMetric[] {
  const { gpu, ram, cpu, history } = snapshot
  const vramTotal = gpu?.vramTotalMb
  const gpuPct = gpu?.utilizationPct
  const vramPct = pct(gpu?.vramUsedMb, vramTotal)
  const ramPct = pct(ram.usedBytes, ram.totalBytes)!
  const offload = snapshot.models.some((model) => model.gpuShare < 0.98)
  return [
    { id: 'gpu', label: 'GPU', pct: gpuPct, value: gpuPct === undefined ? 'nicht messbar' : 'Last', sub: gpu?.name.replace(/^NVIDIA (GeForce )?/, '') ?? 'keine GPU erkannt', tone: loadTone(gpuPct), bars: history.map((point) => point.gpuPct ?? 0) },
    {
      id: 'vram',
      label: 'VRAM',
      pct: vramPct,
      value: gpu?.vramUsedMb !== undefined && vramTotal ? `${gb(gpu.vramUsedMb * 1024 ** 2)} / ${gb(vramTotal * 1024 ** 2)} GB` : 'unbekannt',
      sub: gpu?.source === 'ollama' ? 'nur Modelle (laut Ollama)' : `${snapshot.models.length} Modell${snapshot.models.length === 1 ? '' : 'e'}`,
      tone: loadTone(vramPct),
      bars: history.map((point) => pct(point.vramUsedMb, vramTotal) ?? 0),
    },
    { id: 'cpu', label: 'CPU', pct: Math.round(cpu.pct), value: `${cpu.logicalCores} Threads`, sub: offload ? 'inkl. Offload' : 'System', tone: loadTone(cpu.pct, 'var(--muted)'), bars: history.map((point) => point.cpuPct) },
    { id: 'ram', label: 'RAM', pct: ramPct, value: `${gb(ram.usedBytes)} / ${gb(ram.totalBytes)} GB`, sub: 'System', tone: loadTone(ramPct, 'var(--muted)'), bars: history.map((point) => pct(point.ramUsedBytes, ram.totalBytes) ?? 0) },
  ]
}
