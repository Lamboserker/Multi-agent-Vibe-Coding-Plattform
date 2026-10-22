import type { ChatSession } from '@prisma/client'
import { jsonObject } from '../common/json.js'

export const SESSION_STATUSES = ['active', 'idle', 'running', 'paused', 'interrupted', 'completed', 'failed', 'archived'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

/** A session without user interaction for this long is shown as idle. */
const ACTIVE_WINDOW_MS = 15 * 60_000
export const DEFAULT_TITLE = 'Neue Sitzung'
export const RUNNING_EXECUTION = ['pending', 'planning', 'running', 'integrating']
export const RUN_CONFIRMATION = /^(start|run|go|execute|ausführen|ausfuehren|starte|los|ja|ok)\b/i
/**
 * Approval of a design draft in the chat. Unlike RUN_CONFIRMATION (a prefix match) the whole message must be
 * a confirmation, polite fillers and emoji (thumbs up, check mark, OK hand, rocket) included: "ok, aber dunkler" is feedback for the next draft.
 */
export const DESIGN_APPROVAL =
  /^(?:(?:ok(?:ay)?|passt(?: so)?|ja|jep|jo|yes|los|go|start|starte|mach weiter|weiter|freigeben|freigabe|gib(?: es)? frei|sieht (?:sehr )?gut aus|gefällt mir(?: sehr)?(?: gut)?|einverstanden|sehr gut|gut|prima|klasse|super|perfekt|top|toll|genau(?: so)?|bitte|danke(?: ?schön)?|vielen dank|gerne?|run|ausführen|ausfuehren|lgtm|\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?|\u2705|\u{1F44C}|\u{1F680})[\s,.!\uFE0F]*)+$/iu

/**
 * Hints that a short answer to a draft is a change request: word stems (prefix match) and short words (whole
 * word) for changes, design properties and colours, German and English.
 */
const CHANGE_STEMS = /(?:^|[^\p{L}])(?:dunk|hell|größ|groß|gross|klein|änder|aender|anders|mach|farb|weniger|anstatt|statt|füg|fueg|hinzu|entfern|lösch|loesch|breit|schmal|rund|eckig|schrift|font|abstand|kontrast|layout|button|knopf|icon|logo|bild|header|footer|menü|menu|navi|sidebar|spalte|animat|bunt|modern|minimal|schlicht|verspielt|seriös|blau|grün|gruen|gelb|schwarz|weiß|weiss|lila|violett|orange|grau|pink|türkis|dark|light|bigger|smaller|larger|change|remove|without|instead|colou?r|lieber|besser|another|different)/iu
const CHANGE_WORDS = /(?:^|[^\p{L}])(?:zu|rot(?:e[mnrs]?)?|mehr|ohne|weg|neu|nicht|kein(?:e[mnrs]?)?|aber|add|more|less|other|not|no)(?![\p{L}])/iu

/** At most this many words without a change hint (and no approval): ask back instead of drafting again. */
const UNCLEAR_MAX_WORDS = 4

/**
 * How a chat message answers an open design draft: approval, feedback (a new, paid draft) or unclear (a short
 * reply without any change hint – the chat asks back instead of spending a premium call on it).
 */
export function designAnswer(content: string): 'approval' | 'feedback' | 'unclear' {
  const text = content.trim()
  if (DESIGN_APPROVAL.test(text)) return 'approval'
  const words = text.split(/\s+/).filter(Boolean).length
  return words <= UNCLEAR_MAX_WORDS && !CHANGE_STEMS.test(text) && !CHANGE_WORDS.test(text) ? 'unclear' : 'feedback'
}

export interface StatusInputs {
  session: Pick<ChatSession, 'archivedAt' | 'lastActivityAt' | 'recovery'>
  /** Latest task first. */
  tasks: Array<{ id: string; status: string; currentStep: string; executions: Array<{ status: string }> }>
  /** Tasks with a queued or running plan or design job. */
  activePlanTaskIds: Set<string>
  askRunning: boolean
  now: number
}

/**
 * Pure status derivation (unit-tested). The status always reflects what is actually happening in the
 * runtime: a run that no longer has a process is never reported as running.
 */
export function deriveSessionStatus({ session, tasks, activePlanTaskIds, askRunning, now }: StatusInputs): SessionStatus {
  if (session.archivedAt) return 'archived'
  const recovery = jsonObject(session.recovery)
  const latest = tasks[0]
  const execution = latest?.executions[0]
  if (askRunning || tasks.some((task) => activePlanTaskIds.has(task.id)) || tasks.some((task) => RUNNING_EXECUTION.includes(task.executions[0]?.status ?? ''))) return 'running'
  if (execution?.status === 'paused') return 'paused'
  // waiting for the user: answers to the planner's questions or the decision on a design draft
  if (latest?.currentStep === 'plan_clarification' || latest?.currentStep === 'awaiting_design_approval') return 'active'
  if (execution?.status === 'interrupted' || latest?.currentStep === 'plan_interrupted' || recovery.interruptedAsk) return 'interrupted'
  if (execution?.status === 'failed' || latest?.currentStep === 'plan_failed' || latest?.currentStep === 'design_failed' || (latest?.status === 'failed' && !execution)) return 'failed'
  if (execution?.status === 'applied' || latest?.status === 'completed') return 'completed'
  if (execution?.status === 'awaiting_approval' || latest?.currentStep === 'awaiting_plan_approval') return 'active'
  return now - new Date(session.lastActivityAt).getTime() < ACTIVE_WINDOW_MS ? 'active' : 'idle'
}

export function titleFrom(content: string): string {
  const line = content.replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || DEFAULT_TITLE
}
