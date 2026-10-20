import { localizeEngineText } from './engine-text'
import type { LiveLine } from './stores'
import type { AgentRun, ExecutionRun, RunEvent, ScheduleForecast, Subtask, Task, TaskPlan, ValidationReport } from './types'
import { SUBTASK_STATUS, workflowState, type WorkflowState } from './workflow'

/*
 * Pure derivations for the Leitstand (control room): what each agent is doing, which decisions the
 * orchestrator took and how far the run is. No React, no store access – everything is computed
 * from the task, the run, its events and the execution forecast.
 */

export type Tone = 'accent' | 'local' | 'tool' | 'ok' | 'err' | 'muted' | 'faint'

export const TONE: Record<Tone, { color: string; soft: string }> = {
  accent: { color: 'var(--accent)', soft: 'var(--accent-soft)' },
  local: { color: 'var(--local)', soft: 'var(--local-soft)' },
  tool: { color: 'var(--tool)', soft: 'var(--tool-soft)' },
  ok: { color: 'var(--ok)', soft: 'var(--ok-soft)' },
  err: { color: 'var(--err)', soft: 'var(--err-soft)' },
  muted: { color: 'var(--muted)', soft: 'var(--hover)' },
  faint: { color: 'var(--faint)', soft: 'var(--hover)' },
}

export const STATUS_TONE: Record<string, Tone> = {
  planned: 'muted', queued: 'faint', running: 'accent', validating: 'local', repairing: 'tool', completed: 'ok', failed: 'err', skipped: 'faint', cancelled: 'faint', blocked: 'err',
}

export interface StageInfo {
  state: WorkflowState
  label: string
  tone: Tone
  /** 0 Aufgabe · 1 Plan · 2 Ausführung · 3 Freigabe · 4 abgeschlossen */
  phase: number
}

export function stageInfo(task: Task | undefined, execution: ExecutionRun | undefined): StageInfo {
  const current = workflowState(task, execution)
  const tone: Record<WorkflowState, Tone> = { draft: 'muted', planning: 'accent', plan_error: 'err', plan_questions: 'tool', ready: 'tool', running: 'accent', paused: 'tool', recoverable: 'err', cancelled: 'faint', approval: 'tool', done: 'ok' }
  const phase = current.state === 'done' ? 4 : { task: 0, plan: 1, execution: 2, approval: 3 }[current.phase]
  // the workflow label names the next action; the Leitstand header names what happened
  const label = current.state === 'draft' && !task ? 'Neue Sitzung' : current.state === 'recoverable' ? (execution?.status === 'interrupted' ? 'Ausführung unterbrochen' : 'Ausführung fehlgeschlagen') : current.label
  return { state: current.state, label, tone: tone[current.state], phase }
}

export type AgentKind = 'local' | 'premium' | 'tool' | 'blocked'

export interface AgentCheck {
  label: string
  state: 'ok' | 'open' | 'fail' | 'skip'
  detail: string
}

export interface AgentCard {
  id: string
  key: string
  title: string
  goal: string
  kind: AgentKind
  /** Assigned agent profile, if any. */
  profile?: string
  tone: Tone
  icon: 'cpu' | 'sparkles' | 'wrench' | 'ban'
  agent: string
  role: string
  model: string
  short: string
  status: Subtask['status']
  statusLabel: string
  statusTone: Tone
  active: boolean
  progress: number
  lastLog: string
  logs: Array<{ at: string; text: string; tone: Tone }>
  tokens: number
  tokensMeasured: boolean
  attempts: number
  deps: string[]
  worktree?: string
  files: Array<{ path: string; added: number | null; deleted: number | null; status: string }>
  checks: AgentCheck[]
  escalated: boolean
  wave?: number
  waitDetail?: string
  critical: boolean
}

const ACTIVE = new Set(['running', 'validating', 'repairing'])

/** "qwen2.5-coder:14b" → "14b"; premium → "Premium". */
export function shortModel(model: string | null | undefined, kind: AgentKind): string {
  if (kind === 'premium') return 'Premium'
  if (kind === 'tool') return 'Werkzeug'
  if (!model) return '–'
  const tag = model.split(':')[1]
  return tag && tag !== 'latest' ? tag : model.split('/').pop()!.slice(0, 12)
}

const TIER_LABEL: Record<string, string> = { fast: 'Fast', balanced: 'Balanced', advanced: 'Advanced', premium: 'Premium' }

const REASONS: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
  [/^High risk \((\d)\/5(, security-critical files)?, category ([\w-]+)\)\.?$/, (_, risk, security, category) => `hohes Risiko (${risk}/5${security ? ', sicherheitskritische Dateien' : ''}, ${category})`],
  [/^Complexity 5\/5\.?$/, 'Komplexität 5/5'],
  [/^Complexity 4\/5 needs the strongest local model\.?$/, 'Komplexität 4/5 braucht das stärkste lokale Modell'],
  [/^Moderate complexity\/risk \((\d)\/(\d)\)\.?$/, (_, complexity, risk) => `mittlere Komplexität/Risiko (${complexity}/${risk})`],
  [/^Manually assigned/, 'manuell zugewiesen'],
  [/orchestrator suggested premium/i, 'Orchestrator empfiehlt Premium'],
  [/quality mode/i, 'Quality-Modus'],
]

/** Router reasons are English (they also go into logs); common ones are shown in German. */
export function localizeReason(reason: string): string {
  for (const [pattern, replacement] of REASONS) if (pattern.test(reason)) return typeof replacement === 'string' ? replacement : reason.replace(pattern, replacement as never)
  return reason.replace(/\.$/, '')
}

const CHECK_LABEL: Record<string, string> = { typecheck: 'Typecheck', test: 'Tests', lint: 'Lint', build: 'Build', syntax: 'Syntax' }

function checksOf(subtask: Subtask): AgentCheck[] {
  const validation = subtask.validation as ValidationReport
  const rejected = subtask.patchStats?.warnings?.some((warning) => /reject|scope|secret/i.test(warning.code))
  const patch: AgentCheck = subtask.status === 'completed' || subtask.commitSha
    ? { label: 'Patch-Check', state: 'ok', detail: 'ok' }
    : rejected ? { label: 'Patch-Check', state: 'fail', detail: 'abgelehnt' } : { label: 'Patch-Check', state: 'open', detail: 'offen' }
  if (!validation?.results?.length) return [patch, { label: 'Typecheck', state: 'open', detail: 'offen' }, { label: 'Tests', state: 'open', detail: 'offen' }]
  return [
    patch,
    ...validation.results.map((result): AgentCheck => ({
      label: CHECK_LABEL[result.kind] ?? result.kind,
      state: result.status === 'passed' ? 'ok' : result.status === 'skipped' ? 'skip' : 'fail',
      detail: result.kind === 'test' && (result.testsPassed !== undefined || result.testsFailed !== undefined) ? `${result.testsPassed ?? 0}/${(result.testsPassed ?? 0) + (result.testsFailed ?? 0)}` : result.status === 'passed' ? 'ok' : result.status === 'skipped' ? '–' : result.errorCount ? `${result.errorCount} Fehler` : 'rot',
    })),
  ]
}

function logTone(type: string, level: string, message: string): Tone {
  if (level === 'error' || /failed|rejected|conflict/.test(type)) return 'err'
  if (/repair|escalat|requeued/.test(type) || /repair/i.test(message)) return 'tool'
  if (/integrated|passed|ready/.test(type) || /\bok\b|passed/i.test(message)) return 'ok'
  return 'muted'
}

/** Expected share of the work done; time-based while running (asymptotic, never reaches 100 %). */
function progressOf(subtask: Subtask, expectedMs: number, now: number): number {
  if (['completed', 'failed', 'skipped', 'cancelled'].includes(subtask.status)) return 1
  if (!ACTIVE.has(subtask.status)) return 0
  const elapsed = subtask.startedAt ? Math.max(0, now - Date.parse(subtask.startedAt)) : 0
  const base = 1 - Math.exp(-elapsed / Math.max(10_000, expectedMs))
  if (subtask.status === 'validating') return Math.max(0.8, Math.min(0.95, base))
  if (subtask.status === 'repairing') return Math.max(0.55, Math.min(0.9, base))
  return Math.min(0.78, Math.max(0.05, base))
}

export function agentCards(input: {
  subtasks: Subtask[]
  plan?: TaskPlan
  runs?: AgentRun[]
  events?: RunEvent[]
  live?: LiveLine[]
  forecast?: ScheduleForecast
  now?: number
  /** Names of agent profiles by id (a subtask can be assigned to a profile). */
  agentNames?: Record<string, string>
}): AgentCard[] {
  const { subtasks, plan, runs = [], events = [], live = [], forecast } = input
  const now = input.now ?? Date.now()
  return subtasks.map((subtask) => {
    const assignment = plan?.modelAssignments.find((entry) => entry.subtaskId === subtask.id || entry.key === subtask.key)
    const escalated = subtask.manualModel === 'premium'
    const kind: AgentKind = subtask.fastPath ? 'tool' : escalated || subtask.selectedModelClass === 'premium_llm' ? 'premium' : subtask.selectedModelClass === 'local_llm' ? 'local' : 'blocked'
    const tone: Tone = kind === 'premium' ? 'accent' : kind === 'local' ? 'local' : kind === 'tool' ? 'tool' : 'err'
    const subtaskRuns = runs.filter((run) => run.subtaskId === subtask.id)
    const lastRun = subtaskRuns.at(-1)
    const model = kind === 'premium' ? (escalated ? 'Premium-Orchestrator' : subtask.selectedModelName ?? 'Premium') : kind === 'tool' ? 'ohne Modell' : lastRun?.selectedModelName ?? subtask.manualModel ?? subtask.selectedModelName ?? 'nicht zugewiesen'
    const own = events.filter((event) => event.subtaskId === subtask.id)
    const ownLive = live.filter((line) => line.subtaskId === subtask.id && !own.some((event) => event.message === line.message))
    const logs = [...own.map((event) => ({ at: event.createdAt, text: localizeEngineText(event.message), tone: logTone(event.type, event.level, event.message) })), ...ownLive.map((line) => ({ at: line.ts, text: line.message, tone: logTone(line.type, line.level, line.message) }))]
      .filter((entry) => entry.text.trim())
      .slice(-200)
    const worktree = [...own].reverse().find((event) => event.type === 'worktree_created')?.data?.path as string | undefined
    const tier = assignment?.tier
    const role = escalated ? 'Eskaliert an Premium (manuell)' : kind === 'premium' ? `Premium${assignment?.reasons?.[0] ? ` – ${localizeReason(assignment.reasons[0])}` : ''}` : kind === 'tool' ? 'Deterministisches Werkzeug' : kind === 'blocked' ? 'Keine Zuordnung' : `${TIER_LABEL[tier ?? ''] ?? 'Lokal'} (lokal)`
    const forecastEntry = forecast?.tasks[subtask.key]
    const expected = forecastEntry && forecast ? (forecast.waves[forecastEntry.wave ?? 0]?.durationMs ?? 90_000) : 90_000
    const tokens = subtaskRuns.reduce((sum, run) => sum + (run.inputTokens ?? 0) + (run.outputTokens ?? 0), 0)
    const status = subtask.status
    const waitDetail = status === 'planned' || status === 'queued' ? forecastEntry?.detail ?? (subtask.dependsOn.length ? `wartet auf ${subtask.dependsOn.join(', ')}` : undefined) : undefined
    const lastLog = logs.at(-1)?.text ?? (status === 'planned' ? waitDetail ?? `bereit · ${role}` : status === 'queued' ? waitDetail ?? 'wartet …' : subtask.errorMessage ?? '–')
    return {
      id: subtask.id,
      key: subtask.key,
      title: subtask.title,
      goal: subtask.goal,
      kind,
      tone,
      icon: kind === 'premium' ? 'sparkles' : kind === 'tool' ? 'wrench' : kind === 'blocked' ? 'ban' : 'cpu',
      profile: subtask.agentId ? input.agentNames?.[subtask.agentId] : undefined,
      agent: subtask.agentId && input.agentNames?.[subtask.agentId] ? input.agentNames[subtask.agentId]! : kind === 'premium' ? 'Premium-Agent' : kind === 'tool' ? 'Werkzeug' : kind === 'blocked' ? 'Nicht zugeordnet' : `Coder ${TIER_LABEL[tier ?? ''] ?? 'Lokal'}`,
      role,
      model,
      short: shortModel(model, kind),
      status,
      statusLabel: SUBTASK_STATUS[status] ?? status,
      statusTone: STATUS_TONE[status] ?? 'muted',
      active: ACTIVE.has(status),
      progress: progressOf(subtask, expected, now),
      lastLog: lastLog.replace(/\s+/g, ' '),
      logs,
      tokens,
      tokensMeasured: subtaskRuns.every((run) => run.tokensMeasured),
      attempts: subtask.attempts,
      deps: subtask.dependsOn,
      worktree,
      files: subtask.patchStats?.files ?? [...subtask.allowedFiles, ...subtask.newFiles].map((path) => ({ path, added: null, deleted: null, status: 'geplant' })),
      checks: checksOf(subtask),
      escalated,
      wave: forecastEntry?.wave,
      waitDetail,
      critical: Boolean(forecastEntry?.critical),
    }
  })
}

export interface Decision {
  at: string
  text: string
  tone: Tone
}

const time = (value?: string) => (value ? new Date(value).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '')

/** Decisions of the orchestrator and the run in chronological order (routing, waits, repairs …). */
export function decisions(input: { task?: Task; plan?: TaskPlan; subtasks: Subtask[]; events?: RunEvent[]; forecast?: ScheduleForecast }): Decision[] {
  const { plan, subtasks, events = [], forecast } = input
  const out: Array<Decision & { sort: number }> = []
  const planAt = plan?.createdAt ?? input.task?.createdAt
  const push = (at: string | undefined, text: string, tone: Tone = 'muted') => out.push({ at: time(at), text, tone, sort: at ? Date.parse(at) : 0 })
  if (plan?.source === 'deterministic-fallback') push(planAt, 'Fallback-Plan: der Orchestrator war nicht verfügbar, die Zerlegung ist heuristisch.', 'tool')
  if (plan?.source === 'fast-path') push(planAt, 'Fast Path: kleine Änderung ohne Premium-Planung.', 'local')
  for (const assignment of plan?.modelAssignments ?? []) {
    if (assignment.executor === 'premium') push(planAt, `${assignment.key} an Premium: ${localizeReason(assignment.reasons[0] ?? 'Einstufung des Routers')}.`, 'accent')
    if (assignment.executor === 'blocked') push(planAt, `${assignment.key} ohne ausführbare Zuordnung – Modell wählen oder neu planen.`, 'err')
  }
  for (const subtask of subtasks) {
    if (subtask.manualModel === 'premium') push(planAt, `${subtask.key} manuell an Premium eskaliert.`, 'accent')
    const wait = forecast?.tasks[subtask.key]
    if (subtask.dependsOn.length && (!wait || wait.reason === 'dependencies')) push(planAt, `${subtask.key} wartet auf ${subtask.dependsOn.join(', ')}, weil es deren Ergebnis braucht.`)
    else if (wait && ['file_conflict', 'memory', 'local_slot'].includes(wait.reason) && subtask.status === 'planned') push(planAt, `${subtask.key} ${wait.detail}.`)
  }
  for (const event of events) {
    const key = /^(\S+?):/.exec(event.message)?.[1]
    if (event.type === 'dag_conflict_edge') push(event.createdAt, `Serialisiert: ${event.message.replace(/ waits for /, ' wartet auf ').replace(/\(both modify (.+)\)\.?/, '(gleiche Datei: $1).')}`)
    else if (event.type === 'validation_failed') push(event.createdAt, `${key ?? 'Teilaufgabe'}: Prüfung rot – Reparatur statt Neuplanung, der Fehler ist lokal begrenzt.`, 'tool')
    else if (event.type === 'task_escalated') push(event.createdAt, `${key}: eskaliert an ${/premium/.test(event.message) ? 'Premium' : event.message.split('escalating to ')[1]?.replace(/\.$/, '') ?? 'stärkeres Modell'}.`, 'accent')
    else if (event.type === 'integration_conflict') push(event.createdAt, `${key}: Konflikt mit bereits integrierter Arbeit – läuft auf neuem Stand erneut.`, 'tool')
    else if (event.type === 'premium_unavailable' || event.type === 'model_unavailable') push(event.createdAt, localizeEngineText(event.message), 'err')
    else if (event.type === 'review_fix_started') push(event.createdAt, 'Review fand Blocker: eine Korrekturrunde läuft.', 'tool')
  }
  return out.sort((a, b) => a.sort - b.sort).map(({ sort: _sort, ...decision }) => decision)
}

export interface Milestone {
  at: string
  key: string
  text: string
  tone: Tone
}

/** Short agent updates for the orchestrator chat ("T2 fertig · integriert"). */
export function milestones(events: RunEvent[], subtasks: Subtask[]): Milestone[] {
  const kindOf = (id?: string | null) => {
    const subtask = subtasks.find((entry) => entry.id === id)
    return subtask?.selectedModelClass === 'premium_llm' || subtask?.manualModel === 'premium' ? 'accent' : 'local'
  }
  const out: Milestone[] = []
  for (const event of events) {
    const key = subtasks.find((entry) => entry.id === event.subtaskId)?.key ?? /^(T?\S+?):/.exec(event.message)?.[1] ?? ''
    const add = (text: string, tone?: Tone) => out.push({ at: event.createdAt, key: key || 'Lauf', text, tone: tone ?? (kindOf(event.subtaskId) as Tone) })
    switch (event.type) {
      case 'task_integrated': {
        const files = /\((\d+) file/.exec(event.message)?.[1]
        const tests = /tests (\d+) passed/.exec(event.message)?.[1]
        add(`fertig · integriert${files ? ` · ${files} Datei(en)` : ''}${tests ? ` · ${tests} Tests ok` : ''}`)
        break
      }
      case 'validation_failed':
        add('Prüfung fehlgeschlagen, Reparatur folgt', 'tool')
        break
      case 'task_escalated':
        add(/premium/.test(event.message) ? 'eskaliert an Premium' : 'eskaliert an stärkeres Modell', 'accent')
        break
      case 'integration_conflict':
        add('Integrationskonflikt – läuft erneut', 'tool')
        break
      case 'task_state':
        if (event.data?.state === 'failed') add('fehlgeschlagen', 'err')
        break
      case 'run_ready':
      case 'review_done':
        out.push({ at: event.createdAt, key: 'Lauf', text: event.type === 'review_done' ? 'Review abgeschlossen' : 'Integration ok, Review läuft', tone: 'accent' })
        break
    }
  }
  return out
}

/** Share of the run's tokens that local models produced (for the header meter). */
export function tokenShare(execution: ExecutionRun | undefined): { localPct: number; total: number } {
  const usage = execution?.usage
  if (!usage) return { localPct: 0, total: 0 }
  const local = usage.local.inputTokens + usage.local.outputTokens
  const premium = usage.premium.inputTokens + usage.premium.outputTokens
  const total = local + premium
  return { localPct: total ? Math.round((local / total) * 100) : 0, total }
}

export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
