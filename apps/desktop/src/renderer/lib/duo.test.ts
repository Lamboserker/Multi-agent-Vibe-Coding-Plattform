import { describe, expect, it } from 'vitest'
import { composerOrchestrator, duoAnswer, duoCard, duoOfLabel, orchestratorLabelName, orchestratorTitle, providerUsage } from './duo'
import { decisions, milestones } from './leitstand'
import type { ExecutionRun, RunEvent, Subtask, TaskPlan, UsageSummary } from './types'

const single = { orchestrator: 'claude-code' as const, orchestratorMode: 'single' as const, duoLead: 'claude-code' as const }

describe('duo names', () => {
  it('parses duo labels and names both orchestrators', () => {
    expect(duoOfLabel('duo:codex+claude-code')).toEqual({ lead: 'codex', partner: 'claude-code' })
    expect(duoOfLabel('codex')).toBeUndefined()
    expect(orchestratorLabelName('duo:claude-code+codex')).toBe('Claude Code + Codex')
    expect(orchestratorLabelName('codex')).toBe('Codex')
    expect(orchestratorLabelName('fast-path')).toBeUndefined()
  })

  it('titles the header: the run first, then the settings', () => {
    expect(orchestratorTitle(single)).toBe('Claude Code')
    expect(orchestratorTitle({ ...single, orchestratorMode: 'duo', duoLead: 'codex' })).toBe('Codex + Claude Code')
    expect(orchestratorTitle(single, { orchestrator: 'duo:claude-code+codex' })).toBe('Claude Code + Codex')
    expect(orchestratorTitle({ ...single, orchestrator: null })).toBe('kein Orchestrator')
    expect(orchestratorTitle(undefined)).toBe('kein Orchestrator')
  })
})

describe('composerOrchestrator', () => {
  it('offers only connected CLIs and "Beide" only when both are connected', () => {
    const both = composerOrchestrator({ usable: ['claude-code', 'codex'] }, single, undefined)
    expect(both.options.map((option) => [option.id, option.label])).toEqual([['claude-code', 'Claude'], ['codex', 'Codex'], ['duo', 'Beide']])
    expect(both.value).toBe('claude-code')
    expect(both.send).toBeUndefined()
    // one CLI: nothing to choose
    expect(composerOrchestrator({ usable: ['codex'] }, single, 'duo').options).toEqual([])
    expect(composerOrchestrator(undefined, single, undefined).options).toEqual([])
  })

  it('defaults to the settings (duo mode → Beide) and sends only a possible own choice', () => {
    expect(composerOrchestrator({ usable: ['claude-code', 'codex'] }, { orchestrator: 'codex', orchestratorMode: 'duo' }, undefined).value).toBe('duo')
    const chosen = composerOrchestrator({ usable: ['claude-code', 'codex'] }, single, 'codex')
    expect([chosen.value, chosen.send]).toEqual(['codex', 'codex'])
    // the stored choice is not possible right now: the default is shown, nothing is sent
    const stale = composerOrchestrator({ usable: ['claude-code'] }, single, 'codex')
    expect([stale.value, stale.send]).toEqual(['claude-code', undefined])
  })
})

describe('duo chat cards', () => {
  it('maps a duo_reconciled message to two columns (lead first), notes and the result', () => {
    const card = duoCard({ kind: 'duo_reconciled', phase: 'plan', lead: 'codex', partner: 'claude-code', proposals: [{ provider: 'claude-code', summary: '3 Task(s)' }, { provider: 'codex', summary: '2 Task(s)' }], notes: ['T2 übernommen.', 3], winner: 'merged', fallback: null })
    expect(card).toEqual({ phase: 'Plan', columns: [{ provider: 'codex', name: 'Codex', summary: '2 Task(s)' }, { provider: 'claude-code', name: 'Claude Code', summary: '3 Task(s)' }], notes: ['T2 übernommen.'], result: 'zusammengeführt' })
    const fallback = duoCard({ kind: 'duo_reconciled', phase: 'design', lead: 'claude-code', partner: 'codex', proposals: [{ provider: 'claude-code', summary: 'crm' }], notes: [], winner: 'claude-code', fallback: 'Codex ist fehlgeschlagen (timeout).' })
    expect(fallback).toMatchObject({ phase: 'Design', result: 'Claude Code gilt', fallback: 'Codex ist fehlgeschlagen (timeout).' })
    expect(fallback!.columns[1]).toEqual({ provider: 'codex', name: 'Codex', summary: undefined })
    expect(duoCard({ kind: 'task_plan' })).toBeUndefined()
  })

  it('shows both chat answers side by side, or the remaining answer with the hint', () => {
    const both = duoAnswer({ content: 'Lead sagt A', metadata: { kind: 'answer', orchestrator: 'claude-code', duo: { lead: 'claude-code', partner: 'codex', partnerAnswer: 'Partner sagt B' } } })
    expect(both).toEqual({ answers: [{ provider: 'claude-code', name: 'Claude Code', text: 'Lead sagt A' }, { provider: 'codex', name: 'Codex', text: 'Partner sagt B' }] })
    const leadFailed = duoAnswer({ content: 'Nur Codex', metadata: { kind: 'answer', orchestrator: 'codex', duo: { lead: 'claude-code', partner: 'codex', fallback: 'Claude Code ist fehlgeschlagen.' } } })
    expect(leadFailed).toEqual({ answers: [{ provider: 'codex', name: 'Codex', text: 'Nur Codex' }], fallback: 'Claude Code ist fehlgeschlagen.' })
    expect(duoAnswer({ content: 'x', metadata: { kind: 'answer', orchestrator: 'codex' } })).toBeUndefined()
  })
})

describe('providerUsage', () => {
  const usage = (byProvider?: UsageSummary['premium']['byProvider']) => ({ usage: { premium: { byProvider } } as UsageSummary } as Pick<ExecutionRun, 'usage'>)
  it('lists the premium usage per provider only when both worked', () => {
    expect(providerUsage(usage({ codex: { calls: 2, failedCalls: 0, inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 }, 'claude-code': { calls: 3, failedCalls: 1, inputTokens: 50, outputTokens: 5, cachedInputTokens: 0 } }))).toEqual([
      { provider: 'claude-code', name: 'Claude Code', calls: 3, tokens: 55 },
      { provider: 'codex', name: 'Codex', calls: 2, tokens: 120 },
    ])
    expect(providerUsage(usage({ codex: { calls: 2, failedCalls: 0, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } }))).toEqual([])
    expect(providerUsage(usage())).toEqual([])
    expect(providerUsage(undefined)).toEqual([])
  })
})

describe('duo events in the Leitstand', () => {
  const subtask = { id: 'id-T1', key: 'T1', dependsOn: [], selectedModelClass: 'premium_llm' } as unknown as Subtask
  const event = (type: string, message: string, data: Record<string, unknown>, patch: Partial<RunEvent> = {}): RunEvent => ({ id: type + message, level: 'info', type, message, data, createdAt: '2026-10-21T08:00:00.000Z', ...patch })
  const events = [
    event('duo_proposal', 'claude-code (review): approve (90/100)', { provider: 'claude-code', phase: 'review', summary: 'approve (90/100)' }),
    event('duo_reconciled', 'review: Es gilt das strengere Urteil.', { phase: 'review', winner: 'merged', notes: ['Es gilt das strengere Urteil: request_changes (70/100).'] }),
    event('duo_reconciled', 'T1: Codex gewinnt', { phase: 'execute', winner: 'codex', notes: ['nur die Checks von Codex sind grün'] }, { subtaskId: 'id-T1' }),
    event('duo_reconciled', 'repair_hint: fallback', { phase: 'repair_hint', winner: 'claude-code', notes: [], fallback: 'Codex ist fehlgeschlagen (timeout); es gilt das Ergebnis von Claude Code.' }),
    event('duo_partner_unavailable', 'T1: Codex is unavailable (not_authenticated)', { kind: 'not_authenticated' }, { subtaskId: 'id-T1', level: 'warn' }),
  ]

  it('turns duo events into chat milestones', () => {
    expect(milestones(events, [subtask]).map((entry) => [entry.key, entry.text, entry.tone])).toEqual([
      ['Duo', 'Vorschlag von Claude Code (Review)', 'accent'],
      ['Duo', 'Duo-Abgleich Review · vereint', 'accent'],
      ['T1', 'Duo-Abgleich Ausführung · Codex gilt', 'accent'],
      ['Duo', 'Duo-Abgleich Reparaturhinweis: Codex ist fehlgeschlagen (timeout); es gilt das Ergebnis von Claude Code.', 'tool'],
      ['T1', 'Duo: ein Orchestrator fiel aus, der andere übernimmt', 'tool'],
    ])
  })

  it('lists duo reconciliations and the duo plan as decisions', () => {
    const plan = { id: 'p', summary: '', source: 'duo:claude-code+codex', classification: {}, dag: {}, createdAt: '2026-10-21T07:59:00.000Z', modelAssignments: [] } as unknown as TaskPlan
    const texts = decisions({ plan, subtasks: [subtask], events }).map((entry) => entry.text)
    expect(texts[0]).toBe('Duo-Plan: Claude Code + Codex haben parallel geplant, der Lead hat beide Pläne abgeglichen.')
    expect(texts).toContain('Duo-Abgleich Review: beide Ergebnisse vereint – Es gilt das strengere Urteil: request_changes (70/100).')
    expect(texts).toContain('T1 · Duo-Abgleich Ausführung: Codex gilt – nur die Checks von Codex sind grün')
    expect(texts).toContain('Duo-Abgleich Reparaturhinweis: Codex ist fehlgeschlagen (timeout); es gilt das Ergebnis von Claude Code.')
    expect(texts).toContain('T1: ein Orchestrator des Duos fiel aus – das Ergebnis des anderen gilt.')
  })
})
