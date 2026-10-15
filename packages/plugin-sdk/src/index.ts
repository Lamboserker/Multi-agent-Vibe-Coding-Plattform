/**
 * Multi-AI Coder plugin API, version 1.
 *
 * A plugin is a folder with `multi-ai-coder-plugin.json` (the manifest) and a JavaScript entry module
 * that exports `activate(context)` (and optionally `deactivate()`). Every plugin runs in its own host
 * process; it can only reach the application through the `PluginContext` it receives, and every
 * capability it uses must be declared in the manifest and granted by the user.
 */

export const PLUGIN_API_VERSION = 1
export const MANIFEST_FILE = 'multi-ai-coder-plugin.json'

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface PluginPermissions {
  /** Hosts the plugin may contact through context.http (e.g. "api.github.com", "*.gitlab.com", "*" = any). */
  network?: string[]
  /** Access to the files of the open project through context.fs. */
  fs?: 'none' | 'project-read' | 'project-write'
  /** Executables the plugin may start through context.process (e.g. "docker"). */
  processes?: string[]
  /** Names of secrets (stored encrypted by the app) the plugin may read. */
  secrets?: string[]
  /**
   * Direct network sockets and child processes (outside the PluginContext checks), e.g. a database
   * driver or a browser. Only honoured for plugins shipped with the app, and only after the user
   * grants it; third-party plugins always stay sandboxed.
   */
  native?: boolean
}

export interface CommandContribution {
  id: string
  title: string
  description?: string
  /** Shown before the command runs (destructive or costly commands). */
  confirm?: string
}

export interface ViewContribution {
  id: string
  title: string
}

export interface SettingContribution {
  key: string
  title: string
  type: 'string' | 'number' | 'boolean' | 'secret' | 'select'
  description?: string
  default?: string | number | boolean
  options?: string[]
  /**
   * For URL settings (e.g. an API base URL for self-hosted servers): the host of the URL the user
   * entered may be contacted through context.http in addition to permissions.network. Plugins cannot
   * change their own settings, so only the user widens the reach.
   */
  grantsHost?: boolean
}

export interface AgentToolContribution {
  name: string
  description: string
  /** JSON schema of the arguments. */
  inputSchema: Record<string, unknown>
  /** Tools that change something outside the conversation need an explicit grant per agent. */
  sideEffects?: boolean
}

export interface SimpleContribution {
  id: string
  title: string
  description?: string
}

export interface PluginContributions {
  commands?: CommandContribution[]
  views?: ViewContribution[]
  settings?: SettingContribution[]
  agentTools?: AgentToolContribution[]
  /** Runtime event types the plugin listens to (e.g. "run.execution_finished"). */
  hooks?: string[]
  contextProviders?: SimpleContribution[]
  modelProviders?: SimpleContribution[]
  orchestratorAdapters?: SimpleContribution[]
  repositoryAnalyzers?: SimpleContribution[]
  testRunners?: SimpleContribution[]
  languageIntegrations?: SimpleContribution[]
  gitIntegrations?: SimpleContribution[]
}

export interface PluginManifest {
  /** Lower-case identifier, unique per installation (letters, digits, "-", "."). */
  id: string
  name: string
  version: string
  description: string
  /** Plugin API version the plugin was written for. */
  apiVersion: number
  /** Entry module relative to the plugin folder (CommonJS or ES module). */
  main: string
  publisher?: string
  categories?: string[]
  homepage?: string
  permissions: PluginPermissions
  contributes?: PluginContributions
}

const ID = /^[a-z0-9][a-z0-9.-]{1,62}$/
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
const HOST = /^\*$|^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$|^localhost(:\d{1,5})?$|^127\.0\.0\.1(:\d{1,5})?$/
const BINARY = /^[\w.-]{1,64}$/

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

/** Validates a parsed manifest; returns it typed or throws ManifestError with the first problem. */
export function validateManifest(input: unknown): PluginManifest {
  const fail = (message: string): never => {
    throw new ManifestError(message)
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Manifest must be a JSON object.')
  const manifest = input as Record<string, unknown>
  if (typeof manifest.id !== 'string' || !ID.test(manifest.id)) fail('"id" must be lower-case letters, digits, "-" or "." (2–63 characters).')
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 80) fail('"name" is required (max. 80 characters).')
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) fail('"version" must be a semantic version (e.g. 1.0.0).')
  if (typeof manifest.description !== 'string' || manifest.description.length > 500) fail('"description" is required (max. 500 characters).')
  if (manifest.apiVersion !== PLUGIN_API_VERSION) fail(`"apiVersion" ${String(manifest.apiVersion)} is not supported (this app provides API version ${PLUGIN_API_VERSION}).`)
  if (typeof manifest.main !== 'string' || !/^[\w./-]+\.(c|m)?js$/.test(manifest.main) || manifest.main.split(/[\\/]/).includes('..') || manifest.main.startsWith('/')) fail('"main" must be a relative .js/.cjs/.mjs path inside the plugin.')
  const permissions = (manifest.permissions ?? {}) as Record<string, unknown>
  if (typeof permissions !== 'object' || Array.isArray(permissions)) fail('"permissions" must be an object.')
  if (permissions.network !== undefined && (!Array.isArray(permissions.network) || permissions.network.some((host) => typeof host !== 'string' || !HOST.test(host)))) fail('"permissions.network" must list host names (e.g. "api.github.com").')
  if (permissions.fs !== undefined && !['none', 'project-read', 'project-write'].includes(String(permissions.fs))) fail('"permissions.fs" must be none, project-read or project-write.')
  if (permissions.processes !== undefined && (!Array.isArray(permissions.processes) || permissions.processes.some((binary) => typeof binary !== 'string' || !BINARY.test(binary)))) fail('"permissions.processes" must list executable names.')
  if (permissions.secrets !== undefined && (!Array.isArray(permissions.secrets) || permissions.secrets.some((key) => typeof key !== 'string' || !/^[A-Za-z][\w.-]{0,63}$/.test(key)))) fail('"permissions.secrets" must list secret names.')
  if (permissions.native !== undefined && typeof permissions.native !== 'boolean') fail('"permissions.native" must be true or false.')
  const contributes = (manifest.contributes ?? {}) as Record<string, unknown>
  for (const key of ['commands', 'views']) {
    const list = contributes[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || list.some((entry) => !entry || typeof (entry as { id?: unknown }).id !== 'string' || typeof (entry as { title?: unknown }).title !== 'string')) fail(`"contributes.${key}" entries need "id" and "title".`)
  }
  const tools = contributes.agentTools
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool) => !tool || !/^[a-z][\w-]{1,63}$/i.test(String((tool as { name?: unknown }).name)) || typeof (tool as { description?: unknown }).description !== 'string'))) fail('"contributes.agentTools" entries need "name", "description" and "inputSchema".')
  return manifest as unknown as PluginManifest
}

// ---------------------------------------------------------------------------
// Declarative views (rendered by the app; plugins never run code in the UI)
// ---------------------------------------------------------------------------

export type ViewNode =
  | { type: 'stack'; children: ViewNode[] }
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string; tone?: 'normal' | 'muted' | 'error' | 'success' | 'warning' }
  | { type: 'markdown'; text: string }
  | { type: 'code'; content: string; language?: string }
  | { type: 'kv'; items: Array<{ label: string; value: string }> }
  | { type: 'badge'; text: string; tone?: 'ok' | 'warn' | 'error' | 'accent' }
  | { type: 'image'; dataUrl: string; alt: string }
  | { type: 'table'; columns: string[]; rows: Array<{ cells: string[]; actions?: ViewAction[] }> }
  | { type: 'actions'; items: ViewAction[] }
  | { type: 'form'; fields: ViewField[]; submit: ViewAction }

export interface ViewAction {
  label: string
  /** Command of this plugin that is invoked. */
  command: string
  args?: Record<string, unknown>
  /** Confirmation text shown before running. */
  confirm?: string
  /** "chat": the command result (text) is offered as context for the orchestrator chat. */
  resultTarget?: 'view' | 'chat' | 'editor'
}

export interface ViewField {
  name: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'select' | 'checkbox'
  value?: string | number | boolean
  options?: string[]
  placeholder?: string
}

/** What a command returns: a message, a view to show, and/or text to hand over (chat/editor). */
export interface CommandResult {
  message?: string
  view?: ViewNode
  text?: string
  title?: string
  /** Re-render the plugin's view with this input (e.g. a form pre-filled with a saved request). */
  reloadView?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Context handed to activate()
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  id: string
  name: string
  repoPath: string
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
  durationMs: number
}

export interface ProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
}

export type CommandHandler = (args: Record<string, unknown>) => Promise<CommandResult | void> | CommandResult | void
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown
export type ViewRenderer = (input: Record<string, unknown>) => Promise<ViewNode> | ViewNode
export type EventHandler = (event: { type: string; data: Record<string, unknown> }) => Promise<void> | void
export type ContextProvider = (input: { goal: string; project?: ProjectInfo }) => Promise<string | undefined> | string | undefined

/** JSON-only contracts: implementations stay in the isolated plugin process. */
export interface ExtensionImplementations {
  modelProviders: {
    models(input: Record<string, unknown>): Promise<Array<{ id: string; contextTokens: number; toolCalling: boolean }>>
    generate(input: { model: string; messages: Array<{ role: string; content: string }>; contextTokens?: number; maxTokens?: number }): Promise<{ text: string; inputTokens?: number; outputTokens?: number }>
  }
  /**
   * Every input carries `operation` ("analyze" | "plan" | "execute" | "review" | "chat"), the JSON
   * `schema` the result must satisfy (same strict schemas as Claude Code/Codex), `cwd` and `runId`.
   * `plan` serves both "analyze" (task analysis) and "plan" (execution plan). Results are validated.
   */
  orchestratorAdapters: {
    plan(input: Record<string, unknown> & { operation: 'analyze' | 'plan'; schema: unknown }): Promise<unknown>
    execute(input: Record<string, unknown> & { operation: 'execute'; schema: unknown; cwd: string }): Promise<{ summary: string; filesChanged: string[]; commandsRun?: string[] }>
    review(input: Record<string, unknown> & { operation: 'review'; schema: unknown }): Promise<unknown>
    chat(input: Record<string, unknown> & { operation: 'chat'; question: string }): Promise<{ answer: string }>
  }
  repositoryAnalyzers: { analyze(input: { project?: ProjectInfo; goal: string }): Promise<{ summary: string; relevantFiles?: string[] }> }
  testRunners: { run(input: { project?: ProjectInfo; cwd: string; goal?: string }): Promise<{ passed: number; failed: number; output: string }> }
  /** Return `{ unsupported: true }` for files/methods the integration does not handle: the app then uses its own language server. */
  languageIntegrations: { request(input: { project?: ProjectInfo; method: string; params: { file: string; args: unknown[] } }): Promise<unknown> }
  /** Operations: "status", "diff" ({ file?, staged? }), "branches". Return `{ unsupported: true }` to let the app use git itself. */
  gitIntegrations: { request(input: { project?: ProjectInfo; operation: string; args: Record<string, unknown> }): Promise<unknown> }
}
export type ExtensionKind = keyof ExtensionImplementations
export const EXTENSION_METHODS: Record<ExtensionKind, readonly string[]> = {
  modelProviders: ['models', 'generate'], orchestratorAdapters: ['plan', 'execute', 'review', 'chat'],
  repositoryAnalyzers: ['analyze'], testRunners: ['run'], languageIntegrations: ['request'], gitIntegrations: ['request'],
}

export interface PluginContext {
  readonly manifest: PluginManifest
  readonly apiVersion: number
  /** Private folder of the plugin: readable and writable with node:fs (removed on uninstall). */
  readonly dataDir: string
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  /** The project currently open in the app (if any). */
  project(): Promise<ProjectInfo | undefined>
  settings: { get<T = unknown>(key: string): Promise<T | undefined> }
  /** Requires permissions.secrets. */
  secrets: { get(name: string): Promise<string | undefined> }
  /** Small JSON storage private to the plugin. */
  storage: { get<T = unknown>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> }
  /** Requires permissions.network for the target host. */
  http: { fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<HttpResponse> }
  /**
   * Project-relative paths; requires permissions.fs. `root` may name a directory the app handed to
   * the running extension call (its `cwd` or `project.repoPath`, e.g. an agent worktree); default is
   * the open project.
   */
  fs: { read(path: string, options?: { root?: string }): Promise<string>; write(path: string, content: string, options?: { root?: string }): Promise<void>; list(dir?: string, options?: { root?: string }): Promise<Array<{ name: string; path: string; type: 'file' | 'directory' }>> }
  /** Requires permissions.processes to include the executable. `cwd`: "project" or a directory handed to the running extension call. */
  process: { run(executable: string, args: string[], options?: { cwd?: string; timeoutMs?: number; input?: string }): Promise<ProcessResult> }
  commands: { register(id: string, handler: CommandHandler): void }
  views: { register(id: string, render: ViewRenderer): void }
  tools: { register(name: string, handler: ToolHandler): void }
  events: { on(type: string, handler: EventHandler): void }
  contextProviders: { register(id: string, provide: ContextProvider): void }
  contributions: { register<K extends ExtensionKind>(kind: K, id: string, implementation: ExtensionImplementations[K]): void }
}

export interface MultiAICoderPlugin {
  activate(context: PluginContext): Promise<void> | void
  deactivate?(): Promise<void> | void
}

/** Typing helper for plugin authors: `export default definePlugin({ activate(context) { … } })`. */
export function definePlugin(plugin: MultiAICoderPlugin): MultiAICoderPlugin {
  return plugin
}

/** Whether a host is allowed by a permission list ("*.example.com" matches sub-domains). */
export function hostAllowed(host: string, allowed: string[] = []): boolean {
  const target = host.toLowerCase()
  const hostname = target.replace(/:\d+$/, '')
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase()
    // "*" = any host (the permission dialog says so explicitly; meant for tools like a REST client)
    if (pattern === '*') return true
    // a pattern without a port allows every port of that host
    const subject = /:\d+$/.test(pattern) ? target : hostname
    if (pattern.startsWith('*.')) return subject.endsWith(pattern.slice(1)) && subject !== pattern.slice(2)
    return subject === pattern
  })
}

/** Compares two semantic versions (-1, 0, 1). */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split(/[-+]/)[0]!.split('.').map(Number)
  const [left, right] = [parse(a), parse(b)]
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0) ? 1 : -1
  }
  return 0
}
