import { api, enc, errorMessage } from './api'
import * as actions from './actions'
import type { ExecutionRun } from './types'

/** Opens a file as the agents left it (integration branch) against its state at the run's base. */
export async function openAgentVersion(execution: Pick<ExecutionRun, 'id'>, path: string) {
  try {
    const file = await api.get<{ path: string; base: string | null; result: string | null }>(`/executions/${execution.id}/file?path=${enc(path)}`)
    if (file.base === null && file.result === null) {
      actions.notify(`${path} ist im Agentenergebnis nicht vorhanden.`, 'info')
      return
    }
    const name = path.split('/').pop() ?? path
    // a new file has no base: its full content is shown
    actions.openDiff({ title: `Agenten: ${name}`, path, original: file.base ?? '', modified: file.result ?? '' })
  } catch (error) {
    actions.notify(errorMessage(error), 'error')
  }
}

/** Applied runs: the working copy has the change, otherwise the agent version is shown. */
export function openChangedFile(execution: ExecutionRun | undefined, path: string) {
  if (!execution || execution.status === 'applied' || execution.applyRecords?.some((record) => record.status === 'applied' && record.mode === 'working_tree')) return actions.openFile(path)
  return openAgentVersion(execution, path)
}
