import { describe, expect, it } from 'vitest'
import type { ExecutionPlan } from '@multi-ai-coder/engine'
import { isSmallSafePlan } from './execution.service.js'

function plan(overrides: { tasks?: Array<{ complexity: number; risk: number }>; complexity?: number; risk?: number; securitySensitive?: boolean; openQuestions?: string[]; warnings?: string[] } = {}): ExecutionPlan {
  const tasks = (overrides.tasks ?? [{ complexity: 1, risk: 1 }]).map((task, index) => ({ id: `task-00${index + 1}`, ...task }))
  return {
    summary: 'small change',
    analysis: { complexity: overrides.complexity ?? 1, risk: overrides.risk ?? 1, securitySensitive: overrides.securitySensitive ?? false, openQuestions: overrides.openQuestions ?? [] },
    tasks,
    warnings: overrides.warnings ?? [],
  } as unknown as ExecutionPlan
}

const local = [{ executor: 'local' }]
const lowRisk = [{ riskScore: 1 }]

describe('isSmallSafePlan', () => {
  it('accepts a single low-risk local task from the premium planner', () => {
    expect(isSmallSafePlan(plan(), lowRisk, local, 'claude-code')).toBe(true)
  })

  it('accepts a deterministic fast-path tool even without a local model', () => {
    expect(isSmallSafePlan(plan(), lowRisk, [{ executor: 'blocked' }], 'fast-path')).toBe(true)
  })

  it('rejects the fallback plan after a planner error', () => {
    expect(isSmallSafePlan(plan(), lowRisk, local, 'deterministic-fallback')).toBe(false)
  })

  it('rejects premium execution (costs) and approval-gated routing', () => {
    expect(isSmallSafePlan(plan(), lowRisk, [{ executor: 'premium' }], 'codex')).toBe(false)
    expect(isSmallSafePlan(plan(), lowRisk, [{ executor: 'local', requiresApproval: true }], 'codex')).toBe(false)
  })

  it('rejects larger, riskier or unclear plans', () => {
    const three = plan({ tasks: [{ complexity: 1, risk: 1 }, { complexity: 1, risk: 1 }, { complexity: 1, risk: 1 }] })
    expect(isSmallSafePlan(three, [...lowRisk, ...lowRisk, ...lowRisk], [...local, ...local, ...local], 'codex')).toBe(false)
    expect(isSmallSafePlan(plan({ complexity: 3 }), lowRisk, local, 'codex')).toBe(false)
    expect(isSmallSafePlan(plan({ tasks: [{ complexity: 1, risk: 3 }] }), lowRisk, local, 'codex')).toBe(false)
    expect(isSmallSafePlan(plan({ securitySensitive: true }), lowRisk, local, 'codex')).toBe(false)
    expect(isSmallSafePlan(plan(), [{ riskScore: 4 }], local, 'codex')).toBe(false)
    expect(isSmallSafePlan(plan({ openQuestions: ['Which framework?'] }), lowRisk, local, 'codex')).toBe(false)
    expect(isSmallSafePlan(plan({ warnings: ['Target unknown'] }), lowRisk, local, 'codex')).toBe(false)
  })
})
