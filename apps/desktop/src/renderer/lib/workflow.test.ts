import { describe, expect, it } from 'vitest'
import type { ExecutionRun, Task } from './types'
import { workflowState } from './workflow'

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
