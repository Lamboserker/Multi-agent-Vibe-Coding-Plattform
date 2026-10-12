import { describe, expect, it } from 'vitest'
import { defaultAvailability, routeModel } from './routing.js'
import type { TaskClassification } from './types.js'

const baseClassification: TaskClassification = {
  normalizedGoal: 'Update a React button style',
  complexity: 'small',
  taskType: 'frontend',
  riskLevel: 'low',
  contextNeed: 'low',
  securitySensitive: false,
  estimatedCostTier: 'free',
  deterministicOnly: false,
  affectedAreas: ['frontend'],
  reason: 'Small UI-only change.',
}

describe('routeModel', () => {
  it('keeps small verifiable tasks on local models', () => {
    const decision = routeModel({
      classification: baseClassification,
      costMode: 'balanced',
      availability: defaultAvailability({ premiumAllowed: true }),
      validationAvailable: true,
    })

    expect(decision.selectedModelClass).toBe('local_llm')
    expect(decision.requiresHumanApproval).toBe(false)
  })

  it('requires premium approval for security-sensitive work when allowed', () => {
    const decision = routeModel({
      classification: {
        ...baseClassification,
        taskType: 'backend',
        riskLevel: 'high',
        complexity: 'complex',
        securitySensitive: true,
        affectedAreas: ['auth', 'security'],
      },
      costMode: 'quality',
      availability: defaultAvailability({ premiumAllowed: true }),
      validationAvailable: true,
    })

    expect(decision.selectedModelClass).toBe('premium_llm')
    expect(decision.requiresHumanApproval).toBe(true)
  })

  it('blocks premium by default in cheapest mode', () => {
    const decision = routeModel({
      classification: {
        ...baseClassification,
        taskType: 'database',
        riskLevel: 'critical',
        complexity: 'critical',
        affectedAreas: ['migration'],
      },
      costMode: 'cheapest',
      availability: defaultAvailability({ premiumAllowed: true }),
      validationAvailable: false,
    })

    expect(decision.selectedModelClass).toBe('cheap_api_llm')
    expect(decision.requiresHumanApproval).toBe(true)
  })
})
