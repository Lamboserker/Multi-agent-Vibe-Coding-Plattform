import type { AppEvent, RuntimeStatus } from '../../shared/bridge'
import { api, bridge } from './api'
import * as actions from './actions'
import * as persistence from './persistence'
import { appStore, jobsStore, liveStore, sessionStore, type BottomTab, type SideView, type Theme, type UiState } from './stores'
import type { Project, VersionedSettings } from './types'

/*
 * Application lifecycle independent of React:
 *  - boot: restore persisted UI state, wait for the runtime, restore the last project/session
 *  - runtime restart: the IDE stays mounted; when the runtime is back, everything is re-synchronised
 *    from it (settings, project watcher, sessions, runs, activity)
 *  - one event subscription that keeps the stores current
 */

const SIDE_VIEWS: SideView[] = ['projects', 'explorer', 'git', 'tasks', 'agents', 'models', 'usage', 'settings']
const BOTTOM_TABS: BottomTab[] = ['terminal', 'logs', 'tests', 'diff', 'run', 'problems']

function throttle(fn: () => unknown, ms: number) {
  let timer: number | undefined
  return () => {
    if (timer !== undefined) return
    timer = window.setTimeout(() => {
      timer = undefined
      void fn()
    }, ms)
  }
}

let started = false
let runtimeWasReady = false
let booting: Promise<void> | undefined
let uiRestored: Promise<void> = Promise.resolve()

/** Restores the window layout before anything is rendered with defaults. */
async function restoreUi() {
  await bridge().state.hello(persistence.epoch).catch(() => undefined)
  const saved = await persistence.loadDocument<Partial<UiState>>('ui')
  if (saved) {
    appStore.set((state) => ({
      ui: {
        theme: saved.theme === 'light' || saved.theme === 'dark' ? (saved.theme as Theme) : state.ui.theme,
        sideView: SIDE_VIEWS.includes(saved.sideView as SideView) ? (saved.sideView as SideView) : state.ui.sideView,
        bottomTab: BOTTOM_TABS.includes(saved.bottomTab as BottomTab) ? (saved.bottomTab as BottomTab) : state.ui.bottomTab,
        bottomOpen: typeof saved.bottomOpen === 'boolean' ? saved.bottomOpen : state.ui.bottomOpen,
        lastProjectId: typeof saved.lastProjectId === 'string' ? saved.lastProjectId : undefined,
      },
    }))
  }
  document.documentElement.dataset.theme = appStore.get().ui.theme
}

export function startApp() {
  if (started || !window.mac) return
  started = true
  document.documentElement.dataset.theme = appStore.get().ui.theme
  uiRestored = restoreUi()
  bridge().onEvent(handleEvent)
  bridge().runtime.onStatus(onRuntimeStatus)
  bridge().terminal.onChanged(throttle(() => actions.refreshTerminals(), 150))
  void bridge().runtime.status().then(onRuntimeStatus).catch(() => undefined)
}

function onRuntimeStatus(status: RuntimeStatus) {
  appStore.set({ runtime: status })
  if (status.state === 'ready') {
    if (!runtimeWasReady) {
      runtimeWasReady = true
      booting = boot()
    } else if (appStore.get().reconnecting) {
      appStore.set({ reconnecting: false })
      void (booting ?? Promise.resolve()).then(() => resync())
    }
  } else if (runtimeWasReady) {
    appStore.set({ reconnecting: true })
  }
}

async function openLastProject(settings: VersionedSettings) {
  const projectId = appStore.get().ui.lastProjectId ?? settings.lastProjectId
  if (!projectId) return
  const project = await api.get<Project>(`/projects/${projectId}`).catch(() => undefined)
  if (!project || project.exists === false) return
  const opened = await api.post<Project>('/projects/open', { path: project.repoPath, name: project.name }).catch(() => undefined)
  if (opened) await actions.activateProject(opened)
}

async function boot() {
  const started = performance.now()
  await uiRestored
  // Settings are required to render anything; a transient failure (runtime still recovering,
  // database busy) is retried instead of leaving the splash screen up.
  for (let attempt = 0; !appStore.get().settings; attempt += 1) {
    try {
      await actions.loadSettings()
    } catch (error) {
      if (attempt === 3) actions.notify(`Einstellungen konnten noch nicht geladen werden: ${error instanceof Error ? error.message : String(error)}`, 'error')
      await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 250 * 2 ** attempt)))
    }
  }
  try {
    await openLastProject(appStore.get().settings!)
  } catch (error) {
    actions.notify(error instanceof Error ? error.message : String(error), 'error')
  }
  await Promise.all([actions.loadActivity(), actions.loadModelJobs(), actions.refreshTerminals()])
  // Persistence starts only after the restore, so default values never overwrite saved state.
  persistence.startPersistence()
  appStore.set({ booted: true })
  performance.measure('mac:restore', { start: started, end: performance.now() })
}

/** The runtime restarted (crash/backoff): re-read everything that lives there. Nothing is reset. */
export async function resync() {
  await actions.loadSettings().catch(() => undefined)
  const project = appStore.get().project
  if (project) {
    // re-registers the file watcher of the new runtime process
    await api.post<Project>('/projects/open', { path: project.repoPath, name: project.name }).catch(() => undefined)
    await actions.loadSessions()
    await actions.reloadActiveSession()
  }
  await Promise.all([actions.loadActivity(), actions.loadModelJobs()])
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const refreshSettings = throttle(() => actions.loadSettings(), 200)
const refreshSessions = throttle(() => actions.loadSessions(), 400)
const refreshActiveSession = throttle(() => actions.reloadActiveSession(), 300)
const refreshTask = throttle(() => actions.reloadTask(), 500)
const refreshExecution = throttle(() => actions.reloadExecution(), 800)
const refreshActivity = throttle(() => actions.loadActivity(), 500)

const TASK_EVENTS = new Set(['plan_requested', 'planning_started', 'planned', 'execution_created', 'execution_finished', 'applied', 'apply_rejected', 'discarded', 'undone', 'auto_applied'])
const ACTIVITY_EVENTS = new Set(['plan_requested', 'planning_started', 'planned', 'execution_created', 'execution_finished', 'run_paused', 'run_resumed', 'discarded', 'applied'])
const MAX_LIVE_LINES = 2000

function handleEvent(event: AppEvent) {
  const data = event.data as Record<string, unknown>
  const { project, workspace, settings } = appStore.get()
  const session = sessionStore.get()

  switch (event.channel) {
    case 'system':
      if (event.type === 'settings_changed' && Number(data.version) > (settings?.version ?? -1)) refreshSettings()
      return
    case 'project':
      if (event.type === 'files_changed' && typeof data.projectId === 'string') actions.onFilesChanged(data.projectId, (data.files as string[]) ?? [])
      if (data.projectId !== project?.id) return
      if (event.type === 'session_updated' && typeof data.sessionId === 'string') {
        const known = session.list.some((entry) => entry.id === data.sessionId)
        if (known) actions.upsertSessionSummary({ id: data.sessionId, status: data.status as never, title: data.title as string, lastActivityAt: data.lastActivityAt as string, pinned: Boolean(data.pinned), archivedAt: data.archived ? new Date().toISOString() : null })
        else refreshSessions()
        if (data.sessionId === workspace.activeSessionId) refreshActiveSession()
        refreshActivity()
      }
      if (event.type === 'session_deleted') refreshSessions()
      if (event.type === 'chat_message' && data.sessionId === workspace.activeSessionId) refreshActiveSession()
      return
    case 'run': {
      const executionId = data.executionId as string | undefined
      if (executionId && executionId === session.execution?.id) {
        if (typeof data.message === 'string') {
          liveStore.set((state) => ({
            executionId,
            lines: [...(state.executionId === executionId ? state.lines.slice(-(MAX_LIVE_LINES - 1)) : []), { ts: event.ts, level: String(data.level ?? 'info'), type: event.type, message: data.message as string, subtaskId: data.subtaskId as string | undefined }],
          }))
        }
        if (event.type !== 'check_output' && event.type !== 'tool_call' && !event.type.startsWith('orchestrator_')) refreshExecution()
      }
      if (TASK_EVENTS.has(event.type) && (data.taskId === session.task?.id || (executionId && executionId === session.execution?.id))) refreshTask()
      if (event.type === 'execution_created' && data.taskId === session.task?.id) refreshTask()
      if (ACTIVITY_EVENTS.has(event.type) || (event.type === 'run_updated' && data.status)) refreshActivity()
      if (event.type === 'auto_applied') actions.notify(`Automatisch übernommen: ${String(data.message ?? '')}`, 'success')
      return
    }
    case 'jobs':
      if (['started', 'finished', 'failed'].includes(event.type) && ['execution.plan', 'chat.ask', 'execution.run'].includes(String(data.type))) refreshActivity()
      if (event.type === 'failed' && data.type === 'model.pull') actions.notify(`Download fehlgeschlagen: ${String(data.error)}`, 'error')
      return
    case 'models':
      if (event.type === 'pull_progress') jobsStore.set((state) => ({ pulls: { ...state.pulls, [String(data.model)]: { percent: data.percent as number | undefined, status: String(data.status ?? '') } } }))
      if (event.type === 'pull_finished') {
        jobsStore.set((state) => ({ pulls: { ...state.pulls, [String(data.model)]: { percent: 100, status: 'fertig' } } }))
        actions.notify(`Modell ${String(data.model)} heruntergeladen.`, 'success')
      }
      if (event.type === 'install_output') jobsStore.set((state) => ({ installLog: [...state.installLog.slice(-80), String(data.line)] }))
      if (event.type === 'install_finished') actions.notify(data.ok ? 'Ollama wurde installiert.' : 'Ollama-Installation fehlgeschlagen.', data.ok ? 'success' : 'error')
      return
    case 'orchestrator':
      if (event.type === 'model_fallback') actions.notify(`Codex-Modell "${String(data.from ?? 'Standard')}" ist für dieses Konto nicht verfügbar – verwende "${String(data.to)}".`, 'info')
      return
  }
}
