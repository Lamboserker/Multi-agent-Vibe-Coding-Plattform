import { LocalModelManager } from '../models/LocalModelManager'
import { PanelHeader } from '../common'

export function ModelsPanel() {
  return (
    <>
      <PanelHeader title="Lokale Modelle" />
      <div className="panel-body">
        <LocalModelManager />
      </div>
    </>
  )
}
