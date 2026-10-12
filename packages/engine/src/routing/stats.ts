/** Outcome of one model attempt, as recorded by the engine after deterministic validation. */
export interface AttemptRecord {
  model: string
  category: string
  /** success = patch passed validation without escalation beyond this model. */
  outcome: 'success' | 'validation_failed' | 'invalid_patch' | 'no_changes' | 'error' | 'timeout'
  repairRound: number
  durationMs: number
  escalated: boolean
}

export interface SuitabilityStats {
  model: string
  category: string
  attempts: number
  successes: number
  failures: number
  repairRate: number
  escalationRate: number
  avgDurationMs: number
  /** Observed success rate (successes / attempts). */
  successRate: number
  /** Wilson score lower bound (90%) – conservative estimate that accounts for sample size. */
  lowerBound: number
  confidence: 'insufficient_data' | 'low' | 'medium' | 'high'
}

export const MIN_SAMPLES = 5

/** Wilson score interval lower bound; 0 for n = 0. z = 1.645 (90%). */
export function wilsonLowerBound(successes: number, n: number, z = 1.645): number {
  if (n <= 0) return 0
  const p = successes / n
  const denominator = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return Math.max(0, (centre - margin) / denominator)
}

export function confidenceLabel(lowerBound: number, attempts: number): SuitabilityStats['confidence'] {
  if (attempts < MIN_SAMPLES) return 'insufficient_data'
  if (lowerBound >= 0.7) return 'high'
  if (lowerBound >= 0.45) return 'medium'
  return 'low'
}

/** Aggregates attempt records per (model, category). Only first attempts per task count towards success. */
export function aggregateSuitability(records: AttemptRecord[]): SuitabilityStats[] {
  const groups = new Map<string, AttemptRecord[]>()
  for (const record of records) {
    const key = `${record.model}\u0000${record.category}`
    groups.set(key, [...(groups.get(key) ?? []), record])
  }
  const stats: SuitabilityStats[] = []
  for (const [key, group] of groups) {
    const [model, category] = key.split('\u0000') as [string, string]
    const attempts = group.length
    const successes = group.filter((record) => record.outcome === 'success').length
    const lowerBound = wilsonLowerBound(successes, attempts)
    stats.push({
      model,
      category,
      attempts,
      successes,
      failures: attempts - successes,
      repairRate: group.filter((record) => record.repairRound > 0).length / attempts,
      escalationRate: group.filter((record) => record.escalated).length / attempts,
      avgDurationMs: Math.round(group.reduce((sum, record) => sum + record.durationMs, 0) / attempts),
      successRate: successes / attempts,
      lowerBound,
      confidence: confidenceLabel(lowerBound, attempts),
    })
  }
  return stats.sort((a, b) => a.model.localeCompare(b.model) || a.category.localeCompare(b.category))
}

export function lookupStats(stats: SuitabilityStats[], model: string, category: string): SuitabilityStats | undefined {
  return stats.find((entry) => entry.model === model && entry.category === category)
}
