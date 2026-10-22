import type { AppEvent } from '../../shared/bridge'

export type PlanningPhase = 'queued' | 'preparing' | 'context' | 'designing' | 'planning' | 'saving'
export interface PlanningProgress {
  startedAt: number
  phase: PlanningPhase
  /** Set while the design draft that precedes the plan is drafted. */
  stage?: 'design'
  model?: string
  steps: number
  last?: string
}
export type PlanningProgressByTask = Record<string, PlanningProgress>

const PHASES: readonly PlanningPhase[] = ['queued', 'preparing', 'context', 'designing', 'planning', 'saving']

/**
 * Independent tasks keep their own clock, including queue time and repository preparation. The design
 * draft of a UI task has its own clock; the plan request after its approval starts a new one.
 */
export function planningProgressForEvent(state: PlanningProgressByTask, event: AppEvent): PlanningProgressByTask {
  if (event.channel !== 'run' || typeof event.data.taskId !== 'string') return state
  const { taskId } = event.data
  const previous = state[taskId]
  let next: PlanningProgress
  if (event.type === 'plan_requested' || event.type === 'planning_started' || event.type === 'design_requested') {
    const startedAt = Date.parse(String(event.data.requestedAt ?? event.ts))
    if (!Number.isFinite(startedAt) || (previous && previous.startedAt > startedAt)) return state
    const sameRequest = previous?.startedAt === startedAt
    next = sameRequest ? { ...previous } : { startedAt, steps: 0, phase: 'queued' }
    if (event.type === 'planning_started') next.phase = 'preparing'
    if (event.type === 'design_requested') next.stage = 'design'
  } else if ((event.type === 'plan_progress' || event.type === 'design_progress') && previous && (previous.stage === 'design') === (event.type === 'design_progress')) {
    next = { ...previous }
    if (event.data.kind === 'model') next.model = String(event.data.model)
    else if (event.data.kind === 'phase') {
      const phase = event.data.phase as PlanningPhase
      if (!PHASES.includes(phase)) return state
      next.phase = phase
    } else {
      next.steps += 1
      next.last = `${String(event.data.name)} ${String(event.data.detail ?? '')}`.trim()
    }
  } else return state
  return { ...state, [taskId]: next }
}
