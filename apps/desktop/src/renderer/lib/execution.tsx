import type { ReactNode } from 'react'
import * as actions from './actions'
import { shallowEqual, useStore } from './store/core'
import { sessionStore } from './stores'

/** Execution state lives in sessionStore (runtime-backed); kept so existing trees still compose. */
export function ExecutionProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

/** Task and run of the active session. Live log lines are separate (useLiveState) to keep re-renders cheap. */
export function useExecution() {
  const state = useStore(
    sessionStore,
    (session) => ({ task: session.task, execution: session.execution, events: session.events, selectedSubtaskId: session.selectedSubtaskId }),
    shallowEqual,
  )
  return {
    ...state,
    reloadTask: actions.reloadTask,
    reloadExecution: actions.reloadExecution,
    setSelectedSubtaskId: actions.setSelectedSubtask,
  }
}
