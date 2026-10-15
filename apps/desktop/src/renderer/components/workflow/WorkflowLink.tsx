import * as actions from '../../lib/actions'

/** Detail surfaces navigate here instead of duplicating task/run mutations and approval buttons. */
export function WorkflowLink() {
  return <button className="btn small" onClick={() => void actions.openWorkflow()}>Zum Arbeitsablauf</button>
}
