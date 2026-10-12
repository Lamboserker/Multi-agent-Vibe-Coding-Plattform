import { useCallback, useEffect, useState } from 'react'
import { Minus, Plus, RefreshCw, Undo2 } from 'lucide-react'
import { api, enc, errorMessage } from '../../lib/api'
import { updateWorkspace } from '../../lib/actions'
import { useAppEvents, useIsVisible, useThrottled } from '../../lib/hooks'
import { useApp, useAppState } from '../../lib/store'
import type { GitStatus, GitStatusEntry } from '../../lib/types'
import { AsyncButton, Confirm, Empty, PanelHeader } from '../common'

export function GitPanel() {
  const { project, openDiff, notify } = useApp()
  const [status, setStatus] = useState<GitStatus>()
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean }>>([])
  const [log, setLog] = useState<Array<{ sha: string; subject: string; author: string; date: string }>>([])
  // The commit message is a persisted draft of the project's workspace (survives view switches and restarts).
  const message = useAppState((state) => state.workspace.gitMessage)
  const setMessage = (gitMessage: string) => updateWorkspace({ gitMessage })
  const visible = useIsVisible()
  const [discard, setDiscard] = useState<string[]>()

  const load = useCallback(async () => {
    if (!project) return
    try {
      const next = await api.get<GitStatus>(`/projects/${project.id}/git/status`)
      setStatus(next)
      if (next.isRepo) {
        setBranches(await api.get(`/projects/${project.id}/git/branches`))
        setLog(await api.get(`/projects/${project.id}/git/log?limit=25`))
      }
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }, [project, notify])
  const throttled = useThrottled(() => void load(), 700)

  useEffect(() => {
    if (visible) void load()
  }, [load, visible])
  useAppEvents((event) => {
    if (event.channel === 'project' && event.type === 'files_changed' && event.data.projectId === project?.id) throttled()
  })

  if (!project) return <><PanelHeader title="Git" /><Empty>Kein Projekt geöffnet.</Empty></>
  if (status && !status.isRepo) {
    return (
      <>
        <PanelHeader title="Git" />
        <div className="panel-body stack">
          <div className="callout warn">Dieser Ordner ist kein Git-Repository. Isolierte Agenten-Ausführung benötigt Git (Worktrees).</div>
          <AsyncButton className="btn primary" onClick={async () => { await api.post(`/projects/${project.id}/git/init`); await load() }}>
            Git initialisieren (mit erstem Commit)
          </AsyncButton>
        </div>
      </>
    )
  }

  const entries = status?.isRepo ? status.entries : []
  const staged = entries.filter((entry) => !entry.untracked && entry.index !== ' ' && entry.index !== '?')
  const unstaged = entries.filter((entry) => entry.untracked || entry.worktree !== ' ')

  const showDiff = async (entry: GitStatusEntry) => {
    try {
      const head = await api.get<{ content: string | null }>(`/projects/${project.id}/git/head-file?path=${enc(entry.path)}`)
      const current = entry.worktree === 'D' ? { content: '' } : await api.get<{ content: string }>(`/projects/${project.id}/file?path=${enc(entry.path)}`)
      openDiff({ title: `${entry.path.split('/').pop()} (HEAD ↔ Arbeitskopie)`, path: entry.path, original: head.content ?? '', modified: current.content })
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }

  const act = async (path: string, body: unknown) => {
    try {
      setStatus(await api.post<GitStatus>(`/projects/${project.id}/git/${path}`, body))
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }

  const row = (entry: GitStatusEntry, isStaged: boolean) => (
    <div key={`${isStaged}-${entry.path}`} className="tree-item" onClick={() => void showDiff(entry)} title={entry.path}>
      <span className="name">{entry.path}</span>
      <span className={`git-mark ${isStaged ? entry.index : entry.untracked ? 'U' : entry.worktree}`}>{isStaged ? entry.index : entry.untracked ? 'U' : entry.worktree}</span>
      {isStaged ? (
        <button className="icon-btn" title="Aus Staging entfernen" onClick={(event) => { event.stopPropagation(); void act('unstage', { paths: [entry.path] }) }}>
          <Minus size={13} />
        </button>
      ) : (
        <>
          <button className="icon-btn" title="Änderungen verwerfen" onClick={(event) => { event.stopPropagation(); setDiscard([entry.path]) }}>
            <Undo2 size={13} />
          </button>
          <button className="icon-btn" title="Stagen" onClick={(event) => { event.stopPropagation(); void act('stage', { paths: [entry.path] }) }}>
            <Plus size={13} />
          </button>
        </>
      )}
    </div>
  )

  return (
    <>
      <PanelHeader title="Git">
        <button className="icon-btn" title="Aktualisieren" onClick={() => void load()}>
          <RefreshCw size={14} />
        </button>
      </PanelHeader>
      <div className="panel-body stack">
        <div className="row">
          <select
            className="select"
            value={status?.isRepo ? status.branch ?? '' : ''}
            onChange={async (event) => {
              try {
                setStatus(await api.post<GitStatus>(`/projects/${project.id}/git/checkout`, { branch: event.target.value }))
                await load()
              } catch (error) {
                notify(errorMessage(error), 'error')
              }
            }}
          >
            {branches.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}
              </option>
            ))}
          </select>
        </div>
        <textarea className="textarea" placeholder="Commit-Nachricht" value={message} onChange={(event) => setMessage(event.target.value)} rows={2} />
        <div className="row">
          <AsyncButton
            className="btn primary"
            disabled={!message.trim() || !staged.length}
            onClick={async () => {
              await api.post(`/projects/${project.id}/git/commit`, { message })
              setMessage('')
              await load()
              notify('Commit erstellt.', 'success')
            }}
          >
            Commit ({staged.length})
          </AsyncButton>
          <button className="btn" disabled={!unstaged.length} onClick={() => void act('stage', { paths: unstaged.map((entry) => entry.path) })}>
            Alle stagen
          </button>
        </div>
        <div className="section-title">Gestagt ({staged.length})</div>
        {staged.map((entry) => row(entry, true))}
        <div className="section-title">Änderungen ({unstaged.length})</div>
        {unstaged.length ? unstaged.map((entry) => row(entry, false)) : <span className="faint">Keine Änderungen.</span>}
        <div className="section-title">Verlauf</div>
        {log.map((commit) => (
          <div key={commit.sha} className="tree-item" title={`${commit.sha}\n${commit.author} · ${commit.date}`}>
            <span className="mono faint">{commit.sha.slice(0, 7)}</span>
            <span className="name">{commit.subject}</span>
          </div>
        ))}
      </div>
      {discard ? (
        <Confirm title="Änderungen verwerfen?" danger confirmLabel="Verwerfen" onCancel={() => setDiscard(undefined)} onConfirm={() => { void act('discard', { paths: discard, confirm: true }); setDiscard(undefined) }}>
          Die lokalen Änderungen an <code>{discard.join(', ')}</code> gehen verloren.
        </Confirm>
      ) : null}
    </>
  )
}
