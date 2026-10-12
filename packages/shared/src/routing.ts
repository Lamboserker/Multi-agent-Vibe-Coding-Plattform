import type {
  ModelAvailability,
  ModelClass,
  ProviderPricing,
  RoutingDecision,
  RoutingInput,
} from './types.js'

const MODEL_ORDER: Record<'cheapest' | 'balanced' | 'quality', ModelClass[]> = {
  cheapest: ['no_llm', 'local_llm', 'free_llm', 'cheap_api_llm', 'premium_llm'],
  balanced: ['no_llm', 'local_llm', 'free_llm', 'cheap_api_llm', 'premium_llm'],
  quality: ['no_llm', 'cheap_api_llm', 'premium_llm', 'free_llm', 'local_llm'],
}

const DEFAULT_COST_BY_CLASS: Record<ModelClass, number> = {
  no_llm: 0,
  local_llm: 0,
  free_llm: 0,
  cheap_api_llm: 0.08,
  premium_llm: 1.2,
}

export function routeModel(input: RoutingInput): RoutingDecision {
  const reasons: string[] = []
  const escalationRules: string[] = []
  const { classification, availability, costMode } = input
  const allowed = new Set(input.allowedModelClasses ?? MODEL_ORDER[costMode] ?? MODEL_ORDER.balanced)

  const estimatedInputTokens = estimateInputTokens(classification.contextNeed)
  const estimatedOutputTokens = estimateOutputTokens(classification.complexity)

  if (classification.deterministicOnly && allowed.has('no_llm')) {
    reasons.push('Deterministic repo analysis or validation can solve this without an LLM.')
    return buildDecision('no_llm', false, estimatedInputTokens, estimatedOutputTokens, reasons, escalationRules)
  }

  const isPremiumTrigger =
    classification.securitySensitive ||
    classification.taskType === 'database' ||
    classification.riskLevel === 'critical' ||
    classification.complexity === 'critical' ||
    classification.affectedAreas.some((area) => ['auth', 'payment', 'security', 'migration', 'architecture'].includes(area))

  if (availability.previousCheapFailures >= 2) {
    escalationRules.push('Two low-cost attempts failed; premium analysis or review is allowed before another implementation pass.')
    if (allowed.has('premium_llm') && availability.premiumAllowed) {
      reasons.push('Repeated failures justify premium analysis/review, while implementation should still return to cheaper workers where possible.')
      return buildDecision('premium_llm', true, estimatedInputTokens, estimatedOutputTokens, reasons, escalationRules)
    }
  }

  if (isPremiumTrigger) {
    escalationRules.push('Security, auth, payment, database migration, architecture, or critical-risk work requires human approval.')
    if (allowed.has('premium_llm') && availability.premiumAllowed && costMode !== 'cheapest') {
      reasons.push('High-risk domain requires premium planning or review rather than default worker execution.')
      return buildDecision('premium_llm', true, estimatedInputTokens, estimatedOutputTokens, reasons, escalationRules)
    }

    reasons.push('Premium would be appropriate, but policy or cost mode blocks it; route to cheap API with human approval.')
    return buildDecision('cheap_api_llm', true, estimatedInputTokens, estimatedOutputTokens, reasons, escalationRules)
  }

  if (classification.complexity === 'trivial' && input.validationAvailable && allowed.has('local_llm') && availability.localAvailable) {
    reasons.push('Trivial, low-risk, and validation-friendly work is cheapest on a local model.')
    return buildDecision('local_llm', false, estimatedInputTokens, estimatedOutputTokens, reasons, escalationRules)
  }

  if (
    ['small', 'medium'].includes(classification.complexity) &&
    classification.riskLevel !== 'high' &&
    classification.contextNeed !== 'high' &&
    input.validationAvailable &&
    allowed.has('local_llm') &&
    availability.localAvailable
  ) {
    reasons.push('Task is bounded and verifiable, so a local Ollama-compatible coder model is sufficient.')
    return buildDecision('local_llm', false, estimatedInputTokens, estimatedOutputTokens, reasons, escalationRules)
  }

  if (allowed.has('free_llm') && availability.freeQuotaAvailable && classification.complexity !== 'complex') {
    reasons.push('Local execution is unavailable or insufficient, and free quota is still available.')
    return buildDecision('free_llm', false, estimatedInputTokens, estimatedOutputTokens, reasons, escalationRules)
  }

  if (allowed.has('cheap_api_llm') && availability.cheapApiAvailable) {
    reasons.push('Cheap API model is the lowest reliable tier for this complexity or context size.')
    return buildDecision('cheap_api_llm', false, estimatedInputTokens, estimatedOutputTokens, reasons, escalationRules)
  }

  if (allowed.has('premium_llm') && availability.premiumAllowed && costMode === 'quality') {
    reasons.push('Quality mode permits premium fallback because lower tiers are unavailable.')
    return buildDecision('premium_llm', true, estimatedInputTokens, estimatedOutputTokens, reasons, escalationRules)
  }

  reasons.push('No enabled provider tier fully matches the request; use no_llm planning and require operator configuration.')
  return buildDecision('no_llm', true, estimatedInputTokens, estimatedOutputTokens, reasons, escalationRules)
}

export function estimateRunCostEuro(
  modelClass: ModelClass,
  inputTokens: number,
  outputTokens: number,
  pricing?: ProviderPricing,
): number {
  if (modelClass === 'no_llm' || modelClass === 'local_llm' || modelClass === 'free_llm') {
    return 0
  }

  const inputPerMillion = pricing?.costInputPerMillion ?? DEFAULT_COST_BY_CLASS[modelClass]
  const outputPerMillion = pricing?.costOutputPerMillion ?? DEFAULT_COST_BY_CLASS[modelClass] * 3
  return roundMoney((inputTokens / 1_000_000) * inputPerMillion + (outputTokens / 1_000_000) * outputPerMillion)
}

export function modelClassRank(modelClass: ModelClass): number {
  return MODEL_ORDER.balanced.indexOf(modelClass)
}

function buildDecision(
  selectedModelClass: ModelClass,
  requiresHumanApproval: boolean,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
  reasons: string[],
  escalationRules: string[],
): RoutingDecision {
  return {
    selectedModelClass,
    requiresHumanApproval,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostEuro: estimateRunCostEuro(selectedModelClass, estimatedInputTokens, estimatedOutputTokens),
    reasons,
    escalationRules,
  }
}

function estimateInputTokens(contextNeed: string): number {
  if (contextNeed === 'high') return 16_000
  if (contextNeed === 'medium') return 8_000
  return 2_500
}

function estimateOutputTokens(complexity: string): number {
  if (complexity === 'critical') return 8_000
  if (complexity === 'complex') return 6_000
  if (complexity === 'medium') return 3_000
  if (complexity === 'small') return 1_500
  return 700
}

function roundMoney(value: number): number {
  return Math.round(value * 100_000) / 100_000
}

export function defaultAvailability(overrides: Partial<ModelAvailability> = {}): ModelAvailability {
  return {
    localAvailable: true,
    freeQuotaAvailable: true,
    cheapApiAvailable: true,
    premiumAllowed: false,
    previousCheapFailures: 0,
    ...overrides,
  }
}
