import { isDuo, type DuoInfo, type OrchestratorAdapter, type OrchestratorId } from '@multi-ai-coder/engine'

/**
 * Per-request orchestrator choice from the composer ("Claude | Codex | Beide"): one CLI alone or both in
 * duo mode (ADR-004). Unset = the settings decide (orchestratorMode, orchestrator, duoLead).
 */
export type OrchestratorOverride = OrchestratorId | 'duo'
export const ORCHESTRATOR_OVERRIDES = ['claude-code', 'codex', 'duo'] as const

export const ORCHESTRATOR_NAMES: Record<OrchestratorId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

export function isOrchestratorOverride(value: unknown): value is OrchestratorOverride {
  return typeof value === 'string' && (ORCHESTRATOR_OVERRIDES as readonly string[]).includes(value)
}

export function otherOrchestrator(id: OrchestratorId): OrchestratorId {
  return id === 'claude-code' ? 'codex' : 'claude-code'
}

/** What runs a request, as stored in ExecutionRun.orchestrator and TaskPlan.source: 'duo:<lead>+<partner>' or the id. */
export function orchestratorLabel(adapter: OrchestratorAdapter): string {
  return isDuo(adapter) ? `duo:${adapter.duo.lead}+${adapter.duo.partner}` : adapter.id
}

/** Parses a duo label ('duo:claude-code+codex'); undefined for a single orchestrator or anything else. */
export function duoOfLabel(label: string | null | undefined): { lead: OrchestratorId; partner: OrchestratorId } | undefined {
  const match = /^duo:(claude-code|codex)\+(claude-code|codex)$/.exec(label ?? '')
  return match && match[1] !== match[2] ? { lead: match[1] as OrchestratorId, partner: match[2] as OrchestratorId } : undefined
}

/** German display name of a label ("Claude Code + Codex" for a duo). */
export function orchestratorLabelName(label: string | null | undefined): string {
  const duo = duoOfLabel(label)
  if (duo) return `${ORCHESTRATOR_NAMES[duo.lead]} + ${ORCHESTRATOR_NAMES[duo.partner]}`
  return label === 'claude-code' || label === 'codex' ? ORCHESTRATOR_NAMES[label] : (label ?? '')
}

/** The override that reproduces a stored run label (a resumed run keeps its orchestrators). */
export function overrideFromLabel(label: string | null | undefined): OrchestratorOverride | undefined {
  if (duoOfLabel(label)) return 'duo'
  return label === 'claude-code' || label === 'codex' ? label : undefined
}

interface MessageReader {
  chatMessage: { findMany(args: { where: { taskId: string; role: 'user' }; orderBy: { createdAt: 'desc' }; take: number; select: { metadata: true } }): Promise<Array<{ metadata: unknown }>> }
}

/**
 * The orchestrator choice of a task: the latest task-creating, confirming or design-answer user message of the
 * task that names one (the composer sends it with every message, a follow-up may change it). Plain questions
 * keep their choice as `askOrchestrator` and are skipped. Stored in the message metadata – no extra column.
 * Best effort: when the messages cannot be read, the settings decide.
 */
export async function taskOverride(prisma: MessageReader, taskId: string): Promise<OrchestratorOverride | undefined> {
  const messages = await Promise.resolve()
    .then(() => prisma.chatMessage.findMany({ where: { taskId, role: 'user' }, orderBy: { createdAt: 'desc' }, take: 30, select: { metadata: true } }))
    .catch(() => [] as Array<{ metadata: unknown }>)
  if (!Array.isArray(messages)) return undefined
  for (const message of messages) {
    const metadata = message.metadata as { orchestrator?: unknown; kind?: unknown } | null
    // a plain question does not choose the task's orchestrator (also older questions that stored it as orchestrator)
    if (metadata?.kind === 'question') continue
    const value = metadata?.orchestrator
    if (isOrchestratorOverride(value)) return value
  }
  return undefined
}

const PHASE_NAMES: Record<DuoInfo['phase'], string> = { plan: 'Plan', design: 'Design', review: 'Review', repair_hint: 'Reparaturhinweis', chat: 'Chat', execute: 'Ausführung' }

/** Chat message after a reconciled duo phase (plan, design): both proposals, the reconciliation and the result. */
export function duoReconciledMessage(duo: DuoInfo): { content: string; metadata: Record<string, unknown> } {
  const name = (id: string) => ORCHESTRATOR_NAMES[id as OrchestratorId] ?? id
  const result = duo.winner === 'merged' ? 'beide Vorschläge zusammengeführt' : duo.winner ? `es gilt der Vorschlag von ${name(duo.winner)}` : 'kein Ergebnis'
  const content = [
    `**Duo-Abgleich (${PHASE_NAMES[duo.phase]})** – ${name(duo.lead)} + ${name(duo.partner)}`,
    ...duo.proposals.map((proposal) => `- ${name(proposal.provider)}: ${proposal.summary}`),
    ...(duo.notes.length ? ['', 'Abgleich:', ...duo.notes.map((note) => `- ${note}`)] : []),
    '',
    `Ergebnis: ${result}.`,
    ...(duo.fallback ? [`⚠ ${duo.fallback}`] : []),
  ].join('\n')
  return {
    content,
    metadata: {
      kind: 'duo_reconciled',
      phase: duo.phase,
      lead: duo.lead,
      partner: duo.partner,
      proposals: duo.proposals.map((proposal) => ({ provider: proposal.provider, summary: proposal.summary })),
      notes: duo.notes,
      winner: duo.winner ?? null,
      fallback: duo.fallback ?? null,
    },
  }
}
