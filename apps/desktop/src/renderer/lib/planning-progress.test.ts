import { describe, expect, it } from 'vitest'
import type { AppEvent } from '../../shared/bridge'
import { planningProgressForEvent, type PlanningProgressByTask } from './planning-progress'

const event = (type: string, taskId: string, data: Record<string, unknown> = {}): AppEvent => ({ channel: 'run', type, ts: '2026-10-14T10:00:10.000Z', data: { taskId, ...data } })
const requestedAt = '2026-10-14T10:00:00.000Z'

describe('planning progress', () => {
  it('includes queue and preparation time without restarting the clock on model output', () => {
    let state = planningProgressForEvent({}, event('plan_requested', 'a', { requestedAt }))
    state = planningProgressForEvent(state, event('planning_started', 'a', { requestedAt }))
    state = planningProgressForEvent(state, event('plan_progress', 'a', { kind: 'model', model: 'test-model' }))
    state = planningProgressForEvent(state, event('plan_progress', 'a', { kind: 'phase', phase: 'planning' }))
    expect(state.a).toEqual({ startedAt: Date.parse(requestedAt), steps: 0, phase: 'planning', model: 'test-model' })
  })

  it('keeps concurrent tasks separate when their events interleave', () => {
    let state: PlanningProgressByTask = {}
    for (const taskId of ['a', 'b']) state = planningProgressForEvent(state, event('planning_started', taskId, { requestedAt }))
    state = planningProgressForEvent(state, event('plan_progress', 'a', { kind: 'tool', name: 'Read', detail: 'src/a.ts' }))
    state = planningProgressForEvent(state, event('plan_progress', 'b', { kind: 'model', model: 'other-model' }))
    expect(state.a).toMatchObject({ steps: 1, last: 'Read src/a.ts' })
    expect(state.a?.model).toBeUndefined()
    expect(state.b).toMatchObject({ steps: 0, model: 'other-model' })
  })

  it('does not discard progress if a job starts before its enqueue acknowledgement arrives', () => {
    let state = planningProgressForEvent({}, event('planning_started', 'a', { requestedAt }))
    state = planningProgressForEvent(state, event('plan_progress', 'a', { kind: 'tool', name: 'Read', detail: 'src/a.ts' }))
    state = planningProgressForEvent(state, event('plan_requested', 'a', { requestedAt }))
    expect(state.a).toMatchObject({ phase: 'preparing', steps: 1, last: 'Read src/a.ts' })
  })

  it('clears the previous model and steps when the same task is planned again', () => {
    let state = planningProgressForEvent({}, event('planning_started', 'a', { requestedAt }))
    state = planningProgressForEvent(state, event('plan_progress', 'a', { kind: 'model', model: 'old-model' }))
    const later = '2026-10-14T10:01:00.000Z'
    state = planningProgressForEvent(state, event('plan_requested', 'a', { requestedAt: later }))
    expect(state.a).toEqual({ startedAt: Date.parse(later), phase: 'queued', steps: 0 })
    expect(planningProgressForEvent(state, event('plan_requested', 'a', { requestedAt }))).toBe(state)
  })
})

describe('design progress', () => {
  it('runs its own clock for the design draft and keeps plan events out of it', () => {
    let state = planningProgressForEvent({}, event('design_requested', 'a', { requestedAt }))
    state = planningProgressForEvent(state, event('design_progress', 'a', { kind: 'phase', phase: 'context' }))
    state = planningProgressForEvent(state, event('design_progress', 'a', { kind: 'phase', phase: 'designing', designer: 'claude-code' }))
    state = planningProgressForEvent(state, event('design_progress', 'a', { kind: 'tool', name: 'Read', detail: 'src/App.tsx' }))
    state = planningProgressForEvent(state, event('plan_progress', 'a', { kind: 'model', model: 'stale' }))
    expect(state.a).toEqual({ startedAt: Date.parse(requestedAt), phase: 'designing', stage: 'design', steps: 1, last: 'Read src/App.tsx' })
  })

  it('starts the planning clock after the approval and ignores late design events', () => {
    let state = planningProgressForEvent({}, event('design_requested', 'a', { requestedAt }))
    const later = '2026-10-14T10:03:00.000Z'
    state = planningProgressForEvent(state, event('plan_requested', 'a', { requestedAt: later }))
    expect(state.a).toEqual({ startedAt: Date.parse(later), phase: 'queued', steps: 0 })
    expect(planningProgressForEvent(state, event('design_progress', 'a', { kind: 'phase', phase: 'designing' }))).toBe(state)
    expect(planningProgressForEvent(state, event('design_progress', 'a', { kind: 'phase', phase: 'bogus' }))).toBe(state)
  })
})
