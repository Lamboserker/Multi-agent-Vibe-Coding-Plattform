import { describe, expect, it } from 'vitest'
import { OrchestratorError, mergeCallMeta, normalizeWithMeta, withErrorMeta, type CallMeta } from './types.js'

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

describe('mergeCallMeta', () => {
  const first: CallMeta = { sessionId: 's1', model: 'm1', durationMs: 10, usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5, measured: true, apiEquivalentUsd: 0.1, billing: 'unknown' } }
  const second: CallMeta = { sessionId: 's2', durationMs: 7, usage: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 1, measured: false, apiEquivalentUsd: 0.05, billing: 'subscription' } }

  it('returns the second meta when there is no first', () => {
    expect(mergeCallMeta(undefined, second)).toBe(second)
  })

  it('sums tokens, duration and cost; takes session and billing from the second', () => {
    const merged = mergeCallMeta(first, second)
    expect(merged.usage).toMatchObject({ inputTokens: 150, outputTokens: 30, cachedInputTokens: 6, measured: false, billing: 'subscription' })
    expect(merged.usage.apiEquivalentUsd).toBeCloseTo(0.15)
    expect(merged.durationMs).toBe(17)
    expect(merged.sessionId).toBe('s2')
    expect(merged.model).toBe('m1')
  })

  it('is measured only when both are, and keeps the cost undefined when neither has one', () => {
    const a = { ...first, usage: { ...first.usage, apiEquivalentUsd: undefined } }
    const b = { ...first, usage: { ...first.usage, apiEquivalentUsd: undefined } }
    const merged = mergeCallMeta(a, b)
    expect(merged.usage.measured).toBe(true)
    expect(merged.usage.apiEquivalentUsd).toBeUndefined()
  })
})

describe('withErrorMeta', () => {
  it('returns the error unchanged without meta or for a plain Error', () => {
    const error = new OrchestratorError('x', 'invalid_output')
    expect(withErrorMeta(error, undefined)).toBe(error)
    const plain = new Error('boom')
    expect(withErrorMeta(plain, meta('m'))).toBe(plain)
  })

  it('attaches the meta to an OrchestratorError and keeps kind and details', () => {
    const original = new OrchestratorError('x', 'process_failed', { exitCode: 1, stderr: 'e' })
    const call = meta('m')
    const result = withErrorMeta(original, call) as OrchestratorError
    expect(result).toBeInstanceOf(OrchestratorError)
    expect(result.kind).toBe('process_failed')
    expect(result.message).toBe('x')
    expect(result.details).toMatchObject({ exitCode: 1, stderr: 'e' })
    expect(result.details.meta).toBe(call)
  })

  it('merges with an existing details.meta', () => {
    const original = new OrchestratorError('x', 'invalid_output', { meta: meta('later') })
    const result = withErrorMeta(original, meta('earlier')) as OrchestratorError
    expect(result.details.meta?.usage.inputTokens).toBe(20)
    expect(result.details.meta?.durationMs).toBe(10)
    expect(result.details.meta?.model).toBe('later')
  })
})
