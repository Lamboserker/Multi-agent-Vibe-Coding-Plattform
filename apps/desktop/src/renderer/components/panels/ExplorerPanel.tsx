import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, File, FilePlus, Folder, FolderPlus, RefreshCw, Search, Trash2 } from 'lucide-react'
import * as actions from '../../lib/actions'
import { api, enc, errorMessage } from '../../lib/api'
import { useAppEvents, useThrottled } from '../../lib/hooks'
import { useAppState, useEditorState } from '../../lib/store'
import type { GitStatus, TreeEntry } from '../../lib/types'
import { Confirm, Empty, PanelHeader, PromptDialog } from '../common'
import { ProjectSetup } from './ProjectsPanel'

function setExplorer(patch: { expanded?: string[]; selected?: string }) {
  actions.updateWorkspace((workspace) => ({ explorer: { ...workspace.explorer, ...patch } }))
}

export function ExplorerPanel() {
  const project = useAppState((state) => state.project)
  const expandedList = useAppState((state) => state.workspace.explorer.expanded)
  const selected = useAppState((state) => state.workspace.explorer.selected)
  const activeFile = useEditorState((state) => {
    const tab = state.tabs.find((entry) => entry.id === state.activeTabId)
    return tab?.kind === 'file' ? tab.path : undefined
  })
  const expanded = useMemo(() => new Set(expandedList), [expandedList])
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({})
  const [gitMarks, setGitMarks] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{ path: string; line: number; text: string }>>()
  const [pendingDelete, setPendingDelete] = useState<{ path: string; fileCount?: number }>()
  const [creating, setCreating] = useState<{ type: 'file' | 'directory'; initial: string }>()

  const load = useCallback(
    async (dir: string) => {
      if (!project) return
      try {
        const entries = await api.get<TreeEntry[]>(`/projects/${project.id}/tree?dir=${enc(dir)}`)
        setChildren((current) => ({ ...current, [dir]: entries }))
      } catch (error) {
        // a persisted expanded folder may no longer exist
        if (dir === '') actions.notify(errorMessage(error), 'error')
      }
    },
    [project],
  )

  const loadGit = useCallback(async () => {
    if (!project) return
    const status = await api.get<GitStatus>(`/projects/${project.id}/git/status`).catch(() => undefined)
    if (!status?.isRepo) return setGitMarks({})
    const marks: Record<string, string> = {}
    for (const entry of status.entries) marks[entry.path] = entry.untracked ? 'U' : entry.index !== ' ' && entry.index !== '?' ? entry.index : entry.worktree
    setGitMarks(marks)
  }, [project])

  const refresh = useCallback(() => {
    for (const dir of expanded) void load(dir)
    void loadGit()
  }, [expanded, load, loadGit])
  const throttledRefresh = useThrottled(refresh, 600)

  // A (re)opened project shows its tree with the folders that were expanded last time.
  useEffect(() => {
    setChildren({})
    setResults(undefined)
    if (!project) return
    for (const dir of new Set(['', ...expandedList])) void load(dir)
    void loadGit()
    // only when the project changes; later expansions load on demand
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  useAppEvents((event) => {
    if (event.channel === 'project' && event.type === 'files_changed' && event.data.projectId === project?.id) throttledRefresh()
  })

  useEffect(() => {
    if (activeFile && activeFile !== selected) setExplorer({ selected: activeFile })
    // follow the editor only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile])

  if (!project) {
    return (
      <>
        <PanelHeader title="Explorer" />
        <div className="panel-body stack">
          <Empty>Kein Projekt geöffnet.</Empty>
          <ProjectSetup />
        </div>
      </>
    )
  }

  const toggle = (dir: string) => {
    const next = new Set(expanded)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      if (!children[dir]) void load(dir)
    }
    setExplorer({ expanded: [...next] })
  }

  const startCreate = (type: 'file' | 'directory') => {
    const base = selected && children[selected] ? selected : selected?.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : ''
    setCreating({ type, initial: base ? `${base}/` : '' })
  }

  const create = async (type: 'file' | 'directory', name: string) => {
    setCreating(undefined)
    try {
      await api.post(`/projects/${project.id}/entries`, { path: name, type })
      refresh()
      if (type === 'file') await actions.openFile(name)
    } catch (error) {
      actions.notify(errorMessage(error), 'error')
    }
  }

  const remove = async (path: string, confirmCount?: number) => {
    try {
      const result = await api.del<{ deleted: boolean; requiresConfirmation?: boolean; fileCount?: number }>(`/projects/${project.id}/entries?path=${enc(path)}${confirmCount ? `&confirmCount=${confirmCount}` : ''}`)
      if (result.requiresConfirmation) {
        setPendingDelete({ path, fileCount: result.fileCount })
        return
      }
      setPendingDelete(undefined)
      refresh()
    } catch (error) {
      actions.notify(errorMessage(error), 'error')
    }
  }

  const search = async () => {
    if (!query.trim()) return setResults(undefined)
    try {
      setResults(await api.get(`/projects/${project.id}/search?q=${enc(query)}`))
    } catch (error) {
      actions.notify(errorMessage(error), 'error')
    }
  }

  const renderDir = (dir: string, depth: number) =>
    (children[dir] ?? []).map((entry) => (
      <div key={entry.path}>
        <div
          className={`tree-item ${selected === entry.path ? 'selected' : ''}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => {
            setExplorer({ selected: entry.path })
            if (entry.type === 'directory') toggle(entry.path)
            else void actions.openFile(entry.path)
          }}
          title={entry.path}
          data-path={entry.path}
        >
          {entry.type === 'directory' ? (expanded.has(entry.path) ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span style={{ width: 13 }} />}
          {entry.type === 'directory' ? <Folder size={14} color="var(--accent)" /> : <File size={14} className="faint" />}
          <span className={`name ${entry.heavy ? 'faint' : ''}`}>{entry.name}</span>
          {gitMarks[entry.path] ? <span className={`git-mark ${gitMarks[entry.path]}`}>{gitMarks[entry.path]}</span> : null}
        </div>
        {entry.type === 'directory' && expanded.has(entry.path) ? renderDir(entry.path, depth + 1) : null}
      </div>
    ))

  return (
    <>
      <PanelHeader title={project.name}>
        <button className="icon-btn" title="Neue Datei" onClick={() => startCreate('file')}>
          <FilePlus size={15} />
        </button>
        <button className="icon-btn" title="Neuer Ordner" onClick={() => startCreate('directory')}>
          <FolderPlus size={15} />
        </button>
        <button className="icon-btn" title="Löschen" disabled={!selected} onClick={() => selected && void remove(selected)}>
          <Trash2 size={15} />
        </button>
        <button className="icon-btn" title="Aktualisieren" onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </PanelHeader>
      <div style={{ padding: '8px 8px 0' }} className="row">
        <input className="input" placeholder="Im Projekt suchen …" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void search()} />
        <button className="icon-btn" onClick={() => void search()} title="Suchen">
          <Search size={15} />
        </button>
      </div>
      <div className="panel-body" data-testid="explorer-tree">
        {results ? (
          <div className="stack" style={{ gap: 2 }}>
            <div className="row">
              <span className="faint">{results.length} Treffer</span>
              <span className="spacer" />
              <button className="btn small ghost" onClick={() => setResults(undefined)}>
                Schließen
              </button>
            </div>
            {results.map((hit, index) => (
              <div key={index} className="tree-item" style={{ flexDirection: 'column', alignItems: 'flex-start' }} onClick={() => void actions.openFile(hit.path)}>
                <span className="mono" style={{ fontSize: 11 }}>
                  {hit.path}:{hit.line}
                </span>
                <span className="faint truncate mono" style={{ maxWidth: '100%', fontSize: 11 }}>
                  {hit.text.trim()}
                </span>
              </div>
            ))}
          </div>
        ) : (
          renderDir('', 0)
        )}
      </div>
      {creating ? (
        <PromptDialog
          title={creating.type === 'file' ? 'Neue Datei' : 'Neuer Ordner'}
          initial={creating.initial}
          placeholder="relativer Pfad, z. B. src/utils/format.ts"
          onCancel={() => setCreating(undefined)}
          onSubmit={(value) => void create(creating.type, value)}
        />
      ) : null}
      {pendingDelete ? (
        <Confirm title="Ordner löschen?" danger confirmLabel="Endgültig löschen" onCancel={() => setPendingDelete(undefined)} onConfirm={() => void remove(pendingDelete.path, pendingDelete.fileCount)}>
          <p>
            <code>{pendingDelete.path}</code> enthält {pendingDelete.fileCount} Dateien. Das Löschen kann nicht über Multi-AI Coder rückgängig gemacht werden.
          </p>
        </Confirm>
      ) : null}
    </>
  )
}
