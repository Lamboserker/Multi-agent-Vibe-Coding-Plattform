import { describe, expect, it } from 'vitest'
import type { ExecutionRun, Task } from './types'
import { composerAfterSend, designModeOf, isPrePlan, isWorking, workflowState } from './workflow'

const task = (currentStep = 'awaiting_plan_approval'): Task => ({ id: 'task', currentStep, subtasks: [{ id: 'subtask' }], status: 'planned' } as Task)
const run = (status: ExecutionRun['status']): ExecutionRun => ({ id: 'run', taskId: 'task', status } as ExecutionRun)

describe('central workflow lifecycle', () => {
  it('distinguishes preparing a task, planning and plan approval', () => {
    expect(workflowState()).toMatchObject({ phase: 'task', state: 'draft' })
    expect(workflowState(task('planning'))).toMatchObject({ phase: 'plan', state: 'planning' })
    expect(workflowState(task())).toMatchObject({ phase: 'plan', state: 'ready' })
  })
  it.each(['plan_interrupted', 'plan_failed'])('offers planning recovery for %s rather than a stale execution', (step) => {
    expect(workflowState(task(step), run('applied'))).toMatchObject({ phase: 'plan', state: 'plan_error' })
  })
  it.each([
    ['designing', 'designing', 'Design-Entwurf läuft'], ['awaiting_design_approval', 'design_review', 'Design prüfen'], ['design_failed', 'design_error', 'Design neu entwerfen'],
  ] as const)('presents the design step %s as %s before planning, even with an old run', (step, state, label) => {
    expect(workflowState(task(step))).toEqual({ phase: 'plan', state, label })
    for (const status of ['applied', 'failed', 'running'] as const) expect(workflowState(task(step), run(status))).toMatchObject({ phase: 'plan', state })
  })
  it('treats the design states as pre-plan and the drafting as work in progress', () => {
    for (const state of ['draft', 'designing', 'design_review', 'design_error', 'planning', 'plan_error', 'plan_questions'] as const) expect(isPrePlan(state)).toBe(true)
    for (const state of ['ready', 'running', 'approval', 'done'] as const) expect(isPrePlan(state)).toBe(false)
    expect(['designing', 'planning', 'running', 'design_review', 'design_error', 'ready'].filter((state) => isWorking(state as never))).toEqual(['designing', 'planning', 'running'])
  })
  it('asks for answers on plan_clarification, even with old subtasks or an old run', () => {
    expect(workflowState(task('plan_clarification'))).toMatchObject({ phase: 'plan', state: 'plan_questions' })
    for (const status of ['applied', 'failed'] as const) expect(workflowState(task('plan_clarification'), run(status))).toMatchObject({ phase: 'plan', state: 'plan_questions' })
  })
  it.each([
    ['pending', 'running'], ['running', 'running'], ['integrating', 'running'], ['paused', 'paused'],
    ['interrupted', 'recoverable'], ['failed', 'recoverable'], ['cancelled', 'cancelled'],
  ] as const)('presents %s as %s in the execution step', (status, state) => {
    expect(workflowState(task('execution'), run(status))).toMatchObject({ phase: 'execution', state })
  })
  it('requires a final approval and treats applied/retained results as finished', () => {
    expect(workflowState(task('execution'), run('awaiting_approval'))).toMatchObject({ phase: 'approval', state: 'approval' })
    for (const status of ['applied', 'completed'] as const) expect(workflowState(task('execution'), run(status))).toMatchObject({ phase: 'approval', state: 'done' })
  })
  it.each(['failed', 'interrupted', 'cancelled'] as const)('shows a new plan after a %s run instead of that run', (status) => {
    expect(workflowState(task(), run(status))).toMatchObject({ phase: 'plan', state: 'ready' })
  })
  it('never offers controls for an execution that belongs to another task', () => {
    expect(workflowState(task(), { ...run('running'), taskId: 'other' })).toMatchObject({ phase: 'plan', state: 'ready' })
  })
})

describe('design mode of a message', () => {
  it('is sent for tasks when chosen and never for questions or invalid persisted values', () => {
    expect(designModeOf('task', 'force')).toBe('force')
    expect(designModeOf('task', 'skip')).toBe('skip')
    expect(designModeOf('task', 'auto')).toBe('auto')
    expect(designModeOf('task', undefined)).toBeUndefined()
    expect(designModeOf('task', 'always')).toBeUndefined()
    expect(designModeOf('ask', 'force')).toBeUndefined()
  })

  it('resets an explicitly sent design mode after sending, so follow-ups keep the choice of the task', () => {
    const reset = composerAfterSend('force')
    expect(reset).toEqual({ text: '', designMode: undefined })
    expect('designMode' in reset).toBe(true)
    expect(composerAfterSend(undefined)).toEqual({ text: '' })
    expect('designMode' in composerAfterSend(undefined)).toBe(false)
  })
})
