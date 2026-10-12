import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppEvent, MacBridge } from '../shared/bridge.js'

/**
 * One ipcRenderer listener per channel, fanned out to any number of subscribers. Components can
 * subscribe and unsubscribe freely (view switches, remounts) without adding IPC listeners.
 */
function fanOut<T extends unknown[]>(channel: string, unpack: (payload: unknown) => T[]) {
  const listeners = new Set<(...args: T) => void>()
  ipcRenderer.on(channel, (_event: IpcRendererEvent, payload: unknown) => {
    for (const args of unpack(payload)) for (const listener of listeners) listener(...args)
  })
  return (listener: (...args: T) => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

const onRuntimeEvents = fanOut<[AppEvent]>('runtime:events', (payload) => (Array.isArray(payload) ? payload.map((event) => [event as AppEvent]) : []))
const onRuntimeStatus = fanOut<[never]>('runtime:status', (payload) => [[payload as never]])
const onTerminalData = fanOut<[string, string]>('terminal:data', (payload) => (Array.isArray(payload) ? (payload as Array<{ id: string; data: string }>).map((entry) => [entry.id, entry.data]) : []))
const onTerminalExit = fanOut<[string, number]>('terminal:exit', (payload) => [[(payload as { id: string }).id, (payload as { exitCode: number }).exitCode]])
const onTerminalChanged = fanOut<[]>('terminal:changed', () => [[]])
const onFlush = fanOut<[]>('app:flush', () => [[]])

/** The only API the renderer can use. No Node.js or Electron objects are exposed. */
const bridge: MacBridge = {
  api: (method, path, body) => ipcRenderer.invoke('api:request', { method, path, body }),
  onEvent: (listener) => onRuntimeEvents(listener),
  runtime: {
    status: () => ipcRenderer.invoke('runtime:status'),
    restart: () => ipcRenderer.invoke('runtime:restart'),
    onStatus: (listener) => onRuntimeStatus(listener as (status: never) => void),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    onFlushRequest: (listener) => onFlush(listener),
    flushed: () => ipcRenderer.send('app:flushed'),
  },
  dialog: {
    openFolder: (title) => ipcRenderer.invoke('dialog:openFolder', title),
    saveText: (defaultName, content) => ipcRenderer.invoke('dialog:saveText', defaultName, content),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    showItem: (target) => ipcRenderer.invoke('shell:showItem', target),
  },
  state: {
    hello: (epoch) => ipcRenderer.invoke('state:hello', epoch),
    get: (key) => ipcRenderer.invoke('state:get', key),
    set: (key, data, epoch) => ipcRenderer.invoke('state:set', key, data, epoch),
    flushSync: (payload) => ipcRenderer.sendSync('state:flush-sync', payload) === true,
  },
  drafts: {
    put: (projectKey, entry, epoch) => ipcRenderer.invoke('draft:put', projectKey, entry, epoch),
    delete: (projectKey, path, epoch) => ipcRenderer.invoke('draft:delete', projectKey, path, epoch),
    list: (projectKey) => ipcRenderer.invoke('draft:list', projectKey),
  },
  terminal: {
    create: (options) => ipcRenderer.invoke('terminal:create', options),
    list: (projectId) => ipcRenderer.invoke('terminal:list', projectId),
    attach: (id) => ipcRenderer.invoke('terminal:attach', id),
    rename: (id, title) => ipcRenderer.invoke('terminal:rename', id, title),
    write: (id, data) => ipcRenderer.send('terminal:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    onData: (listener) => onTerminalData(listener),
    onExit: (listener) => onTerminalExit(listener),
    onChanged: (listener) => onTerminalChanged(listener),
  },
}

contextBridge.exposeInMainWorld('mac', bridge)
