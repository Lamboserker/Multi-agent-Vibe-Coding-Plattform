import type { ExecutionRun, Task } from './types'

export type WorkflowPhase = 'task' | 'plan' | 'execution' | 'approval'
export type WorkflowState = 'draft' | 'planning' | 'plan_error' | 'ready' | 'running' | 'paused' | 'recoverable' | 'cancelled' | 'approval' | 'done'

export const SUBTASK_STATUS: Record<string, string> = {
  planned: 'geplant', queued: 'wartet', running: 'läuft', validating: 'validiert', repairing: 'repariert', completed: 'fertig', failed: 'fehlgeschlagen',
  skipped: 'übersprungen', cancelled: 'abgebrochen', blocked: 'blockiert', pending: 'wartet', integrating: 'integriert', awaiting_approval: 'Freigabe nötig',
  applied: 'übernommen', interrupted: 'unterbrochen', paused: 'pausiert',
}

/** One presentation of the active task's lifecycle for the workflow and navigation links. */
export function workflowState(task?: Task, execution?: ExecutionRun): { phase: WorkflowPhase; state: WorkflowState; label: string } {
  if (!task) return { phase: 'task', state: 'draft', label: 'Aufgabe beschreiben' }
  if (task.currentStep === 'planning') return { phase: 'plan', state: 'planning', label: 'Planung läuft' }
  if (['plan_failed', 'plan_interrupted'].includes(task.currentStep)) return { phase: 'plan', state: 'plan_error', label: 'Planung erneut starten' }
  // a new plan after a failed or ended run replaces that run in the workflow
  const planAfterRun = task.currentStep === 'awaiting_plan_approval' && task.subtasks.length > 0 && ['failed', 'interrupted', 'cancelled'].includes(execution?.status ?? '')
  if (execution && execution.taskId === task.id && !planAfterRun) {
    switch (execution.status) {
      case 'awaiting_approval': return { phase: 'approval', state: 'approval', label: 'Änderungen prüfen und freigeben' }
      case 'applied':
      case 'completed': return { phase: 'approval', state: 'done', label: 'Abgeschlossen' }
      case 'paused': return { phase: 'execution', state: 'paused', label: 'Ausführung pausiert' }
      case 'failed':
      case 'interrupted': return { phase: 'execution', state: 'recoverable', label: 'Ausführung fortsetzen' }
      case 'cancelled': return { phase: 'execution', state: 'cancelled', label: 'Ausführung abgebrochen' }
      case 'awaiting_plan_approval': return { phase: 'plan', state: 'ready', label: 'Plan prüfen' }
      default: return { phase: 'execution', state: 'running', label: execution.status === 'integrating' ? 'Änderungen werden geprüft' : 'Ausführung läuft' }
    }
  }
  if (task.subtasks.length && ['planned', 'awaiting_plan_approval'].includes(task.currentStep)) return { phase: 'plan', state: 'ready', label: 'Plan prüfen' }
  return { phase: 'task', state: 'draft', label: 'Aufgabe beschreiben' }
}
