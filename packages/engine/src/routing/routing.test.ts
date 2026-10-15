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
