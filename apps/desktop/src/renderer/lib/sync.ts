import type { AppEvent, RuntimeStatus } from '../../shared/bridge'
import { api, bridge } from './api'
import * as actions from './actions'
import * as persistence from './persistence'
import { planningProgressForEvent } from './planning-progress'
import { appStore, editorStore, jobsStore, liveStore, planProgressStore, pluginStore, sessionStore, type LiveLine, type BottomTab, type Screen, type SetupSection, type SideView, type Theme, type UiState } from './stores'
import type { Project, VersionedSettings } from './types'

/*
 * Application lifecycle independent of React:
 *  - boot: restore persisted UI state, wait for the runtime, restore the last project/session
 *  - runtime restart: the IDE stays mounted; when the runtime is back, everything is re-synchronised
 *    from it (settings, project watcher, sessions, runs, activity)
 *  - one event subscription that keeps the stores current
 */

const SIDE_VIEWS: SideView[] = ['projects', 'explorer', 'search', 'git', 'tasks', 'agents', 'models', 'plugins', 'skills', 'mcp', 'usage', 'diagnostics', 'settings']
const BOTTOM_TABS: BottomTab[] = ['terminal', 'logs', 'tests', 'diff', 'run', 'problems']
const SCREENS: Screen[] = ['leitstand', 'code', 'review', 'sessions', 'models', 'usage', 'setup']
const SETUP_SECTIONS: SetupSection[] = ['onboarding', 'settings', 'agents', 'plugins', 'skills', 'mcp', 'diagnostics']

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

const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 10000

/** Restores the window layout before anything is rendered with defaults. */
async function restoreUi() {
  await bridge().state.hello(persistence.epoch).catch(() => undefined)
  const saved = await persistence.loadDocument<Partial<UiState>>('ui')
  if (saved) {
    appStore.set((state) => ({
      ui: {
        theme: saved.theme === 'light' || saved.theme === 'dark' ? (saved.theme as Theme) : state.ui.theme,
        screen: SCREENS.includes(saved.screen as Screen) ? (saved.screen as Screen) : state.ui.screen,
        setupSection: SETUP_SECTIONS.includes(saved.setupSection as SetupSection) ? (saved.setupSection as SetupSection) : state.ui.setupSection,
        leitstandVariant: saved.leitstandVariant === 'tiles' ? 'tiles' : 'graph',
        inspectorOpen: saved.inspectorOpen !== false,
        sideView: SIDE_VIEWS.includes(saved.sideView as SideView) ? (saved.sideView as SideView) : state.ui.sideView,
        bottomTab: BOTTOM_TABS.includes(saved.bottomTab as BottomTab) ? (saved.bottomTab as BottomTab) : state.ui.bottomTab,
        bottomOpen: typeof saved.bottomOpen === 'boolean' ? saved.bottomOpen : state.ui.bottomOpen,
        bottomMaximized: saved.bottomMaximized === true,
        sideOpen: saved.sideOpen !== false,
        chatOpen: saved.chatOpen !== false,
        sideWidths: Object.fromEntries(Object.entries(saved.sideWidths ?? {}).filter(([view, width]) => SIDE_VIEWS.includes(view as SideView) && isSize(width))),
        chatWidth: isSize(saved.chatWidth) ? saved.chatWidth : undefined,
        bottomHeight: isSize(saved.bottomHeight) ? saved.bottomHeight : undefined,
        lastProjectId: typeof saved.lastProjectId === 'string' ? saved.lastProjectId : undefined,
        lastProject: saved.lastProject && typeof saved.lastProject.repoPath === 'string' && typeof saved.lastProject.id === 'string' ? saved.lastProject : undefined,
      },
    }))
  }
  document.documentElement.dataset.theme = appStore.get().ui.theme
  await showCachedShell()
}

/**
 * Stale-while-revalidate start: with the settings and project of the last session the workspace is
 * shown immediately, while the runtime starts (~0.5 s). API calls made meanwhile wait in the main
 * process until the runtime is ready; boot() then reloads everything from the runtime.
 */
async function showCachedShell() {
  const settings = await persistence.loadDocument<VersionedSettings>('settings-cache')
  if (!settings?.onboarding?.completed || appStore.get().settings) return
  const lastProject = appStore.get().ui.lastProject
  appStore.set({ settings: { ...settings, version: -1 }, ...(lastProject ? { project: { ...lastProject } } : {}), booted: true })
  if (lastProject) editorStore.set({ restoring: true })
  performance.mark('mac:ide-shown')
}

export function startApp() {
  if (started || !window.mac) return
  started = true
  document.documentElement.dataset.theme = appStore.get().ui.theme
  performance.mark('mac:start')
  uiRestored = restoreUi().then(() => void performance.mark('mac:ui-restored'))
  bridge().onEvent(handleEvent)
  bridge().runtime.onStatus(onRuntimeStatus)
  bridge().terminal.onChanged(throttle(() => actions.refreshTerminals(), 150))
  void bridge().runtime.status().then(onRuntimeStatus).catch(() => undefined)
}

function onRuntimeStatus(status: RuntimeStatus) {
  if (status.state === 'ready' && !runtimeWasReady) performance.mark('mac:runtime-ready')
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

async function openLastProject(settings: VersionedSettings, onShown: () => void) {
  const cached = appStore.get().ui.lastProject
  const projectId = appStore.get().ui.lastProjectId ?? settings.lastProjectId
  if (!projectId) return
  // The cached path saves a lookup (which also starts a git process); open validates the folder.
  const known = cached?.id === projectId ? cached : await api.get<Project>(`/projects/${projectId}`).catch(() => undefined)
  if (!known || (known as Project).exists === false) {
    editorStore.set({ restoring: false })
    return
  }
  const opened = await api.post<Project>('/projects/open', { path: known.repoPath, name: known.name }).catch(() => undefined)
  if (opened) await actions.activateProject(opened, { onShown })
  else {
    // folder gone: the cached shell must not keep showing it
    appStore.set({ project: undefined })
    editorStore.set({ restoring: false })
  }
}

async function boot() {
  const started = performance.now()
  await uiRestored
  performance.mark('mac:boot')
  // Settings are required to render anything; a transient failure (runtime still recovering,
  // database busy) is retried instead of leaving the splash screen up.
  // Always from the runtime: cached settings (showCachedShell) are only a placeholder (version -1).
  for (let attempt = 0; (appStore.get().settings?.version ?? -1) < 0; attempt += 1) {
    try {
      await actions.loadSettings()
    } catch (error) {
      if (attempt === 3) actions.notify(`Einstellungen konnten noch nicht geladen werden: ${error instanceof Error ? error.message : String(error)}`, 'error')
      await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 250 * 2 ** attempt)))
    }
  }
  // The IDE is shown as soon as the last project is known (or there is none); the rest of the
  // workspace (tabs, sessions, terminals) fills in progressively.
  performance.mark('mac:settings')
  const show = () => {
    if (!appStore.get().booted) performance.mark('mac:ide-shown')
    else performance.mark('mac:workspace-restored')
    appStore.set({ booted: true })
  }
  const background = Promise.all([actions.loadActivity(), actions.loadModelJobs()])
  try {
    await openLastProject(appStore.get().settings!, show)
  } catch (error) {
    actions.notify(error instanceof Error ? error.message : String(error), 'error')
  }
  await Promise.all([background, actions.refreshTerminals()])
  // Persistence starts only after the restore, so default values never overwrite saved state.
  persistence.startPersistence()
  show()
  performance.measure('mac:restore', { start: started, end: performance.now() })
  // Monaco is the largest chunk; it is loaded when the app is idle so the first file opens fast.
  const preload = () => void import('./editor-models').then((module) => module.loadMonaco()).catch(() => undefined)
  if ('requestIdleCallback' in window) window.requestIdleCallback(preload, { timeout: 3000 })
  else setTimeout(preload, 1500)
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

const TASK_EVENTS = new Set(['subtask_hint', 'plan_requested', 'planning_started', 'planned', 'execution_created', 'execution_finished', 'applied', 'apply_rejected', 'discarded', 'undone', 'auto_applied'])
const ACTIVITY_EVENTS = new Set(['plan_requested', 'planning_started', 'planned', 'execution_created', 'execution_finished', 'run_paused', 'run_resumed', 'discarded', 'applied'])
const MAX_LIVE_LINES = 2000

// Live lines are appended once per delivered event batch (the main process sends batches of up to
// 250 events), not once per event: one store update and one array copy instead of hundreds.
let pendingLive: { executionId: string; lines: LiveLine[] } | undefined
function appendLive(executionId: string, line: LiveLine) {
  if (!pendingLive || pendingLive.executionId !== executionId) {
    flushLive()
    pendingLive = { executionId, lines: [] }
    queueMicrotask(flushLive)
  }
  pendingLive.lines.push(line)
}
function flushLive() {
  const batch = pendingLive
  pendingLive = undefined
  if (!batch?.lines.length) return
  liveStore.set((state) => {
    const previous = state.executionId === batch.executionId ? state.lines : []
    const lines = previous.length + batch.lines.length > MAX_LIVE_LINES ? [...previous, ...batch.lines].slice(-MAX_LIVE_LINES) : [...previous, ...batch.lines]
    return { executionId: batch.executionId, lines }
  })
}

function handleEvent(event: AppEvent) {
  const data = event.data as Record<string, unknown>
  const { project, workspace, settings } = appStore.get()
  const session = sessionStore.get()

  switch (event.channel) {
    case 'system':
      if (event.type === 'settings_changed' && Number(data.version) > (settings?.version ?? -1)) refreshSettings()
      if (/^(plugin|skills|skill|mcp|agents)_/.test(event.type)) pluginStore.set((state) => ({ revision: state.revision + 1, lastEvent: { id: data.id as string | undefined, type: event.type, status: data.status as string | undefined, error: data.error as string | undefined } }))
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
        if (typeof data.message === 'string') appendLive(executionId, { ts: event.ts, level: String(data.level ?? 'info'), type: event.type, message: data.message as string, subtaskId: data.subtaskId as string | undefined })
        if (event.type !== 'check_output' && event.type !== 'tool_call' && !event.type.startsWith('orchestrator_')) refreshExecution()
      }
      planProgressStore.set((state) => ({ tasks: planningProgressForEvent(state.tasks, event) }))
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
