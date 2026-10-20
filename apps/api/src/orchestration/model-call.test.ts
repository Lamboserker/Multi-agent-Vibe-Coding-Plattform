import { OrchestratorError, type CallMeta } from '@multi-ai-coder/engine'
import { describe, expect, it } from 'vitest'
import { failedCallFields } from './model-call.js'

const meta: CallMeta = { sessionId: 's1', model: 'm-meta', durationMs: 5, usage: { inputTokens: 1200, outputTokens: 150, cachedInputTokens: 200, measured: true, apiEquivalentUsd: 0.0123, billing: 'subscription' } }

describe('failedCallFields', () => {
  it('takes the booked usage from an OrchestratorError meta', () => {
    const fields = failedCallFields(new OrchestratorError('bad', 'invalid_output', { meta }), 'fallback')
    expect(fields).toMatchObject({ model: 'm-meta', sessionId: 's1', inputTokens: 1200, outputTokens: 150, cachedInputTokens: 200, tokensMeasured: true, billing: 'subscription' })
    expect(fields.apiEquivalentUsd?.toNumber()).toBeCloseTo(0.0123)
  })

  it('leaves the cost undefined when the meta has none and falls back to the given model', () => {
    const { apiEquivalentUsd: _cost, ...usage } = meta.usage
    const fields = failedCallFields(new OrchestratorError('bad', 'invalid_output', { meta: { ...meta, model: undefined, usage } }), 'fallback')
    expect(fields.model).toBe('fallback')
    expect(fields.apiEquivalentUsd).toBeUndefined()
  })

  it.each([
    ['an OrchestratorError without meta', new OrchestratorError('bad', 'process_failed')],
    ['a plain Error', new Error('boom')],
    ['a non-error value', 'oops'],
  ])('returns zero usage for %s', (_name, error) => {
    expect(failedCallFields(error, 'fallback')).toEqual({ model: 'fallback', sessionId: undefined, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, tokensMeasured: false, apiEquivalentUsd: undefined, billing: undefined })
  })
})
