import type { ChatMessage, ExecutionRun, OrchestratorChoice, OrchestratorId, OrchestratorOverview, Settings } from './types'

/*
 * Duo mode (Claude Code and Codex in parallel with reconciliation) in the renderer: names, the composer choice
 * "Claude | Codex | Beide", the chat cards and the usage per provider. Pure functions, no React.
 */

export const ORCHESTRATOR_NAMES: Record<OrchestratorId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

const isId = (value: unknown): value is OrchestratorId => value === 'claude-code' || value === 'codex'
const nameOf = (value: unknown) => (isId(value) ? ORCHESTRATOR_NAMES[value] : String(value ?? ''))

/** 'duo:<lead>+<partner>' (ExecutionRun.orchestrator, TaskPlan.source) → lead and partner. */
export function duoOfLabel(label: string | null | undefined): { lead: OrchestratorId; partner: OrchestratorId } | undefined {
  const match = /^duo:(claude-code|codex)\+(claude-code|codex)$/.exec(label ?? '')
  return match && match[1] !== match[2] ? { lead: match[1] as OrchestratorId, partner: match[2] as OrchestratorId } : undefined
}

/** Display name of an orchestrator label: "Claude Code + Codex" for a duo run. */
export function orchestratorLabelName(label: string | null | undefined): string | undefined {
  const duo = duoOfLabel(label)
  if (duo) return `${ORCHESTRATOR_NAMES[duo.lead]} + ${ORCHESTRATOR_NAMES[duo.partner]}`
  return isId(label) ? ORCHESTRATOR_NAMES[label] : undefined
}

/** Name for the header and the chat head: the current run's orchestrators, else what the settings select. */
export function orchestratorTitle(settings: Pick<Settings, 'orchestrator' | 'orchestratorMode' | 'duoLead'> | undefined, execution?: Pick<ExecutionRun, 'orchestrator'>): string {
  const fromRun = orchestratorLabelName(execution?.orchestrator)
  if (fromRun) return fromRun
  if (settings?.orchestratorMode === 'duo') {
    const lead = settings.duoLead ?? 'claude-code'
    return `${ORCHESTRATOR_NAMES[lead]} + ${ORCHESTRATOR_NAMES[lead === 'codex' ? 'claude-code' : 'codex']}`
  }
  return settings?.orchestrator ? ORCHESTRATOR_NAMES[settings.orchestrator] : 'kein Orchestrator'
}

export interface ComposerOrchestrator {
  /** Options for the Seg; only CLIs that are connected (Beide only when both are). Empty: no choice to offer. */
  options: Array<{ id: OrchestratorChoice; label: string; title: string }>
  value: OrchestratorChoice | undefined
  /** What a message sends: the user's own choice when it is possible; undefined = the settings decide. */
  send: OrchestratorChoice | undefined
}

/** The composer's orchestrator choice: default = the settings, a choice stored for the session wins if possible. */
export function composerOrchestrator(overview: Pick<OrchestratorOverview, 'usable'> | undefined, settings: Pick<Settings, 'orchestrator' | 'orchestratorMode'> | undefined, stored: unknown): ComposerOrchestrator {
  const usable = overview?.usable ?? []
  const options: ComposerOrchestrator['options'] = []
  if (usable.includes('claude-code')) options.push({ id: 'claude-code', label: 'Claude', title: 'Nur Claude Code arbeitet an diesem Auftrag' })
  if (usable.includes('codex')) options.push({ id: 'codex', label: 'Codex', title: 'Nur Codex arbeitet an diesem Auftrag' })
  if (usable.includes('claude-code') && usable.includes('codex')) options.push({ id: 'duo', label: 'Beide', title: 'Claude Code und Codex arbeiten parallel und gleichen ab (≈2–3× Premium-Kontingent)' })
  const possible = (value: unknown): value is OrchestratorChoice => options.some((option) => option.id === value)
  const fallback: OrchestratorChoice | undefined = settings?.orchestratorMode === 'duo' ? 'duo' : settings?.orchestrator ?? undefined
  const value = possible(stored) ? stored : possible(fallback) ? fallback : options[0]?.id
  return { options: options.length > 1 ? options : [], value, send: possible(stored) ? stored : undefined }
}

export interface DuoCard {
  phase: string
  columns: Array<{ provider: string; name: string; summary?: string }>
  notes: string[]
  /** "zusammengeführt", "Claude Code" … */
  result: string
  fallback?: string
}

const PHASE_NAMES: Record<string, string> = { plan: 'Plan', design: 'Design', review: 'Review', repair_hint: 'Reparaturhinweis', chat: 'Chat', execute: 'Ausführung' }

/** German name of a duo phase (plan, review, execute …). */
export function duoPhaseName(phase: unknown): string {
  return PHASE_NAMES[String(phase)] ?? String(phase ?? '')
}

/** German name of an orchestrator id (unknown values unchanged). */
export function orchestratorName(id: unknown): string {
  return nameOf(id)
}

/** A `duo_reconciled` chat message as a card: one column per orchestrator (lead first), the reconciliation, the result. */
export function duoCard(metadata: Record<string, unknown>): DuoCard | undefined {
  if (metadata.kind !== 'duo_reconciled' || !isId(metadata.lead) || !isId(metadata.partner)) return undefined
  const proposals = Array.isArray(metadata.proposals) ? (metadata.proposals as Array<{ provider?: unknown; summary?: unknown }>) : []
  const summary = (provider: OrchestratorId) => {
    const found = proposals.find((proposal) => proposal.provider === provider)
    return typeof found?.summary === 'string' ? found.summary : undefined
  }
  const winner = metadata.winner
  return {
    phase: duoPhaseName(metadata.phase),
    columns: [metadata.lead, metadata.partner].map((provider) => ({ provider, name: ORCHESTRATOR_NAMES[provider], summary: summary(provider) })),
    notes: Array.isArray(metadata.notes) ? metadata.notes.filter((note): note is string => typeof note === 'string') : [],
    result: winner === 'merged' ? 'zusammengeführt' : isId(winner) ? `${ORCHESTRATOR_NAMES[winner]} gilt` : 'kein Ergebnis',
    ...(typeof metadata.fallback === 'string' && metadata.fallback ? { fallback: metadata.fallback } : {}),
  }
}

export interface DuoAnswer {
  answers: Array<{ provider: string; name: string; text: string }>
  fallback?: string
}

/** A duo chat answer: both answers side by side (lead first); one answer plus the hint when a side failed. */
export function duoAnswer(message: Pick<ChatMessage, 'content' | 'metadata'>): DuoAnswer | undefined {
  const duo = message.metadata?.duo as { lead?: unknown; partner?: unknown; partnerAnswer?: unknown; fallback?: unknown } | undefined
  if (message.metadata?.kind !== 'answer' || !duo || !isId(duo.lead) || !isId(duo.partner)) return undefined
  const answeredBy = isId(message.metadata.orchestrator) ? message.metadata.orchestrator : duo.lead
  const answers = [{ provider: answeredBy, name: nameOf(answeredBy), text: message.content }]
  if (typeof duo.partnerAnswer === 'string') answers.push({ provider: duo.partner, name: ORCHESTRATOR_NAMES[duo.partner], text: duo.partnerAnswer })
  return { answers, ...(typeof duo.fallback === 'string' && duo.fallback ? { fallback: duo.fallback } : {}) }
}

/** Premium usage per provider of a run (only when more than one provider worked, i.e. duo). */
export function providerUsage(execution: Pick<ExecutionRun, 'usage'> | undefined): Array<{ provider: string; name: string; calls: number; tokens: number }> {
  const byProvider = execution?.usage?.premium.byProvider ?? {}
  const rows = Object.entries(byProvider).map(([provider, entry]) => ({ provider, name: nameOf(provider), calls: entry.calls, tokens: entry.inputTokens + entry.outputTokens }))
  return rows.length > 1 ? rows.sort((a, b) => a.name.localeCompare(b.name)) : []
}
