/**
 * Plugin host: one process per plugin, started by the runtime (PluginsService) with the Node
 * permission model (`--permission`): it may only read the plugin's own folder; file writes, child
 * processes, worker threads and native addons are denied by Node itself. For untrusted plugins the
 * network modules and fetch are blocked here as well (Node 24 has no network permission), so every
 * effect goes through the PluginContext RPC, where the runtime checks the granted permissions.
 */
import { createRequire, Module, registerHooks } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ExtensionKind, CommandResult, MultiAICoderPlugin, PluginContext, PluginManifest, ViewNode } from '@multi-ai-coder/plugin-sdk'

// Keep the permission-restricted host self-contained (no runtime package reads).
const EXTENSION_METHODS: Record<ExtensionKind, readonly string[]> = {
  modelProviders: ['models', 'generate'], orchestratorAdapters: ['plan', 'execute', 'review', 'chat'],
  repositoryAnalyzers: ['analyze'], testRunners: ['run'], languageIntegrations: ['request'], gitIntegrations: ['request'],
}

type Message =
  | { type: 'init'; manifest: PluginManifest; pluginDir: string; dataDir: string; sandboxed: boolean }
  | { type: 'invoke'; id: number; kind: 'command' | 'view' | 'tool' | 'event' | 'context' | 'extension'; name: string; args: Record<string, unknown> }
  | { type: 'response'; id: number; ok: boolean; value?: unknown; error?: string }
  | { type: 'shutdown' }

const send = (message: unknown) => process.send?.(message)

const BLOCKED_MODULES = new Set(['net', 'tls', 'http', 'https', 'http2', 'dgram', 'undici', 'child_process', 'cluster', 'worker_threads', 'inspector', 'dns'])

/** Untrusted plugins reach the network only through context.http (host allowlist checked by the runtime). */
function lockDownNetwork() {
  const moduleWithLoad = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown }
  const originalLoad = moduleWithLoad._load
  moduleWithLoad._load = function load(request: string, parent: unknown, isMain: boolean) {
    const name = request.replace(/^node:/, '').split('/')[0]!
    if (BLOCKED_MODULES.has(name)) throw new Error(`Plugins cannot load "${request}". Use the PluginContext API (http, process) instead.`)
    return originalLoad.call(this, request, parent, isMain)
  }
  // ES modules do not go through Module._load: an in-thread resolve hook (module.registerHooks; the
  // off-thread module.register would need a worker, which the permission model denies) covers import.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const name = specifier.replace(/^node:/, '').split('/')[0]!
      if (BLOCKED_MODULES.has(name)) throw new Error(`Plugins cannot import "${specifier}". Use the PluginContext API (http, process) instead.`)
      return nextResolve(specifier, context)
    },
  })
  for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
    Object.defineProperty(globalThis, name, {
      configurable: false,
      get() {
        throw new Error(`Plugins cannot use ${name} directly. Use context.http.fetch.`)
      },
    })
  }
}

let nextRequest = 1
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = nextRequest++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    send({ type: 'request', id, method, params })
  })
}

const commands = new Map<string, (args: Record<string, unknown>) => unknown>()
const views = new Map<string, (input: Record<string, unknown>) => unknown>()
const tools = new Map<string, (args: Record<string, unknown>) => unknown>()
const hooks = new Map<string, Array<(event: { type: string; data: Record<string, unknown> }) => unknown>>()
const contextProviders = new Map<string, (input: { goal: string }) => unknown>()
const contributions: Array<{ kind: string; id: string }> = []
const implementations = new Map<string, object>()
let plugin: MultiAICoderPlugin | undefined

function createContext(manifest: PluginManifest, dataDir: string): PluginContext {
  return {
    manifest,
    apiVersion: 1,
    dataDir,
    log: (level, message) => send({ type: 'log', level, message: String(message).slice(0, 4000) }),
    project: () => call('project'),
    settings: { get: (key) => call('settings.get', { key }) },
    secrets: { get: (name) => call('secrets.get', { name }) },
    storage: {
      get: (key) => call('storage.get', { key }),
      set: (key, value) => call('storage.set', { key, value }),
      delete: (key) => call('storage.delete', { key }),
    },
    http: { fetch: (url, init) => call('http.fetch', { url, init: init ?? {} }) },
    fs: {
      read: (file, options) => call('fs.read', { path: file, root: options?.root }),
      write: (file, content, options) => call('fs.write', { path: file, content, root: options?.root }),
      list: (dir, options) => call('fs.list', { dir: dir ?? '', root: options?.root }),
    },
    process: { run: (executable, args, options) => call('process.run', { executable, args, options: options ?? {} }) },
    commands: { register: (id, handler) => void commands.set(id, handler as (args: Record<string, unknown>) => unknown) },
    views: { register: (id, render) => void views.set(id, render as (input: Record<string, unknown>) => unknown) },
    tools: { register: (name, handler) => void tools.set(name, handler as (args: Record<string, unknown>) => unknown) },
    events: { on: (type, handler) => void hooks.set(type, [...(hooks.get(type) ?? []), handler as (event: { type: string; data: Record<string, unknown> }) => unknown]) },
    contextProviders: { register: (id, provide) => void contextProviders.set(id, provide as (input: { goal: string }) => unknown) },
    contributions: { register: (kind, id, implementation) => {
      if (!manifest.contributes?.[kind]?.some((entry) => entry.id === id)) throw new Error(`Extension ${kind}/${id} is not declared.`)
      if (!EXTENSION_METHODS[kind]?.every((method) => typeof (implementation as unknown as Record<string, unknown>)?.[method] === 'function')) throw new Error(`Extension ${kind}/${id} does not implement the required methods.`)
      const key = `${kind}/${id}`
      if (implementations.has(key)) throw new Error(`Extension ${key} is already registered.`)
      implementations.set(key, implementation)
      contributions.push({ kind, id })
    } },
  }
}

async function load(manifest: PluginManifest, pluginDir: string): Promise<MultiAICoderPlugin> {
  const entry = path.resolve(pluginDir, manifest.main)
  if (!entry.toLowerCase().startsWith(path.resolve(pluginDir).toLowerCase() + path.sep)) throw new Error('Entry module is outside the plugin folder.')
  let loaded: unknown
  if (entry.endsWith('.mjs')) loaded = await import(pathToFileURL(entry).href)
  else {
    try {
      loaded = createRequire(entry)(entry)
    } catch (error) {
      if ((error as { code?: string }).code !== 'ERR_REQUIRE_ESM') throw error
      loaded = await import(pathToFileURL(entry).href)
    }
  }
  const candidate = ((loaded as { default?: unknown })?.default ?? loaded) as MultiAICoderPlugin
  if (typeof candidate?.activate !== 'function') throw new Error(`${manifest.main} does not export activate(context).`)
  return candidate
}

async function invoke(message: Extract<Message, { type: 'invoke' }>): Promise<unknown> {
  switch (message.kind) {
    case 'extension': {
      const kind = String(message.args.kind) as ExtensionKind
      const method = String(message.args.method)
      if (!EXTENSION_METHODS[kind]?.includes(method)) throw new Error(`Unsupported extension method ${kind}/${method}.`)
      const implementation = implementations.get(`${kind}/${message.name}`) as Record<string, (input: unknown) => unknown> | undefined
      if (!implementation) throw new Error(`Extension ${kind}/${message.name} is not registered.`)
      return await implementation[method]!.call(implementation, message.args.input)
    }
    case 'command': {
      const handler = commands.get(message.name)
      if (!handler) throw new Error(`Command "${message.name}" is not registered.`)
      return ((await handler(message.args)) ?? {}) as CommandResult
    }
    case 'view': {
      const render = views.get(message.name)
      if (!render) throw new Error(`View "${message.name}" is not registered.`)
      return (await render(message.args)) as ViewNode
    }
    case 'tool': {
      const handler = tools.get(message.name)
      if (!handler) throw new Error(`Tool "${message.name}" is not registered.`)
      return await handler(message.args)
    }
    case 'event': {
      for (const handler of hooks.get(message.name) ?? []) await handler({ type: message.name, data: message.args })
      return true
    }
    case 'context': {
      const provide = contextProviders.get(message.name)
      return provide ? await provide(message.args as { goal: string }) : undefined
    }
  }
}

process.on('message', (raw: Message) => {
  void (async () => {
    if (raw.type === 'response') {
      const waiter = pending.get(raw.id)
      pending.delete(raw.id)
      if (!waiter) return
      if (raw.ok) waiter.resolve(raw.value)
      else waiter.reject(new Error(raw.error ?? 'Request failed.'))
      return
    }
    if (raw.type === 'init') {
      try {
        if (raw.sandboxed) lockDownNetwork()
        plugin = await load(raw.manifest, raw.pluginDir)
        await plugin.activate(createContext(raw.manifest, raw.dataDir))
        send({ type: 'ready', registrations: { commands: [...commands.keys()], views: [...views.keys()], tools: [...tools.keys()], hooks: [...hooks.keys()], contextProviders: [...contextProviders.keys()], contributions } })
      } catch (error) {
        send({ type: 'fatal', error: error instanceof Error ? `${error.message}` : String(error) })
      }
      return
    }
    if (raw.type === 'invoke') {
      try {
        send({ type: 'result', id: raw.id, ok: true, value: await invoke(raw) })
      } catch (error) {
        send({ type: 'result', id: raw.id, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (raw.type === 'shutdown') {
      try {
        await plugin?.deactivate?.()
      } finally {
        process.exit(0)
      }
    }
  })()
})

// resource reporting for the runtime's monitor
setInterval(() => {
  const memory = process.memoryUsage()
  send({ type: 'metrics', rssMb: Math.round(memory.rss / 1024 / 1024), heapMb: Math.round(memory.heapUsed / 1024 / 1024), cpuMs: Math.round(process.cpuUsage().user / 1000) })
}, 5000).unref()

process.on('uncaughtException', (error) => send({ type: 'log', level: 'error', message: `uncaught: ${error.message}` }))
process.on('unhandledRejection', (error) => send({ type: 'log', level: 'error', message: `unhandled: ${error instanceof Error ? error.message : String(error)}` }))
process.on('disconnect', () => process.exit(0))
send({ type: 'alive' })
