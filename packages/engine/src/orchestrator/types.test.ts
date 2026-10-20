import { describe, expect, it } from 'vitest'
import { OrchestratorError, normalizeWithMeta, type CallMeta } from './types.js'

const meta = (model: string): CallMeta => ({ model, durationMs: 5, usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, measured: true, billing: 'subscription' } })

describe('normalizeWithMeta', () => {
  it('returns the normalized value', () => {
    expect(normalizeWithMeta(meta('m'), () => 42)).toBe(42)
  })

  it('attaches the meta to an OrchestratorError and keeps kind, message and questions', () => {
    const original = new OrchestratorError('needs input', 'needs_clarification', { retryable: false, questions: ['Welche Datei?'] })
    const call = meta('m')
    const error = (() => {
      try {
        return normalizeWithMeta(call, () => { throw original })
      } catch (caught) {
        return caught as OrchestratorError
      }
    })()
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.message).toBe('needs input')
    expect(error.kind).toBe('needs_clarification')
    expect(error.details.questions).toEqual(['Welche Datei?'])
    expect(error.details.meta).toBe(call)
    expect(error.stack).toBe(original.stack)
  })

  it('keeps an existing details.meta', () => {
    const existing = meta('existing')
    const original = new OrchestratorError('x', 'invalid_output', { meta: existing })
    let caught: unknown
    try {
      normalizeWithMeta(meta('other'), () => { throw original })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(original)
    expect((caught as OrchestratorError).details.meta).toBe(existing)
  })

  it('rethrows a plain Error unchanged', () => {
    const original = new Error('boom')
    let caught: unknown
    try {
      normalizeWithMeta(meta('m'), () => { throw original })
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(original)
  })
})
