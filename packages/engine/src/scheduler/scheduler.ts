export type TaskState = 'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'

export interface SchedulableTask {
  id: string
  dependsOn: string[]
  writes: string[]
  priority: number
  resource: 'local' | 'premium' | 'none'
  /** Local model the task will use first (for model affinity / memory-aware batching). */
  model?: string
}

export interface SchedulerSlots {
  local: number
  premium: number
  none: number
}

export interface SchedulerOptions {
  slots: SchedulerSlots
  /** Executes one task. Resolve 'succeeded' or 'failed'; throwing counts as an infrastructure failure. */
  run: (task: SchedulableTask, signal: AbortSignal) => Promise<'succeeded' | 'failed'>
  /** Infrastructure retries (crash/throw), not model repair attempts. */
  maxInfraRetries?: number
  /** True if two different local models may be resident at the same time. */
  modelsCanCoexist?: (a: string, b: string) => boolean
  onStateChange?: (taskId: string, state: TaskState, detail?: string) => void
  /** Initial states (resume after restart): succeeded tasks are not re-run. */
  initialStates?: Record<string, TaskState>
}

export interface SchedulerResult {
  states: Record<string, TaskState>
  cancelled: boolean
}

/**
 * DAG scheduler with per-resource concurrency, file locks and model affinity.
 * Deadlock-free by construction: the graph is acyclic (checked by analyzeDag), every task
 * acquires exactly one resource slot atomically and waiting tasks hold nothing.
 */
export class DagScheduler {
  private readonly states = new Map<string, TaskState>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly running = new Map<string, SchedulableTask>()
  private readonly infraAttempts = new Map<string, number>()
  private paused = false
  private cancelled = false
  private wake: (() => void) | undefined

  constructor(
    private readonly tasks: SchedulableTask[],
    private readonly options: SchedulerOptions,
  ) {
    for (const task of tasks) this.states.set(task.id, options.initialStates?.[task.id] ?? 'pending')
    // Interrupted "running" tasks from a previous process are re-run.
    for (const [id, state] of this.states) if (state === 'running' || state === 'ready') this.states.set(id, 'pending')
  }

  pause() {
    this.paused = true
  }

  resume() {
    this.paused = false
    this.wake?.()
  }

  get isPaused() {
    return this.paused
  }

  cancel() {
    this.cancelled = true
    for (const controller of this.controllers.values()) controller.abort()
    this.wake?.()
  }

  /** Cancels a single task (and, implicitly, everything depending on it). */
  cancelTask(id: string) {
    this.controllers.get(id)?.abort()
    if (this.states.get(id) === 'pending' || this.states.get(id) === 'ready') this.setState(id, 'cancelled', 'Cancelled by user.')
    this.wake?.()
  }

  stateOf(id: string): TaskState | undefined {
    return this.states.get(id)
  }

  private setState(id: string, state: TaskState, detail?: string) {
    this.states.set(id, state)
    this.options.onStateChange?.(id, state, detail)
  }

  private dependencyStatus(task: SchedulableTask): 'ready' | 'waiting' | 'blocked' {
    let waiting = false
    for (const dependency of task.dependsOn) {
      const state = this.states.get(dependency)
      if (state === undefined || state === 'succeeded') continue
      if (state === 'failed' || state === 'skipped' || state === 'cancelled') return 'blocked'
      waiting = true
    }
    return waiting ? 'waiting' : 'ready'
  }

  private canStart(task: SchedulableTask): boolean {
    const used = [...this.running.values()].filter((running) => running.resource === task.resource).length
    if (used >= this.options.slots[task.resource]) return false
    for (const running of this.running.values()) {
      if (running.writes.some((file) => task.writes.includes(file))) return false
      if (
        task.resource === 'local' &&
        running.resource === 'local' &&
        task.model &&
        running.model &&
        task.model !== running.model &&
        !(this.options.modelsCanCoexist?.(task.model, running.model) ?? false)
      ) {
        return false
      }
    }
    return true
  }

  async run(): Promise<SchedulerResult> {
    const inFlight = new Map<string, Promise<void>>()

    for (;;) {
      // propagate blocked dependencies
      for (const task of this.tasks) {
        if (this.states.get(task.id) !== 'pending') continue
        if (this.cancelled) {
          this.setState(task.id, 'cancelled', 'Run cancelled.')
          continue
        }
        if (this.dependencyStatus(task) === 'blocked') this.setState(task.id, 'skipped', 'A dependency did not succeed.')
      }

      if (!this.paused && !this.cancelled) {
        const ready = this.tasks
          .filter((task) => this.states.get(task.id) === 'pending' && this.dependencyStatus(task) === 'ready')
          .sort((a, b) => this.affinity(b) - this.affinity(a) || b.priority - a.priority)
        for (const task of ready) {
          if (!this.canStart(task)) continue
          inFlight.set(task.id, this.start(task).finally(() => inFlight.delete(task.id)))
        }
      }

      const unfinished = this.tasks.filter((task) => ['pending', 'ready', 'running'].includes(this.states.get(task.id)!))
      if (!unfinished.length && !inFlight.size) break
      if (!inFlight.size && !this.paused) {
        if (this.cancelled) continue
        // Nothing running and nothing startable: only possible with a dependency on an unknown
        // state; fail safe instead of hanging.
        for (const task of unfinished) this.setState(task.id, 'skipped', 'Unschedulable (deadlock guard).')
        break
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
        if (inFlight.size) Promise.race(inFlight.values()).then(() => resolve(), () => resolve())
      })
      this.wake = undefined
    }

    return { states: Object.fromEntries(this.states), cancelled: this.cancelled }
  }

  private affinity(task: SchedulableTask): number {
    if (task.resource !== 'local' || !task.model) return 0
    return [...this.running.values()].some((running) => running.model === task.model) ? 1 : 0
  }

  private async start(task: SchedulableTask): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    this.running.set(task.id, task)
    this.setState(task.id, 'running')
    try {
      const outcome = await this.options.run(task, controller.signal)
      if (controller.signal.aborted) this.setState(task.id, 'cancelled', 'Cancelled.')
      else this.setState(task.id, outcome)
    } catch (error) {
      const attempts = (this.infraAttempts.get(task.id) ?? 0) + 1
      this.infraAttempts.set(task.id, attempts)
      const message = error instanceof Error ? error.message : String(error)
      if (controller.signal.aborted || this.cancelled) this.setState(task.id, 'cancelled', message)
      else if (attempts <= (this.options.maxInfraRetries ?? 1)) this.setState(task.id, 'pending', `Retrying after error: ${message}`)
      else this.setState(task.id, 'failed', message)
    } finally {
      this.running.delete(task.id)
      this.controllers.delete(task.id)
    }
  }
}
