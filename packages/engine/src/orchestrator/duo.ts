import { DESIGN_SYSTEM_PROMPT, reconcileDesignPrompt } from './design-prompt.js'
import { reconcilePlanPrompt } from './prompts.js'
import { DESIGN_SCHEMA, normalizeDesignDraft, normalizeReconciledPlan, RECONCILE_PLAN_SCHEMA } from './schemas.js'
import {
  mergeCallMeta,
  normalizeWithMeta,
  OrchestratorError,
  type AnalysisInput,
  type CallContext,
  type CallMeta,
  type CallMetaPart,
  type ChatInput,
  type ChatResult,
  type ConnectionResult,
  type ConnectionStatus,
  type DesignDraft,
  type DesignInput,
  type DiagnosticReport,
  type DuoInfo,
  type DuoPhase,
  type DuoRole,
  type ExecutionInput,
  type ExecutionPlan,
  type OrchestratorAdapter,
  type OrchestratorCapabilities,
  type OrchestratorEvent,
  type OrchestratorId,
  type PlanningInput,
  type RepairHint,
  type RepairHintInput,
  type ReviewInput,
  type ReviewIssue,
  type ReviewResult,
  type RuntimeDetection,
  type StructuredRequest,
  type UsageReport,
} from './types.js'

const ZERO_USAGE: UsageReport = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, measured: false, billing: 'unknown' }

type Settled<T> =
  | { adapter: OrchestratorAdapter; ok: true; result: T; meta: CallMeta; part: CallMetaPart }
  | { adapter: OrchestratorAdapter; ok: false; error: unknown; part: CallMetaPart }

function errorKind(error: unknown): string {
  return error instanceof OrchestratorError ? error.kind : 'process_failed'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function okPart(provider: OrchestratorId, role: DuoRole, meta: CallMeta): CallMetaPart {
  const { parts: _parts, duo: _duo, ...call } = meta
  return { ...call, provider, role, status: 'ok' }
}

/** A failed call still counts: a completed but rejected answer carries its usage in the error meta. */
function errorPart(provider: OrchestratorId, role: DuoRole, error: unknown, started: number): CallMetaPart {
  const meta = error instanceof OrchestratorError ? error.details.meta : undefined
  const { parts: _parts, duo: _duo, ...call } = meta ?? { usage: ZERO_USAGE, durationMs: Date.now() - started }
  return { ...call, provider, role, status: 'error', errorClass: errorKind(error) }
}

/** Runs one side's call; never rejects (the duo decides what a failure means). */
async function settle<T>(adapter: OrchestratorAdapter, role: DuoRole, run: () => Promise<{ result: T; meta: CallMeta }>): Promise<Settled<T>> {
  const started = Date.now()
  try {
    const { result, meta } = await run()
    return { adapter, ok: true, result, meta, part: okPart(adapter.id, role, meta) }
  } catch (error) {
    return { adapter, ok: false, error, part: errorPart(adapter.id, role, error, started) }
  }
}

/**
 * Top-level meta of a duo request: summed usage of all parts (each part is booked on its own), the wall-clock
 * duration, and the session of the side whose result is used (the lead's session stays `meta.sessionId`).
 */
export function combineDuoMeta(parts: CallMetaPart[], started: number, session?: CallMetaPart, duo?: DuoInfo): CallMeta {
  const total = parts.reduce<CallMeta | undefined>((sum, { provider: _provider, role: _role, status: _status, errorClass: _error, ...call }) => mergeCallMeta(sum, call), undefined)
  return {
    sessionId: session?.sessionId,
    model: session?.model ?? total?.model,
    usage: total?.usage ?? ZERO_USAGE,
    durationMs: Date.now() - started,
    parts,
    ...(duo ? { duo } : {}),
  }
}

function clip(text: string, maxChars = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1).trimEnd()}…` : flat
}

const VERDICT_RANK: Record<ReviewResult['verdict'], number> = { approve: 0, request_changes: 1, reject: 2 }
const SEVERITY_RANK: Record<ReviewIssue['severity'], number> = { minor: 0, major: 1, blocker: 2 }
const CONFIDENCE_RANK: Record<RepairHint['confidence'], number> = { low: 0, medium: 1, high: 2 }

const normalizedText = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 160)
const normalizedFile = (file: string) => file.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

/**
 * Deterministic merge of two reviews (no third call): the stricter verdict and the lower score win, issues and
 * required fixes are united (duplicates by file + message; the higher severity is kept).
 */
export function mergeReviews(first: { label: string; review: ReviewResult }, second: { label: string; review: ReviewResult }): { review: ReviewResult; duplicates: number } {
  const issues = new Map<string, ReviewIssue>()
  let duplicates = 0
  for (const issue of [...first.review.issues, ...second.review.issues]) {
    const key = `${normalizedFile(issue.file)}|${normalizedText(issue.message)}`
    const known = issues.get(key)
    if (!known) issues.set(key, issue)
    else {
      duplicates += 1
      if (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[known.severity]) issues.set(key, { ...known, severity: issue.severity })
    }
  }
  const fixes = new Map<string, string>()
  for (const fix of [...first.review.requiredFixes, ...second.review.requiredFixes]) {
    const key = normalizedText(fix)
    if (key && !fixes.has(key)) fixes.set(key, fix)
  }
  const verdict = VERDICT_RANK[second.review.verdict] > VERDICT_RANK[first.review.verdict] ? second.review.verdict : first.review.verdict
  return {
    review: {
      verdict,
      score: Math.min(first.review.score, second.review.score),
      summary: `${first.label}: ${first.review.summary}\n${second.label}: ${second.review.summary}`,
      issues: [...issues.values()],
      requiredFixes: [...fixes.values()],
    },
    duplicates,
  }
}

/** The more confident hint wins; on a tie the first (the lead's). */
export function chooseRepairHint(first: RepairHint, second: RepairHint): 'first' | 'second' {
  return CONFIDENCE_RANK[second.confidence] > CONFIDENCE_RANK[first.confidence] ? 'second' : 'first'
}

const planSummary = (plan: ExecutionPlan) => clip(`${plan.tasks.length} Task(s): ${plan.summary || plan.tasks.map((task) => task.title).join(', ')}`)
const designSummary = (draft: DesignDraft) => clip(`${draft.designType}, ${draft.components.length} Komponente(n): ${draft.summary}`)
const reviewSummary = (review: ReviewResult) => clip(`${review.verdict} (${review.score}/100): ${review.summary}`)
const hintSummary = (hint: RepairHint) => clip(`${hint.confidence}, ${hint.edits.length} Änderung(en): ${hint.diagnosis}`)

export interface DuoOptions {
  /** Upper bound per proposal in a reconcile prompt (characters). */
  maxProposalChars?: number
}

/**
 * Duo orchestration (ADR-004): lead and partner work on every phase in parallel, then the results are
 * reconciled – plan and design by a third call of the lead, review deterministically, chat shows both answers.
 * If one side fails, the other side's result is used (`meta.duo.fallback`); only when both fail the request
 * fails, with the tokens of both calls in the error meta. Every single call is in `meta.parts` with its provider.
 *
 * `id` is the lead's id so everything keyed by an OrchestratorId (sessions, design provider, routing) keeps
 * working; bookings use `meta.parts`. Premium execution cannot share one worktree: the execution runner
 * detects the duo (`isDuo`) and runs both sides in sibling worktrees; `executeComplexTask` here only delegates
 * to the lead.
 */
export class DuoOrchestrator implements OrchestratorAdapter {
  readonly id: OrchestratorId
  readonly displayName: string
  readonly duo: { lead: OrchestratorId; partner: OrchestratorId }
  readonly createDesign?: (input: DesignInput, ctx: CallContext) => Promise<{ result: DesignDraft; meta: CallMeta }>
  readonly repairHint?: (input: RepairHintInput, ctx: CallContext) => Promise<{ result: RepairHint; meta: CallMeta }>
  readonly structuredCall?: (request: StructuredRequest, ctx: CallContext) => Promise<{ result: unknown; meta: CallMeta }>

  constructor(
    readonly leadAdapter: OrchestratorAdapter,
    readonly partnerAdapter: OrchestratorAdapter,
    private readonly options: DuoOptions = {},
  ) {
    if (leadAdapter.id === partnerAdapter.id) throw new Error(`Duo mode needs two different orchestrators (both are ${leadAdapter.id}).`)
    this.id = leadAdapter.id
    this.displayName = `${leadAdapter.displayName} + ${partnerAdapter.displayName}`
    this.duo = { lead: leadAdapter.id, partner: partnerAdapter.id }
    if (leadAdapter.createDesign || partnerAdapter.createDesign) this.createDesign = (input, ctx) => this.design(input, ctx)
    if (leadAdapter.repairHint || partnerAdapter.repairHint) this.repairHint = (input, ctx) => this.hint(input, ctx)
    if (leadAdapter.structuredCall) this.structuredCall = (request, ctx) => leadAdapter.structuredCall!(request, ctx)
  }

  async detect(): Promise<RuntimeDetection> {
    const [lead, partner] = await Promise.all([this.leadAdapter.detect(), this.partnerAdapter.detect()])
    return { ...lead, installed: lead.installed && partner.installed }
  }

  capabilities(): Promise<OrchestratorCapabilities> {
    return this.leadAdapter.capabilities()
  }

  /** Connected only when both are; the lead's login comes first. */
  async connect(): Promise<ConnectionResult> {
    const lead = await this.leadAdapter.connect()
    if (lead.status !== 'already_connected') return lead
    return this.partnerAdapter.connect()
  }

  async getStatus(): Promise<ConnectionStatus> {
    const [lead, partner] = await Promise.all([this.leadAdapter.getStatus(), this.partnerAdapter.getStatus()])
    return {
      ...lead,
      installed: lead.installed && partner.installed,
      authenticated: lead.authenticated && partner.authenticated,
      usesApiKeyBilling: lead.usesApiKeyBilling || partner.usesApiKeyBilling,
      message: `${this.leadAdapter.displayName}: ${lead.message} · ${this.partnerAdapter.displayName}: ${partner.message}`,
    }
  }

  /** Logging out is a per-CLI decision of the user: only the lead (the configured orchestrator) is logged out. */
  logout(): Promise<void> {
    return this.leadAdapter.logout()
  }

  async diagnose(options?: { liveCall?: boolean; cwd?: string }): Promise<DiagnosticReport> {
    const reports = await Promise.all([this.leadAdapter.diagnose(options), this.partnerAdapter.diagnose(options)])
    const adapters = [this.leadAdapter, this.partnerAdapter]
    return {
      orchestrator: this.id,
      ok: reports.every((report) => report.ok),
      checks: reports.flatMap((report, index) => report.checks.map((check) => ({ ...check, name: `${adapters[index]!.displayName}: ${check.name}` }))),
    }
  }

  /** Analysis is a cheap pre-step: the lead alone. */
  analyzeTask(input: AnalysisInput, ctx: CallContext) {
    return this.leadAdapter.analyzeTask(input, ctx)
  }

  async createPlan(input: PlanningInput, ctx: CallContext): Promise<{ result: ExecutionPlan; meta: CallMeta }> {
    const started = Date.now()
    const sides = await Promise.all([
      settle(this.leadAdapter, 'lead', () => this.leadAdapter.createPlan(input, ctx)),
      settle(this.partnerAdapter, 'partner', () => this.partnerAdapter.createPlan(input, ctx)),
    ])
    const parts = sides.map((side) => side.part)
    this.throwIfCancelled(sides, parts, started)
    const proposals = this.proposals(ctx, 'plan', sides, planSummary)
    const [lead, partner] = sides
    if (!lead.ok && !partner.ok) {
      const questions = [...new Set(sides.flatMap((side) => (!side.ok && side.error instanceof OrchestratorError && side.error.kind === 'needs_clarification' ? side.error.details.questions ?? [] : [])))]
      // both need input (or one does and the other failed): the questions are the useful answer
      if (questions.length) {
        throw new OrchestratorError(`The planners returned no tasks and ask for clarification: ${questions.join('; ')}`, 'needs_clarification', { retryable: false, questions, meta: combineDuoMeta(parts, started, lead.part) })
      }
      throw this.bothFailed(sides, parts, started)
    }
    if (!lead.ok || !partner.ok) {
      const used = (lead.ok ? lead : partner) as Extract<Settled<ExecutionPlan>, { ok: true }>
      const failed = (lead.ok ? partner : lead) as Extract<Settled<ExecutionPlan>, { ok: false }>
      // a side that asked questions instead of planning: its questions stay visible as plan warnings
      const questions = failed.error instanceof OrchestratorError && failed.error.kind === 'needs_clarification' ? failed.error.details.questions ?? [] : []
      const plan = { ...used.result, warnings: [...used.result.warnings, ...questions.map((question) => `${failed.adapter.displayName} asks: ${question}`)] }
      const duo = this.finish(ctx, { phase: 'plan', proposals, notes: [], winner: used.adapter.id, fallback: this.fallbackNote(failed, used) })
      return { result: plan, meta: combineDuoMeta(parts, started, used.part, duo) }
    }
    const reconcile = this.leadAdapter.structuredCall
    if (!reconcile) {
      const duo = this.finish(ctx, { phase: 'plan', proposals, notes: [], winner: lead.adapter.id, fallback: `${this.leadAdapter.displayName} kann Pläne nicht zusammenführen; es gilt sein eigener Plan.` })
      return { result: lead.result, meta: combineDuoMeta(parts, started, lead.part, duo) }
    }
    const merged = await settle(this.leadAdapter, 'reconcile', async () => {
      const prompt = reconcilePlanPrompt(input, [{ label: this.leadAdapter.displayName, plan: lead.result }, { label: this.partnerAdapter.displayName, plan: partner.result }], this.options.maxProposalChars)
      const call = await reconcile.call(this.leadAdapter, { prompt, schema: RECONCILE_PLAN_SCHEMA }, ctx)
      return { result: normalizeWithMeta(call.meta, () => normalizeReconciledPlan(call.result, input.maxTasks)), meta: call.meta }
    })
    parts.push(merged.part)
    if (!merged.ok) {
      if (errorKind(merged.error) === 'cancelled') throw this.withMeta(merged.error, combineDuoMeta(parts, started, lead.part))
      const duo = this.finish(ctx, { phase: 'plan', proposals, notes: [], winner: lead.adapter.id, fallback: `Abgleich durch ${this.leadAdapter.displayName} fehlgeschlagen (${errorKind(merged.error)}); es gilt sein eigener Plan.` })
      return { result: lead.result, meta: combineDuoMeta(parts, started, lead.part, duo) }
    }
    const duo = this.finish(ctx, { phase: 'plan', proposals, notes: merged.result.notes, winner: 'merged' })
    return { result: merged.result.plan, meta: combineDuoMeta(parts, started, lead.part, duo) }
  }

  private async design(input: DesignInput, ctx: CallContext): Promise<{ result: DesignDraft; meta: CallMeta }> {
    const started = Date.now()
    const capable = [this.leadAdapter, this.partnerAdapter].filter((adapter) => typeof adapter.createDesign === 'function')
    if (capable.length === 1) {
      const only = capable[0]!
      const side = await settle(only, only === this.leadAdapter ? 'lead' : 'partner', () => only.createDesign!({ ...input, provider: only.id }, ctx))
      const other = only === this.leadAdapter ? this.partnerAdapter : this.leadAdapter
      if (!side.ok) throw this.withMeta(side.error, combineDuoMeta([side.part], started, side.part))
      const duo = this.finish(ctx, { phase: 'design', proposals: this.proposals(ctx, 'design', [side], designSummary), notes: [], winner: only.id, fallback: `${other.displayName} unterstützt die Design-Phase nicht; es gilt der Entwurf von ${only.displayName}.` })
      return { result: side.result, meta: combineDuoMeta([side.part], started, side.part, duo) }
    }
    const sides = await Promise.all([
      settle(this.leadAdapter, 'lead', () => this.leadAdapter.createDesign!({ ...input, provider: this.leadAdapter.id }, ctx)),
      settle(this.partnerAdapter, 'partner', () => this.partnerAdapter.createDesign!({ ...input, provider: this.partnerAdapter.id }, ctx)),
    ])
    const parts = sides.map((side) => side.part)
    this.throwIfCancelled(sides, parts, started)
    const proposals = this.proposals(ctx, 'design', sides, designSummary)
    const [lead, partner] = sides
    if (!lead.ok && !partner.ok) throw this.bothFailed(sides, parts, started)
    if (!lead.ok || !partner.ok) {
      const used = (lead.ok ? lead : partner) as Extract<Settled<DesignDraft>, { ok: true }>
      const failed = (lead.ok ? partner : lead) as Extract<Settled<DesignDraft>, { ok: false }>
      const duo = this.finish(ctx, { phase: 'design', proposals, notes: [], winner: used.adapter.id, fallback: this.fallbackNote(failed, used) })
      return { result: used.result, meta: combineDuoMeta(parts, started, used.part, duo) }
    }
    const reconcile = this.leadAdapter.structuredCall
    if (!reconcile) {
      const duo = this.finish(ctx, { phase: 'design', proposals, notes: [], winner: lead.adapter.id, fallback: `${this.leadAdapter.displayName} kann Entwürfe nicht zusammenführen; es gilt sein eigener Entwurf.` })
      return { result: lead.result, meta: combineDuoMeta(parts, started, lead.part, duo) }
    }
    const merged = await settle(this.leadAdapter, 'reconcile', async () => {
      const prompt = reconcileDesignPrompt({ ...input, provider: this.leadAdapter.id }, [{ label: this.leadAdapter.displayName, draft: lead.result }, { label: this.partnerAdapter.displayName, draft: partner.result }], this.options.maxProposalChars)
      const call = await reconcile.call(this.leadAdapter, { prompt, schema: DESIGN_SCHEMA, systemPrompt: DESIGN_SYSTEM_PROMPT }, ctx)
      return { result: normalizeWithMeta(call.meta, () => normalizeDesignDraft(call.result)), meta: call.meta }
    })
    parts.push(merged.part)
    if (!merged.ok) {
      if (errorKind(merged.error) === 'cancelled') throw this.withMeta(merged.error, combineDuoMeta(parts, started, lead.part))
      const duo = this.finish(ctx, { phase: 'design', proposals, notes: [], winner: lead.adapter.id, fallback: `Abgleich durch ${this.leadAdapter.displayName} fehlgeschlagen (${errorKind(merged.error)}); es gilt sein eigener Entwurf.` })
      return { result: lead.result, meta: combineDuoMeta(parts, started, lead.part, duo) }
    }
    const duo = this.finish(ctx, { phase: 'design', proposals, notes: [], winner: 'merged' })
    return { result: merged.result, meta: combineDuoMeta(parts, started, lead.part, duo) }
  }

  async reviewResult(input: ReviewInput, ctx: CallContext): Promise<{ result: ReviewResult; meta: CallMeta }> {
    const started = Date.now()
    const sides = await Promise.all([
      settle(this.leadAdapter, 'lead', () => this.leadAdapter.reviewResult(input, ctx)),
      settle(this.partnerAdapter, 'partner', () => this.partnerAdapter.reviewResult(input, ctx)),
    ])
    const parts = sides.map((side) => side.part)
    this.throwIfCancelled(sides, parts, started)
    const proposals = this.proposals(ctx, 'review', sides, reviewSummary)
    const [lead, partner] = sides
    if (!lead.ok && !partner.ok) throw this.bothFailed(sides, parts, started)
    if (!lead.ok || !partner.ok) {
      const used = (lead.ok ? lead : partner) as Extract<Settled<ReviewResult>, { ok: true }>
      const failed = (lead.ok ? partner : lead) as Extract<Settled<ReviewResult>, { ok: false }>
      const duo = this.finish(ctx, { phase: 'review', proposals, notes: [], winner: used.adapter.id, fallback: this.fallbackNote(failed, used) })
      return { result: used.result, meta: combineDuoMeta(parts, started, used.part, duo) }
    }
    const { review, duplicates } = mergeReviews({ label: this.leadAdapter.displayName, review: lead.result }, { label: this.partnerAdapter.displayName, review: partner.result })
    const notes = [
      `Es gilt das strengere Urteil: ${review.verdict} (${review.score}/100).`,
      `${review.issues.length} Befund(e) vereint${duplicates ? `, ${duplicates} doppelte zusammengefasst` : ''}.`,
    ]
    const duo = this.finish(ctx, { phase: 'review', proposals, notes, winner: 'merged' })
    return { result: review, meta: combineDuoMeta(parts, started, lead.part, duo) }
  }

  private async hint(input: RepairHintInput, ctx: CallContext): Promise<{ result: RepairHint; meta: CallMeta }> {
    const started = Date.now()
    const capable = [this.leadAdapter, this.partnerAdapter].filter((adapter) => typeof adapter.repairHint === 'function')
    const sides = await Promise.all(capable.map((adapter) => settle(adapter, adapter === this.leadAdapter ? 'lead' : 'partner', () => adapter.repairHint!(input, ctx))))
    const parts = sides.map((side) => side.part)
    this.throwIfCancelled(sides, parts, started)
    const proposals = this.proposals(ctx, 'repair_hint', sides, hintSummary)
    const ok = sides.filter((side): side is Extract<Settled<RepairHint>, { ok: true }> => side.ok)
    if (!ok.length) throw this.bothFailed(sides, parts, started)
    const failed = sides.find((side): side is Extract<Settled<RepairHint>, { ok: false }> => !side.ok)
    // sides are in lead, partner order, so a tie keeps the lead's hint
    const used = ok.length === 2 && chooseRepairHint(ok[0]!.result, ok[1]!.result) === 'second' ? ok[1]! : ok[0]!
    const fallback = failed ? this.fallbackNote(failed, used) : capable.length === 1 ? `Nur ${used.adapter.displayName} liefert Reparaturhinweise.` : undefined
    const notes = ok.length === 2 ? [`Es gilt der Hinweis von ${used.adapter.displayName} (Konfidenz ${used.result.confidence}).`] : []
    const duo = this.finish(ctx, { phase: 'repair_hint', proposals, notes, winner: used.adapter.id, ...(fallback ? { fallback } : {}) })
    return { result: used.result, meta: combineDuoMeta(parts, started, used.part, duo) }
  }

  /**
   * Both answer; no reconciliation (it would cost a third call). The lead's answer is `answer`, the partner's
   * is in `duo`. Each CLI resumes its own session: the lead `resumeSessionId`, the partner `partnerResumeSessionId`.
   */
  async chat(input: ChatInput, ctx: CallContext): Promise<{ result: ChatResult; meta: CallMeta }> {
    const started = Date.now()
    const { partnerResumeSessionId, ...leadInput } = input
    const sides = await Promise.all([
      settle(this.leadAdapter, 'lead', () => this.leadAdapter.chat(leadInput, ctx)),
      settle(this.partnerAdapter, 'partner', () => this.partnerAdapter.chat({ ...leadInput, resumeSessionId: partnerResumeSessionId }, ctx)),
    ])
    const parts = sides.map((side) => side.part)
    this.throwIfCancelled(sides, parts, started)
    const proposals = this.proposals(ctx, 'chat', sides, (result) => clip(result.answer))
    const [lead, partner] = sides
    if (!lead.ok && !partner.ok) throw this.bothFailed(sides, parts, started)
    if (!lead.ok && partner.ok) {
      const duo = this.finish(ctx, { phase: 'chat', proposals, notes: [], winner: partner.adapter.id, fallback: this.fallbackNote(lead, partner) })
      // no session: the partner's session id must not be stored as the lead's (the part keeps it)
      return { result: { answer: partner.result.answer }, meta: combineDuoMeta(parts, started, undefined, duo) }
    }
    const leadOk = lead as Extract<Settled<ChatResult>, { ok: true }>
    const result: ChatResult = partner.ok ? { answer: leadOk.result.answer, duo: { partner: partner.adapter.id, partnerAnswer: partner.result.answer } } : { answer: leadOk.result.answer }
    const duo = this.finish(ctx, { phase: 'chat', proposals, notes: [], winner: partner.ok ? 'merged' : lead.adapter.id, ...(partner.ok ? {} : { fallback: this.fallbackNote(partner, leadOk) }) })
    return { result, meta: combineDuoMeta(parts, started, lead.part, duo) }
  }

  /** Outside the execution runner (which runs both sides in sibling worktrees) only the lead executes. */
  executeComplexTask(input: ExecutionInput, ctx: CallContext) {
    return this.leadAdapter.executeComplexTask(input, ctx)
  }

  async cancelRun(runId: string): Promise<void> {
    await Promise.allSettled([this.leadAdapter.cancelRun(runId), this.partnerAdapter.cancelRun(runId)])
  }

  private proposals<T>(ctx: CallContext, phase: DuoPhase, sides: Array<Settled<T>>, summary: (result: T) => string): DuoInfo['proposals'] {
    const proposals = sides.filter((side): side is Extract<Settled<T>, { ok: true }> => side.ok).map((side) => ({ provider: side.adapter.id, summary: summary(side.result) }))
    for (const proposal of proposals) emit(ctx, { type: 'duo_proposal', provider: proposal.provider, phase, summary: proposal.summary })
    return proposals
  }

  private finish(ctx: CallContext, info: Omit<DuoInfo, 'lead' | 'partner'>): DuoInfo {
    const duo: DuoInfo = { ...info, lead: this.duo.lead, partner: this.duo.partner }
    emit(ctx, { type: 'duo_reconciled', phase: duo.phase, notes: duo.notes, ...(duo.winner ? { winner: duo.winner } : {}), ...(duo.fallback ? { fallback: duo.fallback } : {}) })
    return duo
  }

  private fallbackNote(failed: { adapter: OrchestratorAdapter; error: unknown }, used: { adapter: OrchestratorAdapter }): string {
    return `${failed.adapter.displayName} ist fehlgeschlagen (${errorKind(failed.error)}); es gilt das Ergebnis von ${used.adapter.displayName}.`
  }

  /** A cancelled side cancels the whole duo request: the other side's result must not be used. */
  private throwIfCancelled<T>(sides: Array<Settled<T>>, parts: CallMetaPart[], started: number): void {
    const cancelled = sides.find((side): side is Extract<Settled<T>, { ok: false }> => !side.ok && errorKind(side.error) === 'cancelled')
    if (cancelled) throw this.withMeta(cancelled.error, combineDuoMeta(parts, started, cancelled.part))
  }

  /** Both sides failed: the lead's error (the partner's appended to the message) with the tokens of every call. */
  private bothFailed<T>(sides: Array<Settled<T>>, parts: CallMetaPart[], started: number): OrchestratorError {
    const failures = sides.filter((side): side is Extract<Settled<T>, { ok: false }> => !side.ok)
    const primary = failures[0]!
    const others = failures.slice(1).map((side) => `${side.adapter.displayName}: ${clip(errorMessage(side.error), 300)}`)
    return this.withMeta(primary.error, combineDuoMeta(parts, started, primary.part), others.length ? ` (${others.join('; ')})` : '')
  }

  private withMeta(error: unknown, meta: CallMeta, suffix = ''): OrchestratorError {
    if (error instanceof OrchestratorError) {
      const wrapped = new OrchestratorError(`${error.message}${suffix}`, error.kind, { ...error.details, meta })
      wrapped.stack = error.stack
      return wrapped
    }
    return new OrchestratorError(`${errorMessage(error)}${suffix}`, 'process_failed', { meta })
  }
}

function emit(ctx: CallContext, event: OrchestratorEvent) {
  try {
    ctx.onEvent?.(event)
  } catch {
    // progress listeners must not break the call
  }
}

export function isDuo(adapter: OrchestratorAdapter | undefined): adapter is DuoOrchestrator {
  return adapter instanceof DuoOrchestrator
}
