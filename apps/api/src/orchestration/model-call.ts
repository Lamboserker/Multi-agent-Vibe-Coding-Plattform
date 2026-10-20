import { OrchestratorError } from '@multi-ai-coder/engine'
import { Prisma } from '@prisma/client'

/**
 * ModelCall fields for a failed orchestrator call. A call that completed but was rejected (invalid
 * output, error_max_turns, …) carries its usage in `error.details.meta` – it still used the quota.
 */
export function failedCallFields(error: unknown, fallbackModel: string) {
  const meta = error instanceof OrchestratorError ? error.details.meta : undefined
  return {
    model: meta?.model ?? fallbackModel,
    sessionId: meta?.sessionId,
    inputTokens: meta?.usage.inputTokens ?? 0,
    outputTokens: meta?.usage.outputTokens ?? 0,
    cachedInputTokens: meta?.usage.cachedInputTokens ?? 0,
    tokensMeasured: meta?.usage.measured ?? false,
    apiEquivalentUsd: meta?.usage.apiEquivalentUsd === undefined ? undefined : new Prisma.Decimal(meta.usage.apiEquivalentUsd),
    // without meta the column default applies, as before
    billing: meta?.usage.billing,
  }
}
