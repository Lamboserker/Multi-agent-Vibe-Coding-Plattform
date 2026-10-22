import { describe, expect, it } from 'vitest'
import { selfTestFinished, selfTestStepError } from './self-test.controller.js'

describe('function test classification', () => {
  it('stops at failed or user-blocking plan and design steps, not while work is running', () => {
    for (const step of ['plan_failed', 'plan_clarification', 'design_failed', 'awaiting_design_approval']) {
      expect(selfTestFinished(step), step).toBe(true)
      expect(selfTestStepError(step), step).toBeTruthy()
    }
    for (const step of ['draft', 'planning', 'designing', 'awaiting_plan_approval', 'toString']) {
      expect(selfTestFinished(step), step).toBe(false)
      expect(selfTestStepError(step), step).toBeNull()
    }
    expect(selfTestStepError('design_failed')).toBe('Design-Entwurf fehlgeschlagen')
  })

  it('follows the execution once one exists', () => {
    expect(selfTestFinished('design_failed', 'running')).toBe(false)
    expect(selfTestFinished('planned', 'awaiting_approval')).toBe(true)
  })
})
