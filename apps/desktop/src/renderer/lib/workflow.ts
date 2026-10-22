import type { DesignMode, ExecutionRun, Task } from './types'

export type WorkflowPhase = 'task' | 'plan' | 'execution' | 'approval'
export type WorkflowState = 'draft' | 'designing' | 'design_review' | 'design_error' | 'planning' | 'plan_error' | 'plan_questions' | 'ready' | 'running' | 'paused' | 'recoverable' | 'cancelled' | 'approval' | 'done'

export const SUBTASK_STATUS: Record<string, string> = {
  planned: 'geplant', queued: 'wartet', running: 'läuft', validating: 'validiert', repairing: 'repariert', completed: 'fertig', failed: 'fehlgeschlagen',
  skipped: 'übersprungen', cancelled: 'abgebrochen', blocked: 'blockiert', pending: 'wartet', integrating: 'integriert', awaiting_approval: 'Freigabe nötig',
  applied: 'übernommen', interrupted: 'unterbrochen', paused: 'pausiert',
}

/** One presentation of the active task's lifecycle for the workflow and navigation links. */
export function workflowState(task?: Task, execution?: ExecutionRun): { phase: WorkflowPhase; state: WorkflowState; label: string } {
  if (!task) return { phase: 'task', state: 'draft', label: 'Aufgabe beschreiben' }
  // the design phase precedes planning (UI tasks): draft → approval → plan
  if (task.currentStep === 'designing') return { phase: 'plan', state: 'designing', label: 'Design-Entwurf läuft' }
  if (task.currentStep === 'awaiting_design_approval') return { phase: 'plan', state: 'design_review', label: 'Design prüfen' }
  if (task.currentStep === 'design_failed') return { phase: 'plan', state: 'design_error', label: 'Design neu entwerfen' }
  if (task.currentStep === 'planning') return { phase: 'plan', state: 'planning', label: 'Planung läuft' }
  if (['plan_failed', 'plan_interrupted'].includes(task.currentStep)) return { phase: 'plan', state: 'plan_error', label: 'Planung erneut starten' }
  if (task.currentStep === 'plan_clarification') return { phase: 'plan', state: 'plan_questions', label: 'Rückfragen beantworten' }
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

/** States before a plan exists: the Leitstand shows the design or planning area instead of agents. */
export function isPrePlan(state: WorkflowState): boolean {
  return ['draft', 'designing', 'design_review', 'design_error', 'planning', 'plan_error', 'plan_questions'].includes(state)
}

/** States in which a premium call or a run is working right now (pulse, spinner, clock). */
export function isWorking(state: WorkflowState): boolean {
  return state === 'running' || state === 'planning' || state === 'designing'
}

export const DESIGN_MODES: Array<{ id: DesignMode; label: string; title: string }> = [
  { id: 'auto', label: 'Automatisch', title: 'Design-Entwurf nur bei UI-Aufgaben (Dashboard, Landingpage, Formular …)' },
  { id: 'force', label: 'Immer', title: 'Vor der Planung immer einen Design-Entwurf erstellen' },
  { id: 'skip', label: 'Überspringen', title: 'Ohne Design-Entwurf direkt planen' },
]

/**
 * Composer change after sending: the text is cleared and an explicitly sent design mode is reset to unset
 * (automatic), so later follow-ups do not override the task's own choice (e.g. "Ohne Design planen").
 */
export function composerAfterSend(designMode: DesignMode | undefined): { text: string; designMode?: undefined } {
  return designMode ? { text: '', designMode: undefined } : { text: '' }
}

/** The design mode a message sends: only for tasks and only when chosen (a persisted draft may hold anything). */
export function designModeOf(mode: 'task' | 'ask', designMode: unknown): DesignMode | undefined {
  return mode === 'task' && DESIGN_MODES.some((entry) => entry.id === designMode) ? (designMode as DesignMode) : undefined
}
