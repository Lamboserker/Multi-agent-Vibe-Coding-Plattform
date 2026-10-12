import type { ChatSession } from '@prisma/client'
import { jsonObject } from '../common/json.js'

export const SESSION_STATUSES = ['active', 'idle', 'running', 'paused', 'interrupted', 'completed', 'failed', 'archived'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

/** A session without user interaction for this long is shown as idle. */
const ACTIVE_WINDOW_MS = 15 * 60_000
export const DEFAULT_TITLE = 'Neue Sitzung'
export const RUNNING_EXECUTION = ['pending', 'planning', 'running', 'integrating']
export const RUN_CONFIRMATION = /^(start|run|go|execute|ausführen|ausfuehren|starte|los|ja|ok)\b/i

export interface StatusInputs {
  session: Pick<ChatSession, 'archivedAt' | 'lastActivityAt' | 'recovery'>
  /** Latest task first. */
  tasks: Array<{ id: string; status: string; currentStep: string; executions: Array<{ status: string }> }>
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
  if (execution?.status === 'interrupted' || latest?.currentStep === 'plan_interrupted' || recovery.interruptedAsk) return 'interrupted'
  if (execution?.status === 'failed' || latest?.currentStep === 'plan_failed' || (latest?.status === 'failed' && !execution)) return 'failed'
  if (execution?.status === 'applied' || latest?.status === 'completed') return 'completed'
  if (execution?.status === 'awaiting_approval' || latest?.currentStep === 'awaiting_plan_approval') return 'active'
  return now - new Date(session.lastActivityAt).getTime() < ACTIVE_WINDOW_MS ? 'active' : 'idle'
}

export function titleFrom(content: string): string {
  const line = content.replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || DEFAULT_TITLE
}
