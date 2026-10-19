import { api } from './api'
import * as actions from './actions'
import { createStore, useStore } from './store/core'
import { sessionStore } from './stores'
import type { ExecutionRun } from './types'
import { explainApplyRejection } from './engine-text'

const busyStore = createStore<{ targets: Record<string, boolean> }>({ targets: {} })
export const useWorkflowBusy = (target: string) => useStore(busyStore, (state) => Boolean(state.targets[target]))

/** Only one lifecycle mutation per task/run, even when two different controls are clicked quickly. */
async function mutate<T>(target: string, operation: () => Promise<T>): Promise<T> {
  if (busyStore.get().targets[target]) throw new Error('Dieser Arbeitsschritt wird bereits ausgeführt.')
  busyStore.set((state) => ({ targets: { ...state.targets, [target]: true } }))
  try { return await operation() }
  finally {
    busyStore.set((state) => {
      const targets = { ...state.targets }
      delete targets[target]
      return { targets }
    })
  }
}

async function refresh(taskId: string, executionId?: string) {
  if (sessionStore.get().task?.id === taskId) {
    if (executionId && sessionStore.get().execution?.id === executionId) await actions.reloadExecution(executionId)
    if (sessionStore.get().task?.id === taskId) await actions.reloadTask()
  }
  void actions.loadActivity()
}

export function startTask(taskId: string) {
  return mutate(`task:${taskId}`, async () => {
    await api.post(`/tasks/${taskId}/execute`)
    await refresh(taskId)
  })
}

export function replanTask(taskId: string, feedback?: string) {
  return mutate(`task:${taskId}`, async () => {
    await api.post(`/tasks/${taskId}/plan-with-orchestrator`, { feedback })
    await refresh(taskId)
  })
}

export function controlRun(execution: ExecutionRun, control: 'pause' | 'resume' | 'continue' | 'cancel') {
  return mutate(`execution:${execution.id}`, async () => {
    await api.post(`/executions/${execution.id}/${control}`)
    await refresh(execution.taskId, execution.id)
  })
}

export function approveRun(execution: ExecutionRun, mode: 'working_tree' | 'branch' | 'fast_forward' | 'commit') {
  return mutate(`execution:${execution.id}`, async () => {
    const result = await api.post<{ ok: boolean; message: string; blockedBy?: string[] }>(`/executions/${execution.id}/approve`, { mode })
    // a refusal is explained on the approval screen; the toast says it in short
    actions.notify(result.ok ? result.message : `Übernahme nicht möglich: ${explainApplyRejection(result.message).text}`, result.ok ? 'success' : 'error')
    await refresh(execution.taskId, execution.id)
    return result
  })
}

export function discardRun(execution: ExecutionRun) {
  return mutate(`execution:${execution.id}`, async () => {
    await api.post(`/executions/${execution.id}/discard`)
    await refresh(execution.taskId, execution.id)
  })
}

export function undoRun(execution: ExecutionRun, recordId: string) {
  return mutate(`execution:${execution.id}`, async () => {
    const result = await api.post<{ ok: boolean; message: string }>(`/apply-records/${recordId}/undo`)
    actions.notify(result.message, result.ok ? 'success' : 'error')
    await refresh(execution.taskId, execution.id)
    return result
  })
}
