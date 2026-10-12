export interface UsageCall {
  kind: 'orchestrator' | 'local'
  provider: string
  model: string
  purpose: string
  status: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  tokensMeasured: boolean
  /** Real money charged (API-key billing only). */
  actualApiCostUsd?: number | null
  /** API list-price equivalent reported by the CLI (e.g. Claude Code total_cost_usd). */
  apiEquivalentUsd?: number | null
  billing: string
  peakMemoryMb?: number | null
}

export interface PriceOverride {
  /** USD per million input / output tokens for the premium provider, entered by the user. */
  inputPerMillion: number
  outputPerMillion: number
  source: string
}

export interface UsageSummary {
  premium: {
    calls: number
    failedCalls: number
    byPurpose: Record<string, number>
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    /** Calls whose token counts were reported by the CLI. */
    measuredCalls: number
    unmeasuredCalls: number
    apiEquivalentUsd: { value: number; basis: 'reported' | 'mixed' | 'none'; reportedCalls: number }
    durationMs: number
  }
  local: {
    calls: number
    failedCalls: number
    inputTokens: number
    outputTokens: number
    durationMs: number
    peakMemoryMb?: number
    byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; durationMs: number }>
    energyWh?: { value: number; assumptionWatts: number; label: string }
  }
  spend: {
    /** Money actually charged by an API (API-key billing). 0 under subscriptions. */
    actualUsd: number
    actualBasis: string
  }
  baseline?: {
    label: string
    method: string
    /** Estimated API-list-price cost had the premium model processed the local tokens too. */
    localTokensAtPremiumPriceUsd: number
    effectiveInputPerMillion: number
    effectiveOutputPerMillion: number
    estimate: true
  }
  notes: string[]
}

/**
 * Aggregates model usage. Measured values and estimates are kept apart; a savings baseline is
 * only produced from prices the premium CLI itself reported (or a user-entered price), never invented.
 */
export function summarizeUsage(calls: UsageCall[], options: { priceOverride?: PriceOverride; gpuWatts?: number } = {}): UsageSummary {
  const premiumCalls = calls.filter((call) => call.kind === 'orchestrator')
  const localCalls = calls.filter((call) => call.kind === 'local')
  const notes: string[] = []

  const reported = premiumCalls.filter((call) => typeof call.apiEquivalentUsd === 'number')
  const reportedUsd = reported.reduce((sum, call) => sum + Number(call.apiEquivalentUsd ?? 0), 0)
  const byPurpose: Record<string, number> = {}
  for (const call of premiumCalls) byPurpose[call.purpose] = (byPurpose[call.purpose] ?? 0) + 1

  const byModel: UsageSummary['local']['byModel'] = {}
  for (const call of localCalls) {
    const entry = (byModel[call.model] ??= { calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 })
    entry.calls += 1
    entry.inputTokens += call.inputTokens
    entry.outputTokens += call.outputTokens
    entry.durationMs += call.durationMs
  }
  const localDuration = localCalls.reduce((sum, call) => sum + call.durationMs, 0)
  const peaks = localCalls.map((call) => call.peakMemoryMb ?? 0).filter((value) => value > 0)

  const summary: UsageSummary = {
    premium: {
      calls: premiumCalls.length,
      failedCalls: premiumCalls.filter((call) => call.status !== 'ok').length,
      byPurpose,
      inputTokens: premiumCalls.reduce((sum, call) => sum + call.inputTokens, 0),
      outputTokens: premiumCalls.reduce((sum, call) => sum + call.outputTokens, 0),
      cachedInputTokens: premiumCalls.reduce((sum, call) => sum + call.cachedInputTokens, 0),
      measuredCalls: premiumCalls.filter((call) => call.tokensMeasured).length,
      unmeasuredCalls: premiumCalls.filter((call) => !call.tokensMeasured).length,
      apiEquivalentUsd: {
        value: round(reportedUsd),
        basis: reported.length === 0 ? 'none' : reported.length === premiumCalls.filter((call) => call.status === 'ok').length ? 'reported' : 'mixed',
        reportedCalls: reported.length,
      },
      durationMs: premiumCalls.reduce((sum, call) => sum + call.durationMs, 0),
    },
    local: {
      calls: localCalls.length,
      failedCalls: localCalls.filter((call) => call.status !== 'ok').length,
      inputTokens: localCalls.reduce((sum, call) => sum + call.inputTokens, 0),
      outputTokens: localCalls.reduce((sum, call) => sum + call.outputTokens, 0),
      durationMs: localDuration,
      peakMemoryMb: peaks.length ? Math.max(...peaks) : undefined,
      byModel,
    },
    spend: {
      actualUsd: round(calls.reduce((sum, call) => sum + Number(call.actualApiCostUsd ?? 0), 0)),
      actualBasis: calls.some((call) => call.billing === 'api_key')
        ? 'Includes API-key billed calls as reported by the provider CLI.'
        : 'All premium calls ran under a subscription; no per-token charges were incurred.',
    },
    notes,
  }

  if (options.gpuWatts && options.gpuWatts > 0 && localDuration > 0) {
    summary.local.energyWh = {
      value: round((localDuration / 3_600_000) * options.gpuWatts, 2),
      assumptionWatts: options.gpuWatts,
      label: `Estimate: inference time × ${options.gpuWatts} W (configured), not a measurement.`,
    }
  }

  // Savings baseline from reported prices only.
  const tokenTotals = reported.reduce(
    (acc, call) => ({ input: acc.input + call.inputTokens, output: acc.output + call.outputTokens }),
    { input: 0, output: 0 },
  )
  let inputPerMillion: number | undefined
  let outputPerMillion: number | undefined
  let method = ''
  if (options.priceOverride) {
    inputPerMillion = options.priceOverride.inputPerMillion
    outputPerMillion = options.priceOverride.outputPerMillion
    method = `User-entered list price (${options.priceOverride.source}).`
  } else if (reported.length && tokenTotals.input + tokenTotals.output > 0) {
    // Blended effective price observed on this machine: reported USD / reported tokens,
    // split with the conventional 1:5 input:output ratio of current premium list prices.
    const blendedPerToken = reportedUsd / (tokenTotals.input + 5 * tokenTotals.output)
    inputPerMillion = blendedPerToken * 1_000_000
    outputPerMillion = blendedPerToken * 5 * 1_000_000
    method = `Effective price derived from ${reported.length} premium call(s) whose cost the CLI reported (input:output weighted 1:5).`
  }
  if (inputPerMillion !== undefined && outputPerMillion !== undefined && summary.local.inputTokens + summary.local.outputTokens > 0) {
    summary.baseline = {
      label: 'Estimated API-equivalent cost of the locally processed tokens',
      method,
      localTokensAtPremiumPriceUsd: round((summary.local.inputTokens / 1_000_000) * inputPerMillion + (summary.local.outputTokens / 1_000_000) * outputPerMillion),
      effectiveInputPerMillion: round(inputPerMillion, 4),
      effectiveOutputPerMillion: round(outputPerMillion, 4),
      estimate: true,
    }
    notes.push('The baseline assumes the premium model would have needed the same number of tokens as the local models; real usage could differ in both directions.')
  } else if (summary.local.calls) {
    notes.push('No savings baseline: no premium call reported a price and no price was configured.')
  }
  if (summary.premium.unmeasuredCalls) notes.push(`${summary.premium.unmeasuredCalls} premium call(s) failed before reporting token usage.`)
  return summary
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
