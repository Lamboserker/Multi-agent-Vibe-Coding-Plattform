import { OrchestratorError, type CallMeta } from '@multi-ai-coder/engine'
import { describe, expect, it } from 'vitest'
import { failedCallFields, failedCallRows, modelCallRows } from './model-call.js'

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

describe('modelCallRows / failedCallRows', () => {
  const base = { kind: 'orchestrator', purpose: 'plan', status: 'ok' as const, durationMs: 42 }

  it('books a single call as one row with the caller duration (unchanged single-orchestrator behaviour)', () => {
    const rows = modelCallRows('claude-code', meta, base)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'orchestrator', provider: 'claude-code', model: 'm-meta', purpose: 'plan', status: 'ok', sessionId: 's1', durationMs: 42, inputTokens: 1200, outputTokens: 150, cachedInputTokens: 200, tokensMeasured: true, billing: 'subscription' })
    expect(rows[0]!.errorClass).toBeUndefined()
    expect(rows[0]!.apiEquivalentUsd?.toNumber()).toBeCloseTo(0.0123)
  })

  it('falls back to the provider as model and to the base billing without meta', () => {
    expect(modelCallRows('codex', undefined, { ...base, status: 'error', errorClass: 'timeout', billing: 'unknown' })).toEqual([
      { ...base, status: 'error', errorClass: 'timeout', billing: 'unknown', provider: 'codex', model: 'codex', sessionId: undefined, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, tokensMeasured: false, apiEquivalentUsd: undefined },
    ])
  })

  it('books one row per duo part with its own provider, status, error class and duration', () => {
    const part = (provider: 'claude-code' | 'codex', role: 'lead' | 'partner' | 'reconcile', inputTokens: number, status: 'ok' | 'error' = 'ok', errorClass?: string) =>
      ({ provider, role, status, errorClass, model: `${provider}-m`, sessionId: `s-${role}`, durationMs: inputTokens / 10, usage: { ...meta.usage, inputTokens } })
    const duoMeta: CallMeta = { ...meta, usage: { ...meta.usage, inputTokens: 6000 }, parts: [part('claude-code', 'lead', 1000), part('codex', 'partner', 2000, 'error', 'rate_limited'), part('claude-code', 'reconcile', 3000)] }
    const rows = modelCallRows('claude-code', duoMeta, { ...base, executionId: 'ex-1' })
    expect(rows.map((row) => [row.provider, row.model, row.status, row.errorClass, row.durationMs, row.inputTokens, row.sessionId, row.executionId])).toEqual([
      ['claude-code', 'claude-code-m', 'ok', undefined, 100, 1000, 's-lead', 'ex-1'],
      ['codex', 'codex-m', 'error', 'rate_limited', 200, 2000, 's-partner', 'ex-1'],
      ['claude-code', 'claude-code-m', 'ok', undefined, 300, 3000, 's-reconcile', 'ex-1'],
    ])
  })

  it('failedCallRows takes the error kind and the error meta (duo: all parts)', () => {
    const single = failedCallRows('codex', new OrchestratorError('bad', 'invalid_output', { meta }), { kind: 'orchestrator', purpose: 'chat', durationMs: 7 })
    expect(single).toHaveLength(1)
    expect(single[0]).toMatchObject({ provider: 'codex', status: 'error', errorClass: 'invalid_output', model: 'm-meta', inputTokens: 1200, durationMs: 7 })
    expect(failedCallRows('codex', new Error('boom'), { kind: 'orchestrator', purpose: 'chat', durationMs: 7 })[0]).toMatchObject({ provider: 'codex', status: 'error', errorClass: undefined, model: 'codex', inputTokens: 0, billing: undefined })
    const parts = [
      { provider: 'claude-code' as const, role: 'lead' as const, status: 'error' as const, errorClass: 'timeout', durationMs: 1, usage: meta.usage },
      { provider: 'codex' as const, role: 'partner' as const, status: 'error' as const, errorClass: 'process_failed', durationMs: 2, usage: { ...meta.usage, inputTokens: 0, measured: false } },
    ]
    const both = failedCallRows('claude-code', new OrchestratorError('both', 'timeout', { meta: { ...meta, parts } }), { kind: 'orchestrator', purpose: 'design', errorClass: 'timeout', durationMs: 9 })
    expect(both.map((row) => [row.provider, row.errorClass, row.inputTokens, row.tokensMeasured])).toEqual([['claude-code', 'timeout', 1200, true], ['codex', 'process_failed', 0, false]])
  })
})
