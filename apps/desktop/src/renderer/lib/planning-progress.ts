import type { AppEvent } from '../../shared/bridge'

export type PlanningPhase = 'queued' | 'preparing' | 'context' | 'planning' | 'saving'
export interface PlanningProgress {
  startedAt: number
  phase: PlanningPhase
  model?: string
  steps: number
  last?: string
}
export type PlanningProgressByTask = Record<string, PlanningProgress>

/** Independent tasks keep their own clock, including queue time and repository preparation. */
export function planningProgressForEvent(state: PlanningProgressByTask, event: AppEvent): PlanningProgressByTask {
  if (event.channel !== 'run' || typeof event.data.taskId !== 'string') return state
  const { taskId } = event.data
  const previous = state[taskId]
  let next: PlanningProgress
  if (event.type === 'plan_requested' || event.type === 'planning_started') {
    const startedAt = Date.parse(String(event.data.requestedAt ?? event.ts))
    if (!Number.isFinite(startedAt) || (previous && previous.startedAt > startedAt)) return state
    const sameRequest = previous?.startedAt === startedAt
    next = sameRequest ? { ...previous } : { startedAt, steps: 0, phase: 'queued' }
    if (event.type === 'planning_started') next.phase = 'preparing'
  } else if (event.type === 'plan_progress' && previous) {
    next = { ...previous }
    if (event.data.kind === 'model') next.model = String(event.data.model)
    else if (event.data.kind === 'phase') {
      const phase = event.data.phase
      if (phase !== 'queued' && phase !== 'preparing' && phase !== 'context' && phase !== 'planning' && phase !== 'saving') return state
      next.phase = phase
    } else {
      next.steps += 1
      next.last = `${String(event.data.name)} ${String(event.data.detail ?? '')}`.trim()
    }
  } else return state
  return { ...state, [taskId]: next }
}
