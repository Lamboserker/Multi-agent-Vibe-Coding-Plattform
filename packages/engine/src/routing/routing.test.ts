import { describe, expect, it } from 'vitest'
import { routeTask, type LocalModelProfile, type RoutableTask } from './router.js'
import { aggregateSuitability, confidenceLabel, wilsonLowerBound, type AttemptRecord } from './stats.js'

const models: LocalModelProfile[] = [
  { model: 'small:1b', roles: ['fast'], toolCalling: true, contextWindow: 32768, available: true },
  { model: 'mid:7b', roles: ['balanced'], toolCalling: true, contextWindow: 32768, available: true },
  { model: 'big:20b', roles: ['advanced'], toolCalling: true, contextWindow: 131072, available: true },
]
const policy = { costMode: 'balanced' as const, premiumAvailable: true, premiumExecutionAllowed: true }
const baseTask: RoutableTask = { id: 't', category: 'react-ui', complexity: 2, risk: 1, expectedInputTokens: 4000, suggestedExecutor: 'local', securityCritical: false }

function attempts(model: string, category: string, successes: number, failures: number): AttemptRecord[] {
  return [
    ...Array.from({ length: successes }, () => ({ model, category, outcome: 'success' as const, repairRound: 0, durationMs: 1000, escalated: false })),
    ...Array.from({ length: failures }, () => ({ model, category, outcome: 'validation_failed' as const, repairRound: 0, durationMs: 1000, escalated: true })),
  ]
}

describe('suitability statistics', () => {
  it('uses conservative Wilson lower bounds that grow with sample size', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0)
    expect(wilsonLowerBound(3, 3)).toBeLessThan(0.65)
    expect(wilsonLowerBound(30, 30)).toBeGreaterThan(0.9)
    expect(confidenceLabel(0.99, 3)).toBe('insufficient_data')
  })

  it('aggregates per model and category', () => {
    const stats = aggregateSuitability([...attempts('a', 'react-ui', 8, 2), ...attempts('a', 'database-migration', 1, 6)])
    const ui = stats.find((entry) => entry.category === 'react-ui')!
    expect(ui.attempts).toBe(10)
    expect(ui.successRate).toBe(0.8)
    expect(stats.find((entry) => entry.category === 'database-migration')!.confidence).toBe('low')
  })
})

describe('routeTask', () => {
  it('breaks equal reliability ties by measured time per validated change', () => {
    const peers = [models[0]!, { ...models[0]!, model: 'other' }]
    const measured = aggregateSuitability([
      ...attempts('small:1b', 'react-ui', 10, 0).map(record => ({ ...record, durationMs: 5000 })),
      ...attempts('other', 'react-ui', 10, 0),
    ])
    expect(routeTask(baseTask, peers, policy, measured).model).toBe('other')
    // A fast but less reliable model must not outrank the better validated model.
    const failures = aggregateSuitability([...attempts('small:1b', 'react-ui', 20, 0), ...attempts('other', 'react-ui', 5, 2)])
    expect(routeTask(baseTask, peers, policy, failures).model).toBe('small:1b')
  })
  it('maps complexity to tiers (complexity decides, not model size)', () => {
    expect(routeTask(baseTask, models, policy).model).toBe('small:1b')
    expect(routeTask({ ...baseTask, complexity: 3 }, models, policy).model).toBe('mid:7b')
    expect(routeTask({ ...baseTask, complexity: 4 }, models, policy).model).toBe('big:20b')
    expect(routeTask({ ...baseTask, complexity: 5 }, models, policy).executor).toBe('premium')
  })

  it('never uses the fast tier in quality mode', () => {
    expect(routeTask(baseTask, models, { ...policy, costMode: 'quality' }).model).toBe('mid:7b')
    expect(routeTask(baseTask, models, { ...policy, costMode: 'cheapest' }).model).toBe('small:1b')
  })

  it('sends security-critical work to premium and keeps it local in cheapest mode only when risk allows', () => {
    expect(routeTask({ ...baseTask, category: 'auth-security', risk: 4 }, models, policy).executor).toBe('premium')
    expect(routeTask({ ...baseTask, complexity: 5, risk: 2 }, models, { ...policy, costMode: 'cheapest' }).executor).toBe('premium')
    expect(routeTask({ ...baseTask, complexity: 4, suggestedExecutor: 'premium' }, models, { ...policy, costMode: 'cheapest' }).model).toBe('big:20b')
  })

  it('builds a bounded escalation chain ending at premium', () => {
    const decision = routeTask(baseTask, models, policy)
    expect(decision.escalation).toEqual([
      { executor: 'local', model: 'mid:7b', tier: 'balanced' },
      { executor: 'premium', tier: 'premium' },
    ])
  })

  it('downgrades to a proven small model and upgrades away from a model that keeps failing', () => {
    const proven = aggregateSuitability(attempts('small:1b', 'react-ui', 20, 0))
    expect(routeTask({ ...baseTask, complexity: 3 }, models, policy, proven).model).toBe('small:1b')

    const weak = aggregateSuitability(attempts('mid:7b', 'backend-service', 1, 9))
    const decision = routeTask({ ...baseTask, category: 'backend-service', complexity: 3 }, models, policy, weak)
    expect(decision.model).toBe('big:20b')
    expect(decision.reasons.join(' ')).toMatch(/fails often/)
  })

  it('only lets a premium suggestion raise the tier in balanced mode for complexity >= 4 or risk >= 3', () => {
    const suggested = { ...baseTask, suggestedExecutor: 'premium' as const }
    const low = routeTask({ ...suggested, complexity: 2, risk: 2 }, models, policy)
    expect(low.model).toBe('small:1b')
    expect(low.reasons.join(' ')).toMatch(/balanced mode keeps/)
    expect(routeTask({ ...suggested, complexity: 3, risk: 1 }, models, policy).model).toBe('mid:7b')
    expect(routeTask({ ...suggested, complexity: 2, risk: 3 }, models, policy).model).toBe('big:20b')
    expect(routeTask({ ...suggested, complexity: 4, risk: 1 }, models, policy).executor).toBe('premium')
    // Quality mode still honours every suggestion.
    expect(routeTask({ ...suggested, complexity: 2, risk: 1 }, models, { ...policy, costMode: 'quality' }).executor).toBe('premium')
  })

  it('allows a stats downgrade at risk 3 with high confidence, never for security-critical work', () => {
    const proven = aggregateSuitability(attempts('small:1b', 'react-ui', 20, 0))
    expect(routeTask({ ...baseTask, complexity: 3, risk: 3 }, models, policy, proven).model).toBe('small:1b')
    // Only medium confidence → no downgrade at risk 3.
    const medium = aggregateSuitability(attempts('small:1b', 'react-ui', 6, 2))
    expect(medium[0]!.confidence).not.toBe('high')
    expect(routeTask({ ...baseTask, complexity: 3, risk: 3 }, models, policy, medium).model).toBe('mid:7b')
    // Risk 4 stays out of reach.
    expect(routeTask({ ...baseTask, complexity: 3, risk: 4 }, models, policy, proven).executor).toBe('premium')
    // Security-critical files kept local by cheapest mode never move down.
    const secure = aggregateSuitability(attempts('small:1b', 'backend-service', 20, 0))
    const decision = routeTask({ ...baseTask, category: 'backend-service', complexity: 3, risk: 3, securityCritical: true }, models, { ...policy, costMode: 'cheapest' }, secure)
    expect(decision.model).toBe('big:20b')
  })

  it('upgrades when the expected context does not fit', () => {
    expect(routeTask({ ...baseTask, expectedInputTokens: 60_000 }, models, policy).model).toBe('big:20b')
  })

  it('honours manual assignments and reports blocked routing', () => {
    expect(routeTask({ ...baseTask, manualModel: 'big:20b' }, models, policy).model).toBe('big:20b')
    expect(routeTask({ ...baseTask, manualModel: 'premium' }, models, policy).executor).toBe('premium')
    expect(routeTask(baseTask, [], { ...policy, premiumAvailable: false }).executor).toBe('blocked')
  })

  it('falls back to the strongest local model with approval when premium is unavailable', () => {
    const decision = routeTask({ ...baseTask, complexity: 5 }, models, { ...policy, premiumAvailable: false })
    expect(decision.model).toBe('big:20b')
    expect(decision.requiresApproval).toBe(true)
  })

  it('lets one model take several roles on weak hardware', () => {
    const single: LocalModelProfile[] = [{ model: 'only:3b', roles: ['fast', 'balanced', 'advanced'], toolCalling: true, contextWindow: 32768, available: true }]
    expect(routeTask({ ...baseTask, complexity: 4 }, single, policy).model).toBe('only:3b')
  })
})
