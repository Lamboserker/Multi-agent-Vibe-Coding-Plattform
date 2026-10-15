import * as actions from './actions'
import * as ide from './ide'
import { appStore, dialogStore, editorStore, type SideView } from './stores'

/** Commands of the command palette; the ones with a shortcut are also bound globally (App). */
export interface Command {
  id: string
  label: string
  category: string
  /** Display form, e.g. "Strg+Umschalt+P". */
  shortcut?: string
  /** KeyboardEvent matcher for global shortcuts (editor shortcuts are bound inside Monaco). */
  keys?: { ctrl?: boolean; shift?: boolean; alt?: boolean; key: string }
  run: () => unknown
  enabled?: () => boolean
}

const hasProject = () => Boolean(appStore.get().project)
const hasFile = () => editorStore.get().tabs.some((tab) => tab.id === editorStore.get().activeTabId && tab.kind === 'file')
const view = (id: SideView, label: string): Command => ({ id: `view.${id}`, label: `Ansicht: ${label}`, category: 'Ansicht', run: () => actions.setSideView(id) })

export function commands(): Command[] {
  return [
    { id: 'palette.files', label: 'Datei öffnen (Quick Open) …', category: 'Navigation', shortcut: 'Strg+P', keys: { ctrl: true, key: 'p' }, run: () => dialogStore.set({ dialog: { kind: 'quick-open', mode: 'files' } }), enabled: hasProject },
    { id: 'palette.commands', label: 'Befehlspalette …', category: 'Navigation', shortcut: 'Strg+Umschalt+P', keys: { ctrl: true, shift: true, key: 'p' }, run: () => dialogStore.set({ dialog: { kind: 'quick-open', mode: 'commands' } }) },
    { id: 'editor.gotoLine', label: 'Gehe zu Zeile …', category: 'Navigation', shortcut: 'Strg+G', keys: { ctrl: true, key: 'g' }, run: () => dialogStore.set({ dialog: { kind: 'quick-open', mode: 'line' } }), enabled: hasFile },
    { id: 'search.open', label: 'In Dateien suchen', category: 'Suche', shortcut: 'Strg+Umschalt+F', keys: { ctrl: true, shift: true, key: 'f' }, run: () => actions.setSideView('search'), enabled: hasProject },
    { id: 'editor.save', label: 'Datei speichern', category: 'Datei', shortcut: 'Strg+S', run: () => editorStore.get().activeTabId && ide.saveWithFormat(editorStore.get().activeTabId!), enabled: hasFile },
    {
      id: 'editor.saveAll',
      label: 'Alle Dateien speichern',
      category: 'Datei',
      shortcut: 'Strg+Alt+S',
      keys: { ctrl: true, alt: true, key: 's' },
      run: async () => {
        for (const tab of editorStore.get().tabs.filter((entry) => entry.kind === 'file' && entry.dirty)) await ide.saveWithFormat(tab.id)
      },
      enabled: hasProject,
    },
    {
      id: 'editor.close',
      label: 'Tab schließen',
      category: 'Datei',
      shortcut: 'Strg+W',
      keys: { ctrl: true, key: 'w' },
      run: () => {
        const id = editorStore.get().activeTabId
        if (id && actions.closeTab(id) === 'needs_confirmation') actions.notify('Die Datei hat ungespeicherte Änderungen – zum Schließen das × am Tab verwenden.', 'info')
      },
      enabled: () => Boolean(editorStore.get().activeTabId),
    },
    {
      id: 'editor.nextTab',
      label: 'Nächster Tab',
      category: 'Datei',
      shortcut: 'Strg+Tab',
      keys: { ctrl: true, key: 'Tab' },
      run: () => {
        const { tabs, activeTabId } = editorStore.get()
        const index = tabs.findIndex((tab) => tab.id === activeTabId)
        if (tabs.length) actions.setActiveTab(tabs[(index + 1) % tabs.length]!.id)
      },
    },
    {
      id: 'editor.split',
      label: 'Editor teilen / Teilung aufheben',
      category: 'Editor',
      shortcut: 'Strg+\\',
      keys: { ctrl: true, key: '\\' },
      run: () => {
        const { splitTabId, activeTabId, tabs } = editorStore.get()
        if (splitTabId) editorStore.set({ splitTabId: undefined })
        else if (tabs.some((tab) => tab.id === activeTabId && tab.kind === 'file')) editorStore.set({ splitTabId: activeTabId })
      },
      enabled: () => Boolean(editorStore.get().splitTabId) || hasFile(),
    },
    { id: 'editor.format', label: 'Dokument formatieren (Prettier)', category: 'Editor', shortcut: 'Umschalt+Alt+F', run: () => ide.formatTab(), enabled: hasFile },
    { id: 'editor.references', label: 'Alle Referenzen suchen', category: 'Editor', shortcut: 'Umschalt+F12', run: () => ide.findReferences(), enabled: hasFile },
    { id: 'editor.definition', label: 'Gehe zu Definition', category: 'Editor', shortcut: 'F12', run: () => ide.modelContext()?.editor.getAction('editor.action.revealDefinition')?.run(), enabled: hasFile },
    { id: 'editor.rename', label: 'Symbol umbenennen', category: 'Editor', shortcut: 'F2', run: () => ide.modelContext()?.editor.getAction('editor.action.rename')?.run(), enabled: hasFile },
    { id: 'editor.history', label: 'Lokale Historie der Datei …', category: 'Editor', run: () => ide.openHistory(), enabled: hasFile },
    { id: 'editor.diffHead', label: 'Änderungen gegenüber HEAD anzeigen', category: 'Git', run: () => ide.diffWithHead(), enabled: hasFile },
    { id: 'ai.edit', label: 'KI: Auswahl bearbeiten (lokales Modell) …', category: 'KI', shortcut: 'Strg+I', run: () => ide.openAiEdit(), enabled: hasFile },
    { id: 'ai.explain', label: 'KI: Auswahl im Chat erklären lassen', category: 'KI', run: () => ide.explainSelection(), enabled: hasFile },
    ...(['refactor', 'tests', 'fix', 'review'] as const).map((action) => ({ id: `ai.${action}`, label: ({ refactor: 'KI: Code refaktorieren', tests: 'KI: Tests generieren', fix: 'KI: Fehler korrigieren', review: 'KI: Code-Review' })[action], category: 'KI', run: () => ide.prepareCodeTask(action), enabled: hasFile })),
    ...(['file', 'folder', 'diff'] as const).map((kind) => ({ id: `context.${kind}`, label: ({ file: 'Datei zum Chat-Kontext hinzufügen', folder: 'Ordner zum Chat-Kontext hinzufügen', diff: 'Git-Diff zum Chat-Kontext hinzufügen' })[kind], category: 'Kontext', run: () => ide.addContext(kind), enabled: hasProject })),
    {
      id: 'problems.check',
      label: 'Projekt prüfen (TypeScript + ESLint)',
      category: 'Probleme',
      run: () => {
        actions.setBottomOpen(true)
        actions.setBottomTab('problems')
        return ide.checkProject()
      },
      enabled: hasProject,
    },
    {
      id: 'settings.formatOnSave',
      label: 'Einstellung: Beim Speichern formatieren umschalten',
      category: 'Einstellungen',
      run: () => actions.updateSettings({ formatOnSave: !appStore.get().settings?.formatOnSave }),
    },
    { id: 'session.new', label: 'Neue Sitzung', category: 'Chat', run: () => actions.newSession(), enabled: hasProject },
    { id: 'workflow.open', label: 'Arbeitsablauf öffnen', category: 'Navigation', shortcut: 'Strg+Umschalt+L', keys: { ctrl: true, shift: true, key: 'l' }, run: () => actions.openWorkflow() },
    {
      id: 'chat.focus',
      label: 'Chat-Eingabe fokussieren',
      category: 'Chat',
      shortcut: 'Strg+L',
      keys: { ctrl: true, key: 'l' },
      run: () => {
        actions.setLayout({ chatOpen: true })
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#chat-input')?.focus())
      },
    },
    {
      id: 'layout.toggleSide',
      label: 'Seitenleiste ein-/ausblenden',
      category: 'Ansicht',
      shortcut: 'Strg+B',
      keys: { ctrl: true, key: 'b' },
      run: () => actions.setLayout({ sideOpen: !appStore.get().ui.sideOpen }),
    },
    {
      id: 'layout.toggleChat',
      label: 'Chat-Bereich ein-/ausblenden',
      category: 'Ansicht',
      shortcut: 'Strg+Umschalt+B',
      keys: { ctrl: true, shift: true, key: 'b' },
      run: () => actions.setLayout({ chatOpen: !appStore.get().ui.chatOpen }),
    },
    { id: 'layout.maximizeBottom', label: 'Unteres Panel maximieren / wiederherstellen', category: 'Ansicht', run: () => actions.toggleBottomMaximized() },
    {
      id: 'layout.focusEditor',
      label: 'Fokus-Modus: nur Editor (Seitenleiste, Chat, Panel aus)',
      category: 'Ansicht',
      run: () => {
        actions.setLayout({ sideOpen: false, chatOpen: false })
        actions.setBottomOpen(false)
      },
    },
    {
      id: 'layout.reset',
      label: 'Layout zurücksetzen (Standardgrößen)',
      category: 'Ansicht',
      run: () => {
        appStore.set((state) => ({ ui: { ...state.ui, sideWidths: {}, chatWidth: undefined, bottomHeight: undefined, sideOpen: true, chatOpen: true, bottomOpen: true, bottomMaximized: false } }))
      },
    },
    {
      id: 'terminal.toggle',
      label: 'Unteres Panel ein-/ausblenden',
      category: 'Ansicht',
      shortcut: 'Strg+J',
      keys: { ctrl: true, key: 'j' },
      run: () => actions.setBottomOpen(!appStore.get().ui.bottomOpen),
    },
    {
      id: 'terminal.new',
      label: 'Neues Terminal',
      category: 'Terminal',
      shortcut: 'Strg+Umschalt+Ö',
      keys: { ctrl: true, shift: true, key: 'ö' },
      run: () => {
        actions.setBottomOpen(true)
        actions.setBottomTab('terminal')
        return actions.createTerminal()
      },
    },
    { id: 'theme.toggle', label: 'Farbschema umschalten (hell/dunkel)', category: 'Ansicht', run: () => actions.setTheme(appStore.get().ui.theme === 'dark' ? 'light' : 'dark') },
    { id: 'help.shortcuts', label: 'Tastenkürzel anzeigen', category: 'Hilfe', shortcut: 'Strg+K Strg+S', run: () => dialogStore.set({ dialog: { kind: 'shortcuts' } }) },
    view('projects', 'Projekte'),
    view('explorer', 'Explorer'),
    view('search', 'Suchen'),
    view('git', 'Git'),
    view('tasks', 'Sitzungen'),
    view('agents', 'Agenten'),
    view('models', 'Modelle'),
    view('plugins', 'Erweiterungen'),
    view('skills', 'Skills'),
    view('mcp', 'MCP-Server'),
    view('usage', 'Nutzung & Kosten'),
    view('diagnostics', 'Diagnose & Performance'),
    view('settings', 'Einstellungen'),
  ]
}

/** Finds the command for a key event (global shortcuts). */
export function commandForEvent(event: KeyboardEvent): Command | undefined {
  const ctrl = event.ctrlKey || event.metaKey
  // AltGr (e.g. "\" on German keyboards) arrives as Ctrl+Alt: it does not count as Alt
  const alt = event.altKey && !event.getModifierState?.('AltGraph')
  return commands().find((command) => {
    const keys = command.keys
    if (!keys) return false
    return Boolean(keys.ctrl) === ctrl && Boolean(keys.shift) === event.shiftKey && Boolean(keys.alt) === alt && keys.key.toLowerCase() === event.key.toLowerCase()
  })
}

export { fuzzyScore } from './text-utils'
