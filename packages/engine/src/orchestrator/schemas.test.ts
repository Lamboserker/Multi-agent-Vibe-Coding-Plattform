import { describe, expect, it } from 'vitest'
import { normalizePlan } from './schemas.js'
import { OrchestratorError } from './types.js'

function failure(raw: unknown): OrchestratorError {
  try {
    normalizePlan(raw)
  } catch (error) {
    return error as OrchestratorError
  }
  throw new Error('normalizePlan did not throw')
}

describe('normalizePlan without tasks', () => {
  it('asks for clarification when the planner returned open questions', () => {
    const questions = ['Welche Datei?', 'Welches Format?']
    const error = failure({ summary: '', analysis: { openQuestions: questions }, tasks: [], warnings: ['ignored'] })
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.kind).toBe('needs_clarification')
    expect(error.details.questions).toEqual(questions)
    expect(error.retryable).toBe(false)
    expect(error.message).toContain('Welche Datei?; Welches Format?')
  })

  it('uses the warnings as questions when there are no open questions', () => {
    const error = failure({ analysis: { openQuestions: [] }, tasks: [], warnings: ['Which framework?'] })
    expect(error.kind).toBe('needs_clarification')
    expect(error.details.questions).toEqual(['Which framework?'])
  })

  it('stays invalid output without questions or warnings', () => {
    const error = failure({ analysis: {}, tasks: [], warnings: [] })
    expect(error.kind).toBe('invalid_output')
  })

  it('still normalizes a plan with one task', () => {
    const plan = normalizePlan({ summary: 'S', analysis: { openQuestions: ['q'] }, tasks: [{ id: 'a', title: 'Do it', description: 'Do it now' }], warnings: [] })
    expect(plan.tasks).toHaveLength(1)
    expect(plan.analysis.openQuestions).toEqual(['q'])
  })
})
