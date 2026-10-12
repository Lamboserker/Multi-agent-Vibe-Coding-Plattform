import { useState } from 'react'
import { FolderOpen, FolderPlus, GitFork } from 'lucide-react'
import { api, bridge, errorMessage } from '../../lib/api'
import { useLoader } from '../../lib/hooks'
import { useApp } from '../../lib/store'
import type { Project } from '../../lib/types'
import { AsyncButton, Empty, PanelHeader } from '../common'

export function ProjectSetup({ onOpened }: { onOpened?: (project: Project) => void }) {
  const { openProjectPath, notify } = useApp()
  const [mode, setMode] = useState<'none' | 'new' | 'clone'>('none')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [parentDir, setParentDir] = useState('')

  const pickParent = async () => {
    const folder = await bridge().dialog.openFolder('Zielordner wählen')
    if (folder) setParentDir(folder)
  }

  return (
    <div className="stack">
      <div className="row wrap">
        <AsyncButton
          className="btn primary"
          onClick={async () => {
            const folder = await bridge().dialog.openFolder('Repository oder Projektordner öffnen')
            if (!folder) return
            await openProjectPath(folder)
            onOpened?.(undefined as unknown as Project)
          }}
        >
          <FolderOpen size={14} /> Ordner öffnen
        </AsyncButton>
        <button className="btn" onClick={() => setMode(mode === 'new' ? 'none' : 'new')}>
          <FolderPlus size={14} /> Neues Projekt
        </button>
        <button className="btn" onClick={() => setMode(mode === 'clone' ? 'none' : 'clone')}>
          <GitFork size={14} /> Klonen
        </button>
      </div>
      {mode !== 'none' ? (
        <div className="card stack">
          {mode === 'clone' ? <input className="input" placeholder="https://github.com/org/repo.git" value={url} onChange={(event) => setUrl(event.target.value)} /> : null}
          <input className="input" placeholder={mode === 'new' ? 'Projektname (z. B. my-app)' : 'Ordnername (optional)'} value={name} onChange={(event) => setName(event.target.value)} />
          <div className="row">
            <input className="input" placeholder="Übergeordneter Ordner" value={parentDir} onChange={(event) => setParentDir(event.target.value)} />
            <button className="btn" onClick={() => void pickParent()}>
              …
            </button>
          </div>
          <AsyncButton
            className="btn primary"
            disabled={!parentDir || (mode === 'new' ? !name : !url)}
            onClick={async () => {
              try {
                const project =
                  mode === 'new'
                    ? await api.post<Project>('/projects/new', { parentDir, name })
                    : await api.post<Project>('/projects/clone', { url, parentDir, name: name || undefined })
                await openProjectPath(project.repoPath)
                setMode('none')
                notify(mode === 'new' ? 'Projekt angelegt (git init + erster Commit).' : 'Repository geklont.', 'success')
                onOpened?.(project)
              } catch (error) {
                notify(errorMessage(error), 'error')
              }
            }}
          >
            {mode === 'new' ? 'Anlegen' : 'Klonen'}
          </AsyncButton>
        </div>
      ) : null}
    </div>
  )
}

export function ProjectsPanel() {
  const { project, selectProject, notify } = useApp()
  const { data: projects, reload } = useLoader(() => api.get<Project[]>('/projects'), [project?.id])
  return (
    <>
      <PanelHeader title="Projekte" />
      <div className="panel-body stack">
        <ProjectSetup onOpened={() => void reload()} />
        <div className="section-title" style={{ marginTop: 8 }}>
          Zuletzt geöffnet
        </div>
        {!projects?.length ? <Empty>Noch keine Projekte.</Empty> : null}
        {projects?.map((entry) => (
          <div
            key={entry.id}
            className={`tree-item ${entry.id === project?.id ? 'selected' : ''}`}
            style={{ flexDirection: 'column', alignItems: 'flex-start', padding: '6px 8px' }}
            onClick={async () => {
              try {
                await selectProject(entry)
              } catch (error) {
                notify(errorMessage(error), 'error')
              }
            }}
          >
            <strong>{entry.name}</strong>
            <span className="faint truncate" style={{ maxWidth: '100%', fontSize: 11 }}>
              {entry.repoPath}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
