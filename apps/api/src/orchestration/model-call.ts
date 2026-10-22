import { bookableCalls, OrchestratorError, type CallMeta } from '@multi-ai-coder/engine'
import { Prisma } from '@prisma/client'

/**
 * ModelCall fields for a failed orchestrator call. A call that completed but was rejected (invalid
 * output, error_max_turns, …) carries its usage in `error.details.meta` – it still used the quota.
 */
export function failedCallFields(error: unknown, fallbackModel: string) {
  const meta = error instanceof OrchestratorError ? error.details.meta : undefined
  return usageFields(meta, fallbackModel)
}

function usageFields(meta: CallMeta | undefined, fallbackModel: string) {
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

/** Fields of a ModelCall row that the booking site decides (the rest comes from the call's meta). */
export interface ModelCallBase {
  kind: string
  purpose: string
  status: 'ok' | 'error'
  errorClass?: string
  /** Duration of a single call; a duo part keeps its own. */
  durationMs: number
  executionId?: string
  subtaskId?: string | null
  /** Used when the meta has no billing (e.g. a failure without usage). */
  billing?: string
}

/**
 * ModelCall rows for one orchestrator request: one row per duo part (each with its own provider, status and
 * usage), otherwise exactly one row for `provider`.
 */
export function modelCallRows(provider: string, meta: CallMeta | undefined, base: ModelCallBase) {
  return bookableCalls(provider, meta, base.status, base.errorClass).map((entry) => {
    const fields = usageFields(entry.meta, entry.provider)
    return {
      ...base,
      provider: entry.provider,
      status: entry.status,
      errorClass: entry.errorClass,
      durationMs: entry.durationMs ?? base.durationMs,
      ...fields,
      billing: fields.billing ?? base.billing,
    }
  })
}

/** Rows for a failed request: the usage of every completed call is in the error meta (duo: one row per part). */
export function failedCallRows(provider: string, error: unknown, base: Omit<ModelCallBase, 'status' | 'errorClass'> & { errorClass?: string }) {
  const meta = error instanceof OrchestratorError ? error.details.meta : undefined
  return modelCallRows(provider, meta, { ...base, status: 'error', errorClass: base.errorClass ?? (error as { kind?: string } | undefined)?.kind })
}
