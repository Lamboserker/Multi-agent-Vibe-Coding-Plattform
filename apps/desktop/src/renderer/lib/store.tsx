import type { ReactNode } from 'react'
import * as actions from './actions'
import { shallowEqual, useStore } from './store/core'
import { appStore, editorStore, jobsStore, liveStore, sessionStore, terminalStore, toastStore } from './stores'
import type { Settings } from './types'

export type { BottomTab, EditorTab, SideView, Toast } from './stores'
export { languageFor } from './actions'

/** Selective subscriptions: components re-render only when the selected slice changes. */
export const useAppState = <T,>(selector: (state: ReturnType<typeof appStore.get>) => T, equal?: (a: T, b: T) => boolean) => useStore(appStore, selector, equal)
export const useSessionState = <T,>(selector: (state: ReturnType<typeof sessionStore.get>) => T, equal?: (a: T, b: T) => boolean) => useStore(sessionStore, selector, equal)
export const useEditorState = <T,>(selector: (state: ReturnType<typeof editorStore.get>) => T, equal?: (a: T, b: T) => boolean) => useStore(editorStore, selector, equal)
export const useLiveState = <T,>(selector: (state: ReturnType<typeof liveStore.get>) => T, equal?: (a: T, b: T) => boolean) => useStore(liveStore, selector, equal)
export const useJobsState = <T,>(selector: (state: ReturnType<typeof jobsStore.get>) => T, equal?: (a: T, b: T) => boolean) => useStore(jobsStore, selector, equal)
export const useTerminalState = <T,>(selector: (state: ReturnType<typeof terminalStore.get>) => T, equal?: (a: T, b: T) => boolean) => useStore(terminalStore, selector, equal)
export const useToasts = () => useStore(toastStore, (state) => state.toasts)

export const notify = actions.notify

/** State is held in module-level stores (lib/stores.ts); kept so existing trees still compose. */
export function AppProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

/**
 * Convenience hook for views that need settings, project and layout. It does not include
 * high-frequency state (live logs, editor content, session messages).
 */
export function useApp() {
  // The workspace (composer drafts, explorer state …) changes while typing; views that need it select
  // the exact field with useAppState instead.
  const state = useStore(
    appStore,
    (app) => ({ settings: app.settings, project: app.project, ui: app.ui }),
    shallowEqual,
  )
  const editor = useStore(editorStore, (value) => ({ tabs: value.tabs, activeTabId: value.activeTabId }), shallowEqual)
  return {
    settings: state.settings as Settings | undefined,
    project: state.project,
    sideView: state.ui.sideView,
    bottomTab: state.ui.bottomTab,
    bottomOpen: state.ui.bottomOpen,
    theme: state.ui.theme,
    tabs: editor.tabs,
    activeTabId: editor.activeTabId,
    reloadSettings: actions.loadSettings,
    updateSettings: actions.updateSettings,
    openProjectPath: actions.openProjectPath,
    selectProject: actions.selectProject,
    setSideView: actions.setSideView,
    setBottomTab: actions.setBottomTab,
    setBottomOpen: actions.setBottomOpen,
    setTheme: actions.setTheme,
    setActiveTabId: actions.setActiveTab,
    openFile: actions.openFile,
    openDiff: actions.openDiff,
    closeTab: actions.closeTab,
    saveTab: actions.saveTab,
    notify: actions.notify,
  }
}
