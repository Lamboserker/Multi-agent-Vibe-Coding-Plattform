import { describe, expect, it } from 'vitest'
import { chooseRepairHint, DuoOrchestrator, isDuo, mergeReviews } from './duo.js'
import { RECONCILE_PLAN_SCHEMA, CHOOSE_SCHEMA } from './schemas.js'
import { bookableCalls, OrchestratorError, type CallContext, type CallMeta, type ExecutionPlan, type OrchestratorAdapter, type OrchestratorEvent, type OrchestratorId, type PlanningInput, type RepairHint, type ReviewResult, type StructuredRequest } from './types.js'

const usage = (inputTokens: number, outputTokens = 10) => ({ inputTokens, outputTokens, cachedInputTokens: 0, measured: true, billing: 'subscription' as const })
const meta = (model: string, inputTokens: number, sessionId?: string): CallMeta => ({ model, sessionId, durationMs: 5, usage: usage(inputTokens) })

function plan(summary: string, titles: string[]): ExecutionPlan {
  return {
    summary,
    analysis: { summary, taskType: 'frontend', complexity: 2, risk: 1, securitySensitive: false, affectedAreas: [], needsDecomposition: true, openQuestions: [] },
    tasks: titles.map((title, index) => ({
      id: `task-${String(index + 1).padStart(3, '0')}`, title, description: title, category: 'react-ui', complexity: 2, risk: 1, relevantFiles: [], newFiles: [`src/${title}.tsx`], dependsOn: [],
      capabilities: [], expectedInputTokens: 1000, testStrategy: '', acceptanceCriteria: [], suggestedExecutor: 'local', rationale: '', agent: '', skills: [],
    })),
    warnings: [],
  }
}

const review = (overrides: Partial<ReviewResult>): ReviewResult => ({ verdict: 'approve', score: 90, summary: 'ok', issues: [], requiredFixes: [], ...overrides })

type Handlers = Partial<Pick<OrchestratorAdapter, 'createPlan' | 'createDesign' | 'reviewResult' | 'repairHint' | 'chat' | 'executeComplexTask'>> & { structuredCall?: (request: StructuredRequest, ctx: CallContext) => Promise<{ result: unknown; meta: CallMeta }> }

function fake(id: OrchestratorId, handlers: Handlers = {}) {
  const cancelled: string[] = []
  const structured: StructuredRequest[] = []
  const adapter: OrchestratorAdapter & { cancelled: string[]; structured: StructuredRequest[] } = {
    id,
    displayName: id === 'claude-code' ? 'Claude Code' : 'Codex',
    cancelled,
    structured,
    async detect() { return { installed: true, installHint: { docsUrl: '', commands: [] } } },
    async capabilities() { return { structuredOutput: true, streaming: true, sessionResume: true, fileEditing: true, sandbox: id, models: [] } },
    async connect() { return { status: 'already_connected' as const, message: 'ok' } },
    async getStatus() { return { orchestrator: id, installed: true, authenticated: true, usesApiKeyBilling: false, checkedAt: '', message: `${id} ok` } },
    async logout() {},
    async diagnose() { return { orchestrator: id, ok: true, checks: [{ name: 'CLI installed', ok: true, detail: id }] } },
    async analyzeTask() { throw new Error('not used') },
    createPlan: handlers.createPlan ?? (async () => { throw new Error('no plan') }),
    reviewResult: handlers.reviewResult ?? (async () => { throw new Error('no review') }),
    chat: handlers.chat ?? (async () => { throw new Error('no chat') }),
    executeComplexTask: handlers.executeComplexTask ?? (async () => ({ result: { summary: `${id} done`, filesChanged: [], commandsRun: [] }, meta: meta(id, 1) })),
    async cancelRun(runId: string) { cancelled.push(runId) },
    ...(handlers.createDesign ? { createDesign: handlers.createDesign } : {}),
    ...(handlers.repairHint ? { repairHint: handlers.repairHint } : {}),
    ...(handlers.structuredCall ? { structuredCall: async (request: StructuredRequest, ctx: CallContext) => { structured.push(request); return handlers.structuredCall!(request, ctx) } } : {}),
  }
  return adapter
}

const planningInput: PlanningInput = { goal: 'Kontaktliste', context: { summary: 'Vite app', relevantFiles: [], validationCommands: [] }, costMode: 'balanced', localModels: [], maxTasks: 6 }
const ctx = (events: OrchestratorEvent[] = []): CallContext => ({ runId: 'plan-1', cwd: '.', onEvent: (event) => events.push(event) })

describe('DuoOrchestrator', () => {
  it('keeps the lead id, combines the names and is recognised by isDuo', () => {
    const duo = new DuoOrchestrator(fake('claude-code'), fake('codex'))
    expect(duo.id).toBe('claude-code')
    expect(duo.duo).toEqual({ lead: 'claude-code', partner: 'codex' })
    expect(duo.displayName).toBe('Claude Code + Codex')
    expect(isDuo(duo)).toBe(true)
    expect(isDuo(fake('codex'))).toBe(false)
    expect(() => new DuoOrchestrator(fake('codex'), fake('codex'))).toThrow(/two different/)
  })

  it('plans with both in parallel and lets the lead reconcile both plans', async () => {
    const reconciled = { plan: { ...plan('Merged', ['ContactList', 'ContactForm', 'ContactCard']) }, notes: ['Kartenkomponente von Codex übernommen.'] }
    const lead = fake('claude-code', {
      createPlan: async () => ({ result: plan('Claude plan', ['ContactList', 'ContactForm']), meta: meta('sonnet', 1000, 's-lead') }),
      structuredCall: async () => ({ result: reconciled, meta: meta('sonnet', 3000, 's-rec') }),
    })
    const partner = fake('codex', { createPlan: async () => ({ result: plan('Codex plan', ['ContactList', 'ContactCard']), meta: meta('gpt-5', 2000, 's-partner') }) })
    const events: OrchestratorEvent[] = []
    const { result, meta: callMeta } = await new DuoOrchestrator(lead, partner).createPlan(planningInput, ctx(events))
    expect(result.tasks.map((task) => task.title)).toEqual(['ContactList', 'ContactForm', 'ContactCard'])
    // the reconcile prompt carries both proposals and the full planning rules, with the strict wrapper schema
    expect(lead.structured[0]!.schema).toBe(RECONCILE_PLAN_SCHEMA)
    expect(lead.structured[0]!.prompt).toContain('Proposal A (Claude Code)')
    expect(lead.structured[0]!.prompt).toContain('Proposal B (Codex)')
    expect(lead.structured[0]!.prompt).toContain('Claude plan')
    expect(lead.structured[0]!.prompt).toContain('Codex plan')
    expect(lead.structured[0]!.prompt).toContain('At most 6 tasks')
    // booking: one part per call with its provider, the top level is the sum, the session is the lead's
    expect(callMeta.parts?.map((part) => [part.provider, part.role, part.status, part.usage.inputTokens])).toEqual([
      ['claude-code', 'lead', 'ok', 1000],
      ['codex', 'partner', 'ok', 2000],
      ['claude-code', 'reconcile', 'ok', 3000],
    ])
    expect(callMeta.usage.inputTokens).toBe(6000)
    expect(callMeta.sessionId).toBe('s-lead')
    expect(callMeta.duo).toMatchObject({ phase: 'plan', lead: 'claude-code', partner: 'codex', winner: 'merged', notes: ['Kartenkomponente von Codex übernommen.'] })
    expect(callMeta.duo!.proposals.map((proposal) => proposal.provider)).toEqual(['claude-code', 'codex'])
    expect(events.filter((event) => event.type === 'duo_proposal')).toHaveLength(2)
    expect(events.find((event) => event.type === 'duo_reconciled')).toMatchObject({ phase: 'plan', winner: 'merged' })
    // each part becomes its own booking row
    expect(bookableCalls('claude-code', callMeta, 'ok').map((entry) => [entry.provider, entry.meta?.model, entry.durationMs])).toEqual([['claude-code', 'sonnet', 5], ['codex', 'gpt-5', 5], ['claude-code', 'sonnet', 5]])
  })

  it('uses the other plan when one side fails and books the failed call with its tokens', async () => {
    const lead = fake('claude-code', { createPlan: async () => { throw new OrchestratorError('Rate limited', 'rate_limited', { meta: meta('sonnet', 400) }) }, structuredCall: async () => { throw new Error('must not reconcile') } })
    const partner = fake('codex', { createPlan: async () => ({ result: plan('Codex plan', ['A']), meta: meta('gpt-5', 2000, 's-p') }) })
    const { result, meta: callMeta } = await new DuoOrchestrator(lead, partner).createPlan(planningInput, ctx())
    expect(result.summary).toBe('Codex plan')
    expect(lead.structured).toHaveLength(0)
    expect(callMeta.duo).toMatchObject({ winner: 'codex', fallback: expect.stringContaining('Claude Code ist fehlgeschlagen (rate_limited)') })
    expect(callMeta.parts?.map((part) => [part.provider, part.status, part.errorClass, part.usage.inputTokens])).toEqual([['claude-code', 'error', 'rate_limited', 400], ['codex', 'ok', undefined, 2000]])
    expect(callMeta.sessionId).toBe('s-p')
    expect(bookableCalls('claude-code', callMeta, 'ok').map((entry) => [entry.provider, entry.status, entry.errorClass])).toEqual([['claude-code', 'error', 'rate_limited'], ['codex', 'ok', undefined]])
  })

  it('falls back to the lead plan when the reconcile call fails, keeping its tokens', async () => {
    const lead = fake('claude-code', {
      createPlan: async () => ({ result: plan('Claude plan', ['A']), meta: meta('sonnet', 1000) }),
      structuredCall: async () => ({ result: { plan: { tasks: [] }, notes: [] }, meta: meta('sonnet', 700) }),
    })
    const partner = fake('codex', { createPlan: async () => ({ result: plan('Codex plan', ['B']), meta: meta('gpt-5', 2000) }) })
    const { result, meta: callMeta } = await new DuoOrchestrator(lead, partner).createPlan(planningInput, ctx())
    expect(result.summary).toBe('Claude plan')
    expect(callMeta.parts?.at(-1)).toMatchObject({ role: 'reconcile', status: 'error', errorClass: 'invalid_output', usage: { inputTokens: 700 } })
    expect(callMeta.duo?.fallback).toMatch(/Abgleich durch Claude Code fehlgeschlagen/)
  })

  it('throws the lead error with the merged meta of both calls when both fail', async () => {
    const lead = fake('claude-code', { createPlan: async () => { throw new OrchestratorError('Claude timed out', 'timeout', { meta: meta('sonnet', 500) }) } })
    const partner = fake('codex', { createPlan: async () => { throw new Error('codex crashed') } })
    const error = await new DuoOrchestrator(lead, partner).createPlan(planningInput, ctx()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OrchestratorError)
    const failure = error as OrchestratorError
    expect(failure.kind).toBe('timeout')
    expect(failure.message).toContain('Claude timed out')
    expect(failure.message).toContain('Codex: codex crashed')
    expect(failure.details.meta?.usage.inputTokens).toBe(500)
    expect(failure.details.meta?.parts?.map((part) => [part.provider, part.status, part.errorClass])).toEqual([['claude-code', 'error', 'timeout'], ['codex', 'error', 'process_failed']])
    expect(bookableCalls('claude-code', failure.details.meta, 'error', 'timeout').map((entry) => [entry.provider, entry.status, entry.errorClass, entry.meta?.usage.inputTokens])).toEqual([
      ['claude-code', 'error', 'timeout', 500],
      ['codex', 'error', 'process_failed', 0],
    ])
  })

  it('unites the clarification questions when both planners ask instead of planning', async () => {
    const asks = (questions: string[], tokens: number) => async () => { throw new OrchestratorError('questions', 'needs_clarification', { retryable: false, questions, meta: meta('m', tokens) }) }
    const duo = new DuoOrchestrator(fake('claude-code', { createPlan: asks(['Welche Felder?', 'Mit Suche?'], 100) }), fake('codex', { createPlan: asks(['Mit Suche?', 'Welches Design?'], 200) }))
    const error = (await duo.createPlan(planningInput, ctx()).catch((caught: unknown) => caught)) as OrchestratorError
    expect(error.kind).toBe('needs_clarification')
    expect(error.details.questions).toEqual(['Welche Felder?', 'Mit Suche?', 'Welches Design?'])
    expect(error.details.meta?.usage.inputTokens).toBe(300)
    expect(error.details.meta?.parts).toHaveLength(2)
  })

  it('uses the plan of one side and keeps the questions of the other as warnings (no reconcile)', async () => {
    const lead = fake('claude-code', { createPlan: async () => { throw new OrchestratorError('questions', 'needs_clarification', { questions: ['Welche Felder?'] }) }, structuredCall: async () => { throw new Error('must not reconcile') } })
    const partner = fake('codex', { createPlan: async () => ({ result: plan('Codex plan', ['A']), meta: meta('gpt-5', 100) }) })
    const { result, meta: callMeta } = await new DuoOrchestrator(lead, partner).createPlan(planningInput, ctx())
    expect(result.warnings).toEqual(['Claude Code asks: Welche Felder?'])
    expect(callMeta.duo?.winner).toBe('codex')
  })

  it('merges two reviews deterministically: stricter verdict, lower score, united and deduplicated issues', async () => {
    const lead = fake('claude-code', { reviewResult: async () => ({ result: review({ verdict: 'request_changes', score: 70, summary: 'Ein Fehler.', issues: [{ severity: 'minor', file: 'src/a.ts', message: 'Missing null check.' }], requiredFixes: ['Add null check'] }), meta: meta('sonnet', 100) }) })
    const partner = fake('codex', { reviewResult: async () => ({ result: review({ verdict: 'reject', score: 40, summary: 'Zwei Fehler.', issues: [{ severity: 'blocker', file: './src/a.ts', message: 'missing null-check' }, { severity: 'major', file: 'src/b.ts', message: 'Wrong import.' }], requiredFixes: ['add null check', 'Fix import'] }), meta: meta('gpt-5', 200) }) })
    const events: OrchestratorEvent[] = []
    const { result, meta: callMeta } = await new DuoOrchestrator(lead, partner).reviewResult({ goal: 'g', tasks: [], diff: '', validationSummary: '', riskFlags: [] }, ctx(events))
    expect(result.verdict).toBe('reject')
    expect(result.score).toBe(40)
    expect(result.issues).toEqual([{ severity: 'blocker', file: 'src/a.ts', message: 'Missing null check.' }, { severity: 'major', file: 'src/b.ts', message: 'Wrong import.' }])
    expect(result.requiredFixes).toEqual(['Add null check', 'Fix import'])
    expect(result.summary).toBe('Claude Code: Ein Fehler.\nCodex: Zwei Fehler.')
    expect(callMeta.parts).toHaveLength(2)
    expect(callMeta.duo?.notes[1]).toContain('1 doppelte')
    expect(events.map((event) => event.type)).toEqual(['duo_proposal', 'duo_proposal', 'duo_reconciled'])
  })

  it('mergeReviews keeps approve only when both approve', () => {
    expect(mergeReviews({ label: 'A', review: review({}) }, { label: 'B', review: review({ score: 80 }) }).review).toMatchObject({ verdict: 'approve', score: 80 })
    expect(mergeReviews({ label: 'A', review: review({ verdict: 'request_changes' }) }, { label: 'B', review: review({}) }).review.verdict).toBe('request_changes')
  })

  it('takes the more confident repair hint, the lead on a tie', async () => {
    const hint = (confidence: RepairHint['confidence'], diagnosis: string): RepairHint => ({ diagnosis, confidence, edits: [{ file: 'src/a.ts', find: 'a', replace: 'b', note: '' }] })
    expect(chooseRepairHint(hint('medium', 'x'), hint('high', 'y'))).toBe('second')
    expect(chooseRepairHint(hint('high', 'x'), hint('high', 'y'))).toBe('first')
    const input = { taskId: 't', title: 't', instructions: '', acceptanceCriteria: [], files: [], diff: '', failures: '' }
    const duo = new DuoOrchestrator(fake('claude-code', { repairHint: async () => ({ result: hint('medium', 'lead'), meta: meta('sonnet', 1) }) }), fake('codex', { repairHint: async () => ({ result: hint('high', 'partner'), meta: meta('gpt-5', 2) }) }))
    const { result, meta: callMeta } = await duo.repairHint!(input, ctx())
    expect(result.diagnosis).toBe('partner')
    expect(callMeta.duo?.winner).toBe('codex')
    const tie = new DuoOrchestrator(fake('claude-code', { repairHint: async () => ({ result: hint('high', 'lead'), meta: meta('sonnet', 1) }) }), fake('codex', { repairHint: async () => ({ result: hint('high', 'partner'), meta: meta('gpt-5', 2) }) }))
    expect((await tie.repairHint!(input, ctx())).result.diagnosis).toBe('lead')
    // only one side supports hints: that one alone
    const single = new DuoOrchestrator(fake('claude-code'), fake('codex', { repairHint: async () => ({ result: hint('low', 'only'), meta: meta('gpt-5', 2) }) }))
    const only = await single.repairHint!(input, ctx())
    expect(only.result.diagnosis).toBe('only')
    expect(only.meta.parts?.map((part) => part.provider)).toEqual(['codex'])
    expect(new DuoOrchestrator(fake('claude-code'), fake('codex')).repairHint).toBeUndefined()
  })

  it('chat returns both answers; each side resumes its own session and the lead session stays meta.sessionId', async () => {
    const seen: Array<[string, string | undefined]> = []
    const lead = fake('claude-code', { chat: async (input) => { seen.push(['claude-code', input.resumeSessionId]); return { result: { answer: 'Antwort Claude' }, meta: meta('sonnet', 10, 's-lead') } } })
    const partner = fake('codex', { chat: async (input) => { seen.push(['codex', input.resumeSessionId]); return { result: { answer: 'Antwort Codex' }, meta: meta('gpt-5', 20, 's-partner') } } })
    const { result, meta: callMeta } = await new DuoOrchestrator(lead, partner).chat({ question: 'Was?', context: planningInput.context, resumeSessionId: 'old-lead', partnerResumeSessionId: 'old-partner' }, ctx())
    expect(result).toEqual({ answer: 'Antwort Claude', duo: { partner: 'codex', partnerAnswer: 'Antwort Codex' } })
    expect(seen.sort()).toEqual([['claude-code', 'old-lead'], ['codex', 'old-partner']])
    expect(callMeta.sessionId).toBe('s-lead')
    expect(callMeta.parts?.map((part) => part.sessionId)).toEqual(['s-lead', 's-partner'])
  })

  it('chat: a failed lead returns the partner answer without a session id for the lead', async () => {
    const lead = fake('claude-code', { chat: async () => { throw new OrchestratorError('expired', 'session_expired') } })
    const partner = fake('codex', { chat: async () => ({ result: { answer: 'Antwort Codex' }, meta: meta('gpt-5', 20, 's-partner') }) })
    const { result, meta: callMeta } = await new DuoOrchestrator(lead, partner).chat({ question: 'Was?', context: planningInput.context }, ctx())
    expect(result).toEqual({ answer: 'Antwort Codex' })
    expect(callMeta.sessionId).toBeUndefined()
    expect(callMeta.duo?.fallback).toContain('Claude Code ist fehlgeschlagen (session_expired)')
  })

  it('design: both draft, the lead reconciles with the design schema; one capable side drafts alone', async () => {
    const draft = (summary: string) => ({ summary, designType: 'crm' as const, direction: 'ruhig', tokens: [], components: [{ name: 'ContactList', purpose: 'p', file: '', spec: 's', tokens: [] }], screens: [], mockupHtml: '<main></main>', questions: [] })
    const lead = fake('claude-code', {
      createDesign: async () => ({ result: draft('Claude'), meta: meta('sonnet', 1) }),
      structuredCall: async () => ({ result: draft('Merged'), meta: meta('sonnet', 3) }),
    })
    const partner = fake('codex', { createDesign: async (input) => { expect(input.provider).toBe('codex'); return { result: draft('Codex'), meta: meta('gpt-5', 2) } } })
    const designInput = { goal: 'CRM', context: planningInput.context, provider: 'claude-code' as const }
    const { result, meta: callMeta } = await new DuoOrchestrator(lead, partner).createDesign!(designInput, ctx())
    expect(result.summary).toBe('Merged')
    expect(lead.structured[0]!.prompt).toContain('Draft A (Claude Code)')
    expect(lead.structured[0]!.systemPrompt).toContain('senior product designer')
    expect(callMeta.parts?.map((part) => part.role)).toEqual(['lead', 'partner', 'reconcile'])
    const alone = await new DuoOrchestrator(fake('claude-code'), fake('codex', { createDesign: async () => ({ result: draft('Codex'), meta: meta('gpt-5', 2) }) })).createDesign!(designInput, ctx())
    expect(alone.result.summary).toBe('Codex')
    expect(alone.meta.duo?.fallback).toContain('Claude Code unterstützt die Design-Phase nicht')
    expect(new DuoOrchestrator(fake('claude-code'), fake('codex')).createDesign).toBeUndefined()
  })

  it('a cancelled side cancels the whole request in every phase instead of using the other side', async () => {
    const cancel = async (): Promise<never> => { throw new OrchestratorError('Orchestrator call cancelled.', 'cancelled') }
    const hint: RepairHint = { diagnosis: 'd', confidence: 'high', edits: [] }
    const draft = { summary: 's', designType: 'crm' as const, direction: '', tokens: [], components: [], screens: [], mockupHtml: '', questions: [] }
    const ok = fake('codex', {
      createPlan: async () => ({ result: plan('Codex', ['A']), meta: meta('gpt-5', 2) }),
      reviewResult: async () => ({ result: review({}), meta: meta('gpt-5', 2) }),
      chat: async () => ({ result: { answer: 'Codex' }, meta: meta('gpt-5', 2) }),
      repairHint: async () => ({ result: hint, meta: meta('gpt-5', 2) }),
      createDesign: async () => ({ result: draft, meta: meta('gpt-5', 2) }),
    })
    const cancelled = fake('claude-code', { createPlan: cancel, reviewResult: cancel, chat: cancel, repairHint: cancel, createDesign: cancel })
    const reviewInput = { goal: 'g', plan: plan('p', ['A']), diff: '', validation: { ok: true, summary: '' }, taskResults: [] } as never
    for (const duo of [new DuoOrchestrator(cancelled, ok), new DuoOrchestrator(ok, cancelled)]) {
      const events: OrchestratorEvent[] = []
      await expect(duo.createPlan(planningInput, ctx(events))).rejects.toMatchObject({ kind: 'cancelled' })
      await expect(duo.reviewResult(reviewInput, ctx(events))).rejects.toMatchObject({ kind: 'cancelled' })
      await expect(duo.chat({ question: 'Was?', context: planningInput.context }, ctx(events))).rejects.toMatchObject({ kind: 'cancelled' })
      await expect(duo.repairHint!({ taskId: 't', title: 't', instructions: '', acceptanceCriteria: [], files: [], diff: '', failures: '' }, ctx(events))).rejects.toMatchObject({ kind: 'cancelled' })
      await expect(duo.createDesign!({ goal: 'CRM', context: planningInput.context, provider: 'claude-code' }, ctx(events))).rejects.toMatchObject({ kind: 'cancelled', details: { meta: { parts: [expect.anything(), expect.anything()] } } })
      expect(events.filter((event) => event.type === 'duo_reconciled')).toHaveLength(0)
    }
  })

  it('forwards cancelRun to both and combines the connection status', async () => {
    const lead = fake('claude-code')
    const partner = fake('codex')
    const duo = new DuoOrchestrator(lead, partner)
    await duo.cancelRun('run-1:task-001')
    expect(lead.cancelled).toEqual(['run-1:task-001'])
    expect(partner.cancelled).toEqual(['run-1:task-001'])
    const status = await duo.getStatus()
    expect(status).toMatchObject({ orchestrator: 'claude-code', authenticated: true })
    expect(status.message).toBe('Claude Code: claude-code ok · Codex: codex ok')
    expect((await duo.diagnose()).checks.map((check) => check.name)).toEqual(['Claude Code: CLI installed', 'Codex: CLI installed'])
  })

  it('executeComplexTask outside the runner delegates to the lead only', async () => {
    const { result } = await new DuoOrchestrator(fake('claude-code'), fake('codex', { executeComplexTask: async () => { throw new Error('partner must not run') } })).executeComplexTask({ taskId: 't', title: 't', instructions: '', acceptanceCriteria: [], relevantFiles: [] }, ctx())
    expect(result.summary).toBe('claude-code done')
  })
})

describe('duo schemas', () => {
  const strict = (schema: Record<string, unknown>): void => {
    if (schema.type === 'object') {
      expect(schema.additionalProperties).toBe(false)
      expect([...(schema.required as string[])].sort()).toEqual(Object.keys(schema.properties as object).sort())
      for (const child of Object.values(schema.properties as Record<string, Record<string, unknown>>)) strict(child)
    } else if (schema.type === 'array') strict(schema.items as Record<string, unknown>)
  }
  it('RECONCILE_PLAN_SCHEMA and CHOOSE_SCHEMA are strict', () => {
    strict(RECONCILE_PLAN_SCHEMA)
    strict(CHOOSE_SCHEMA)
  })
})
