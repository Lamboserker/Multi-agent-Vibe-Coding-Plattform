import { lookupStats, MIN_SAMPLES, type SuitabilityStats } from './stats.js'

export type CostMode = 'cheapest' | 'balanced' | 'quality'
export type LocalRole = 'fast' | 'balanced' | 'advanced'
export type ExecutorTier = LocalRole | 'premium'

const TIER_ORDER: ExecutorTier[] = ['fast', 'balanced', 'advanced', 'premium']

export interface LocalModelProfile {
  model: string
  roles: LocalRole[]
  toolCalling: boolean
  contextWindow: number
  available: boolean
}

export interface RoutableTask {
  id: string
  category: string
  complexity: number
  risk: number
  expectedInputTokens: number
  suggestedExecutor: 'local' | 'premium'
  securityCritical: boolean
  /** User override from the UI ("Modell wechseln" / "Task manuell zuweisen"). */
  manualModel?: string
}

export interface RouterPolicy {
  costMode: CostMode
  premiumAvailable: boolean
  /** Whether premium execution (not only planning/review) may be used for implementation tasks. */
  premiumExecutionAllowed: boolean
}

export interface RouteDecision {
  executor: 'local' | 'premium' | 'blocked'
  model?: string
  tier: ExecutorTier
  reasons: string[]
  /** Ordered escalation path tried after failures (bounded; ends with premium if allowed). */
  escalation: Array<{ executor: 'local' | 'premium'; model?: string; tier: ExecutorTier }>
  stats?: SuitabilityStats
  requiresApproval: boolean
}

const SECURITY_CATEGORIES = new Set(['auth-security', 'database-migration'])

/** Base tier from task properties (complexity drives the choice, not model size). */
export function baseTier(task: RoutableTask): { tier: ExecutorTier; reason: string } {
  if (task.risk >= 4 || task.securityCritical || SECURITY_CATEGORIES.has(task.category)) {
    return { tier: 'premium', reason: `High risk (${task.risk}/5${task.securityCritical ? ', security-critical files' : ''}, category ${task.category}).` }
  }
  if (task.complexity >= 5) return { tier: 'premium', reason: 'Complexity 5/5.' }
  if (task.complexity === 4) return { tier: 'advanced', reason: 'Complexity 4/5 needs the strongest local model.' }
  if (task.complexity === 3 || task.risk === 3) return { tier: 'balanced', reason: `Moderate complexity/risk (${task.complexity}/${task.risk}).` }
  return { tier: 'fast', reason: `Simple task (complexity ${task.complexity}, risk ${task.risk}).` }
}

function shift(tier: ExecutorTier, delta: number): ExecutorTier {
  const index = Math.min(TIER_ORDER.length - 1, Math.max(0, TIER_ORDER.indexOf(tier) + delta))
  return TIER_ORDER[index]!
}

function modelsForTier(models: LocalModelProfile[], tier: LocalRole): LocalModelProfile[] {
  return models.filter((model) => model.available && model.roles.includes(tier))
}

/**
 * Selects executor and model for a task. Combines complexity/risk, cost mode, the orchestrator's
 * suggestion, installed models, context size and measured per-category success statistics.
 */
export function routeTask(task: RoutableTask, models: LocalModelProfile[], policy: RouterPolicy, stats: SuitabilityStats[] = []): RouteDecision {
  const reasons: string[] = []
  const available = models.filter((model) => model.available)

  if (task.manualModel) {
    if (task.manualModel === 'premium') {
      return {
        executor: policy.premiumAvailable ? 'premium' : 'blocked',
        tier: 'premium',
        reasons: ['Manually assigned to the premium orchestrator.'],
        escalation: [],
        requiresApproval: false,
      }
    }
    const manual = available.find((model) => model.model === task.manualModel)
    if (manual) {
      return {
        executor: 'local',
        model: manual.model,
        tier: manual.roles[manual.roles.length - 1] ?? 'balanced',
        reasons: [`Manually assigned to ${manual.model}.`],
        escalation: policy.premiumAvailable && policy.premiumExecutionAllowed ? [{ executor: 'premium', tier: 'premium' }] : [],
        requiresApproval: false,
      }
    }
    reasons.push(`Manually assigned model ${task.manualModel} is not available; using automatic routing.`)
  }

  const base = baseTier(task)
  let tier = base.tier
  reasons.push(base.reason)

  if (task.suggestedExecutor === 'premium' && tier !== 'premium') {
    if (policy.costMode === 'cheapest') reasons.push('Orchestrator suggested premium; cost mode "cheapest" keeps it local.')
    else {
      tier = policy.costMode === 'quality' ? 'premium' : shift(tier, 1)
      reasons.push(`Orchestrator suggested premium execution → ${tier}.`)
    }
  }
  if (policy.costMode === 'quality' && tier !== 'premium' && task.complexity >= 3) {
    tier = shift(tier, 1)
    reasons.push('Quality mode raises the tier by one.')
  } else if (policy.costMode === 'quality' && tier === 'fast') {
    tier = 'balanced'
    reasons.push('Quality mode does not use the fast tier for implementation tasks.')
  }
  if (policy.costMode === 'cheapest' && tier === 'premium' && task.risk < 4 && task.complexity < 5) {
    tier = 'advanced'
    reasons.push('Cheapest mode keeps non-critical work on local models.')
  }

  // Adaptive adjustment from measured outcomes in this category.
  if (tier !== 'premium') {
    const lower = TIER_ORDER.slice(0, TIER_ORDER.indexOf(tier)) as LocalRole[]
    for (const candidateTier of lower) {
      const proven = modelsForTier(available, candidateTier).find((model) => {
        const entry = lookupStats(stats, model.model, task.category)
        return entry && entry.attempts >= MIN_SAMPLES && entry.confidence === 'high'
      })
      if (proven && task.risk <= 2) {
        const entry = lookupStats(stats, proven.model, task.category)!
        reasons.push(`${proven.model} has proven itself on "${task.category}" (${entry.successes}/${entry.attempts}, lower bound ${(entry.lowerBound * 100).toFixed(0)}%) → ${candidateTier}.`)
        tier = candidateTier
        break
      }
    }
  }

  // Pick a concrete model for the tier, upgrading if unavailable, weak or context too small.
  let decision: RouteDecision | undefined
  for (let index = TIER_ORDER.indexOf(tier); index < TIER_ORDER.length; index += 1) {
    const candidateTier = TIER_ORDER[index]!
    if (candidateTier === 'premium') break
    const candidates = modelsForTier(available, candidateTier)
      .filter((model) => model.contextWindow === 0 || task.expectedInputTokens <= model.contextWindow * 0.6)
      .sort((a, b) => scoreModel(b, task, stats) - scoreModel(a, task, stats) || timePerValidatedChange(a, task, stats) - timePerValidatedChange(b, task, stats))
    const weak = candidates.filter((model) => {
      const entry = lookupStats(stats, model.model, task.category)
      return entry && entry.attempts >= MIN_SAMPLES && entry.confidence === 'low'
    })
    const usable = candidates.filter((model) => !weak.includes(model))
    if (weak.length && !usable.length) {
      const entry = lookupStats(stats, weak[0]!.model, task.category)!
      reasons.push(`${weak[0]!.model} fails often on "${task.category}" (${entry.successes}/${entry.attempts}) → trying a stronger tier.`)
      continue
    }
    const chosen = usable[0]
    if (!chosen) {
      if (modelsForTier(available, candidateTier).length) reasons.push(`Expected context (~${task.expectedInputTokens} tokens) exceeds the ${candidateTier} model's window.`)
      else reasons.push(`No installed model has the "${candidateTier}" role.`)
      continue
    }
    const entry = lookupStats(stats, chosen.model, task.category)
    if (index !== TIER_ORDER.indexOf(tier)) reasons.push(`Upgraded to ${candidateTier}.`)
    reasons.push(
      entry
        ? `${chosen.model} on "${task.category}": ${entry.successes}/${entry.attempts} successful (${entry.confidence === 'insufficient_data' ? 'insufficient data' : `confidence ${entry.confidence}`}).`
        : `${chosen.model}: no history for "${task.category}" yet (insufficient data).`,
    )
    decision = { executor: 'local', model: chosen.model, tier: candidateTier, reasons, escalation: [], stats: entry, requiresApproval: false }
    break
  }

  if (!decision) {
    if (policy.premiumAvailable && (policy.premiumExecutionAllowed || tier === 'premium')) {
      decision = { executor: 'premium', tier: 'premium', reasons, escalation: [], requiresApproval: !policy.premiumExecutionAllowed }
      if (!policy.premiumExecutionAllowed) reasons.push('Premium execution needs approval in the current settings.')
    } else {
      const fallback = [...available].sort((a, b) => TIER_ORDER.indexOf(b.roles.at(-1) ?? 'fast') - TIER_ORDER.indexOf(a.roles.at(-1) ?? 'fast'))[0]
      if (fallback) {
        reasons.push(`Premium is not available; using the strongest local model ${fallback.model}. Human review required.`)
        decision = { executor: 'local', model: fallback.model, tier: fallback.roles.at(-1) ?? 'advanced', reasons, escalation: [], requiresApproval: true }
      } else {
        reasons.push('No local model installed and no premium orchestrator available.')
        return { executor: 'blocked', tier, reasons, escalation: [], requiresApproval: true }
      }
    }
  }

  // Escalation chain: stronger local model (one), then premium.
  if (decision.executor === 'local') {
    const currentIndex = TIER_ORDER.indexOf(decision.tier)
    for (let index = currentIndex + 1; index < TIER_ORDER.length - 1; index += 1) {
      const stronger = modelsForTier(available, TIER_ORDER[index] as LocalRole).find((model) => model.model !== decision!.model)
      if (stronger) {
        decision.escalation.push({ executor: 'local', model: stronger.model, tier: TIER_ORDER[index]! })
        break
      }
    }
    if (policy.premiumAvailable) decision.escalation.push({ executor: 'premium', tier: 'premium' })
  }
  return decision
}

function scoreModel(model: LocalModelProfile, task: RoutableTask, stats: SuitabilityStats[]): number {
  const entry = lookupStats(stats, model.model, task.category)
  // Prefer measured performance when sufficient; tool calling helps multi-step edits.
  const measured = entry && entry.attempts >= MIN_SAMPLES ? entry.lowerBound * 10 : 0
  return measured + (model.toolCalling ? 2 : 0)
}

/** Tie-break equally reliable models by time spent per validated result, including failures. */
function timePerValidatedChange(model: LocalModelProfile, task: RoutableTask, stats: SuitabilityStats[]): number {
  const entry = lookupStats(stats, model.model, task.category)
  return entry && entry.attempts >= MIN_SAMPLES && entry.successRate > 0 && entry.avgDurationMs > 0
    ? entry.avgDurationMs / entry.successRate : Number.MAX_SAFE_INTEGER
}
