import { analyzeDag, DagCycleError } from './dag.js'

/*
 * Execution forecast of a plan: in which order and how parallel the subtasks will run, and why a
 * subtask has to wait (dependency, file conflict, free slot, VRAM). It applies the same rules as the
 * DagScheduler (per-resource slots, file-conflict serialization, local models only side by side when
 * they fit into VRAM together) as discrete waves. The real scheduler starts a task as soon as its
 * inputs are free, so the forecast is an upper bound for the duration, not a promise.
 */

export type ForecastExecutor = 'local' | 'premium' | 'none' | 'blocked'

export interface ForecastTask {
  id: string
  dependsOn: string[]
  /** Files the task writes (allowed + new files): two writers of one file never run in parallel. */
  writes: string[]
  executor: ForecastExecutor
  model?: string
  /** Estimated runtime memory of the local model (weights + context). */
  memoryBytes?: number
  /** Measured/estimated duration of one attempt. */
  estimatedMs?: number
  /** Current subtask status: completed tasks are done, running ones occupy the first wave. */
  status?: string
}

export interface ForecastInput {
  tasks: ForecastTask[]
  slots: { local: number; premium: number }
  /** Usable VRAM; without it memory is not a scheduling constraint. */
  vramBytes?: number
  /** Share of the VRAM the scheduler may plan with (driver, desktop and KV growth stay free). */
  vramBudgetShare?: number
}

export type WaitReason = 'ready' | 'running' | 'done' | 'dependencies' | 'file_conflict' | 'local_slot' | 'premium_slot' | 'memory' | 'blocked'

export interface ForecastTaskResult {
  wave?: number
  reason: WaitReason
  waitsFor: string[]
  detail: string
  startsAtMs?: number
  /** True if the task lies on the longest dependency chain. */
  critical: boolean
}

export interface ForecastWave {
  index: number
  tasks: string[]
  localModels: string[]
  memoryBytes: number
  /** undefined when the VRAM is unknown. */
  fitsVram?: boolean
  durationMs: number
}

export interface ScheduleForecast {
  waves: ForecastWave[]
  tasks: Record<string, ForecastTaskResult>
  criticalPath: string[]
  estimatedMs: number
  maxParallel: number
  warnings: string[]
}

const DEFAULT_MS: Record<ForecastExecutor, number> = { local: 90_000, premium: 120_000, none: 5_000, blocked: 0 }
const DONE = new Set(['completed', 'skipped'])
const RUNNING = new Set(['running', 'validating', 'repairing'])
const DEAD = new Set(['failed', 'cancelled', 'blocked'])

const list = (ids: string[]) => ids.join(', ')

export function forecastSchedule(input: ForecastInput): ScheduleForecast {
  const warnings: string[] = []
  const byId = new Map(input.tasks.map((task) => [task.id, task]))
  const slots = { local: Math.max(1, input.slots.local), premium: Math.max(1, input.slots.premium) }
  const budget = input.vramBytes ? input.vramBytes * (input.vramBudgetShare ?? 0.9) : undefined
  const duration = (task: ForecastTask) => Math.max(0, task.estimatedMs ?? DEFAULT_MS[task.executor])

  // Normalized dependencies (unknown ids dropped, cycles broken, file conflicts serialized).
  const nodes = input.tasks.map((task) => ({ id: task.id, dependsOn: [...task.dependsOn], writes: [...task.writes] }))
  let order = input.tasks.map((task) => task.id)
  const conflictFiles = new Map<string, Map<string, string[]>>()
  try {
    const dag = analyzeDag(nodes)
    order = dag.order
    for (const edge of dag.conflictEdges) {
      const entry = conflictFiles.get(edge.from) ?? new Map<string, string[]>()
      entry.set(edge.to, edge.files)
      conflictFiles.set(edge.from, entry)
    }
    for (const edge of dag.removedEdges) warnings.push(`Zyklische Abhängigkeit aufgelöst: ${edge.from} wartet nicht mehr auf ${edge.to}.`)
  } catch (error) {
    if (!(error instanceof DagCycleError)) throw error
    warnings.push(`Abhängigkeiten enthalten einen Zyklus (${list(error.cycle)}); die Prognose ignoriert sie.`)
    for (const node of nodes) node.dependsOn = []
  }
  const deps = new Map(nodes.map((node) => [node.id, node.dependsOn]))

  const results: Record<string, ForecastTaskResult> = {}
  const done = new Set<string>()
  const dead = new Set<string>()
  for (const task of input.tasks) {
    if (DONE.has(task.status ?? '')) {
      done.add(task.id)
      results[task.id] = { reason: 'done', waitsFor: [], detail: 'fertig', critical: false }
    } else if (task.executor === 'blocked' || DEAD.has(task.status ?? '')) {
      dead.add(task.id)
      results[task.id] = { reason: 'blocked', waitsFor: [], detail: task.executor === 'blocked' ? 'kein ausführbares Modell zugeordnet' : `Status ${task.status}`, critical: false }
    }
  }
  // Everything downstream of a task that cannot run is blocked too.
  for (let changed = true; changed; ) {
    changed = false
    for (const id of order) {
      if (done.has(id) || dead.has(id)) continue
      const blockers = (deps.get(id) ?? []).filter((dependency) => dead.has(dependency))
      if (!blockers.length) continue
      dead.add(id)
      results[id] = { reason: 'blocked', waitsFor: blockers, detail: `blockiert durch ${list(blockers)}`, critical: false }
      changed = true
    }
  }

  const waves: ForecastWave[] = []
  const remaining = order.filter((id) => !done.has(id) && !dead.has(id))
  const finished = new Set(done)
  const firstWait = new Map<string, Pick<ForecastTaskResult, 'reason' | 'waitsFor' | 'detail'>>()
  let elapsed = 0
  // Tasks that already run go first: they hold their slots right now.
  remaining.sort((a, b) => Number(RUNNING.has(byId.get(b)!.status ?? '')) - Number(RUNNING.has(byId.get(a)!.status ?? '')))

  while (remaining.length) {
    const wave: ForecastWave = { index: waves.length, tasks: [], localModels: [], memoryBytes: 0, durationMs: 0 }
    let local = 0
    let premium = 0
    for (const id of [...remaining]) {
      const task = byId.get(id)!
      const open = (deps.get(id) ?? []).filter((dependency) => !finished.has(dependency))
      const note = (wait: Pick<ForecastTaskResult, 'reason' | 'waitsFor' | 'detail'>) => {
        if (!firstWait.has(id)) firstWait.set(id, wait)
      }
      if (open.length) {
        const conflicts = conflictFiles.get(id)
        const conflicting = open.filter((dependency) => conflicts?.has(dependency))
        if (conflicting.length && conflicting.length === open.length) {
          note({ reason: 'file_conflict', waitsFor: conflicting, detail: `wartet auf ${list(conflicting)} (gleiche Datei: ${list([...new Set(conflicting.flatMap((dependency) => conflicts!.get(dependency)!))])})` })
        } else note({ reason: 'dependencies', waitsFor: open, detail: `wartet auf ${list(open)}` })
        continue
      }
      if (task.executor === 'premium') {
        if (premium >= slots.premium) {
          note({ reason: 'premium_slot', waitsFor: wave.tasks.filter((other) => byId.get(other)!.executor === 'premium'), detail: 'wartet auf einen freien Premium-Slot' })
          continue
        }
        premium += 1
      } else if (task.executor === 'local') {
        const busy = wave.tasks.filter((other) => byId.get(other)!.executor === 'local')
        if (local >= slots.local) {
          note({ reason: 'local_slot', waitsFor: busy, detail: `wartet auf einen freien lokalen Slot (${slots.local} parallel)` })
          continue
        }
        const memory = task.memoryBytes ?? 0
        const resident = task.model !== undefined && wave.localModels.includes(task.model)
        if (budget !== undefined && !resident && wave.localModels.length > 0 && wave.memoryBytes + memory > budget) {
          note({ reason: 'memory', waitsFor: busy, detail: `wartet, bis genug VRAM frei ist (${task.model ?? 'Modell'} passt nicht neben ${list(wave.localModels)})` })
          continue
        }
        local += 1
        if (task.model && !resident) {
          wave.localModels.push(task.model)
          wave.memoryBytes += memory
        }
      }
      wave.tasks.push(id)
      remaining.splice(remaining.indexOf(id), 1)
      const result: ForecastTaskResult = firstWait.has(id)
        ? { ...firstWait.get(id)!, wave: wave.index, startsAtMs: elapsed, critical: false }
        : RUNNING.has(task.status ?? '')
          ? { reason: 'running', waitsFor: [], detail: 'läuft', wave: wave.index, startsAtMs: elapsed, critical: false }
          : { reason: 'ready', waitsFor: [], detail: wave.index === 0 ? 'startet sofort' : 'startet, sobald frei', wave: wave.index, startsAtMs: elapsed, critical: false }
      results[id] = result
      wave.durationMs = Math.max(wave.durationMs, duration(task))
    }
    if (!wave.tasks.length) {
      // only possible with inconsistent input (e.g. a dependency that never finishes)
      for (const id of remaining) results[id] = { reason: 'blocked', waitsFor: deps.get(id) ?? [], detail: 'Abhängigkeit wird nie fertig', critical: false }
      warnings.push(`Nicht einplanbar: ${list(remaining)}.`)
      break
    }
    if (budget !== undefined) {
      wave.fitsVram = wave.memoryBytes <= budget
      if (!wave.fitsVram) warnings.push(`${wave.localModels[0]} braucht mehr VRAM als verfügbar und läuft teilweise auf der CPU.`)
    }
    for (const id of wave.tasks) finished.add(id)
    elapsed += wave.durationMs
    waves.push(wave)
  }

  // Longest chain by duration through the remaining (not yet done) tasks.
  const longest = new Map<string, { total: number; previous?: string }>()
  for (const id of order) {
    const task = byId.get(id)!
    if (done.has(id) || dead.has(id)) continue
    let best: { total: number; previous?: string } = { total: 0 }
    for (const dependency of deps.get(id) ?? []) {
      const candidate = longest.get(dependency)
      if (candidate && candidate.total > best.total) best = { total: candidate.total, previous: dependency }
    }
    longest.set(id, { total: best.total + duration(task), previous: best.previous })
  }
  const criticalPath: string[] = []
  let tail = [...longest.entries()].sort((a, b) => b[1].total - a[1].total)[0]?.[0]
  while (tail) {
    criticalPath.unshift(tail)
    results[tail]!.critical = true
    tail = longest.get(tail)?.previous
  }

  return {
    waves,
    tasks: results,
    criticalPath,
    estimatedMs: elapsed,
    maxParallel: Math.max(0, ...waves.map((wave) => wave.tasks.length)),
    warnings,
  }
}
