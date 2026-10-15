import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import type { Plugin as PluginRecord } from '@prisma/client'
import { fork, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Subscription } from 'rxjs'
import { EXTENSION_METHODS, compareVersions, hostAllowed, MANIFEST_FILE, validateManifest, type ExtensionKind, type CommandResult, type PluginManifest, type PluginPermissions, type ViewNode } from '@multi-ai-coder/plugin-sdk'
import { cloneRepository, resolveExecutable, resolveInside, runProcess, sanitizedEnv, withAbort, type AgentTool } from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { asJson, jsonObject } from '../common/json.js'
import { KeyedMutex } from '../common/locks.js'
import { EventBusService } from '../runtime/event-bus.service.js'
import { runtimeConfig } from '../runtime/runtime-config.js'
import { SettingsService } from '../runtime/settings.service.js'
import { shellAvailable, shellRequest } from '../runtime/shell-bridge.js'

const CALL_TIMEOUT_MS = 30_000

/** Hosts of URL settings marked `grantsHost` that the user filled in (see SettingContribution). */
function settingHosts(record: PluginRecord): string[] {
  const values = jsonObject(record.settings)
  return ((record.manifest as unknown as PluginManifest).contributes?.settings ?? []).flatMap((setting) => {
    const value = values[setting.key]
    if (!setting.grantsHost || typeof value !== 'string' || !value) return []
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) ? [url.host.toLowerCase()] : []
    } catch {
      return []
    }
  })
}
/** Extension calls do real work (test runs, generation, edits); interactive ones stay short. */
const EXTENSION_TIMEOUT_MS: Record<ExtensionKind, number> = {
  modelProviders: 10 * 60_000,
  orchestratorAdapters: 15 * 60_000,
  repositoryAnalyzers: 60_000,
  testRunners: 10 * 60_000,
  languageIntegrations: 30_000,
  gitIntegrations: 30_000,
}
const MEMORY_LIMIT_MB = 256
const MAX_PLUGIN_BYTES = 80 * 1024 * 1024
const RESTART_WINDOW_MS = 5 * 60_000
const MAX_RESTARTS = 3

export interface Registrations {
  commands: string[]
  views: string[]
  tools: string[]
  hooks: string[]
  contextProviders: string[]
  contributions: Array<{ kind: string; id: string }>
}

interface Host {
  child: ChildProcess
  lifetime: AbortController
  ready: Promise<Registrations>
  registrations?: Registrations
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>
  metrics?: { rssMb: number; heapMb: number; cpuMs: number; at: string }
  stopping: boolean
  /** Project folder the process may access at Node level (fs grant). */
  projectPath?: string
  fsGranted: boolean
}

export interface PluginLogLine {
  at: string
  level: string
  message: string
}

/** Directories of the plugins that ship with the app (dev: <repo>/plugins). */
function builtinDir(): string {
  if (process.env.MAC_BUILTIN_PLUGINS_DIR) return process.env.MAC_BUILTIN_PLUGINS_DIR
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, '../../../../plugins'), path.resolve(here, '../../../plugins'), path.resolve(process.cwd(), 'plugins'), path.resolve(process.cwd(), '../../plugins')]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

/** Plugin host script: bundled next to the runtime (desktop) or compiled by tsc (dev). */
function hostScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // bundle: next to main.cjs; tsc: dist/plugins/host; tests (src): the tsc output
  const candidates = [process.env.MAC_PLUGIN_HOST ?? '', path.join(here, 'plugin-host.cjs'), path.join(here, 'host', 'plugin-host.cjs'), path.resolve(here, '../../dist/plugins/host/plugin-host.cjs')].filter(Boolean)
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`Plugin host not found (${candidates.join(', ')}). Build the runtime first.`)
  return found
}

async function filesOf(dir: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (relative: string) => {
    for (const entry of await fs.readdir(path.join(dir, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.name === '.git') continue
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) files.push(child)
    }
  }
  await walk('')
  return files.sort()
}

/** SHA-256 of every file of a plugin (integrity check before each activation). */
export async function integrityOf(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  let total = 0
  for (const file of await filesOf(dir)) {
    const content = await fs.readFile(path.join(dir, file))
    total += content.length
    if (total > MAX_PLUGIN_BYTES) throw new BadRequestException(`Plugin is larger than ${MAX_PLUGIN_BYTES / 1024 / 1024} MB.`)
    result[file] = createHash('sha256').update(content).digest('hex')
  }
  return result
}

/** Permissions requested by the manifest that the grant does not cover. */
export function missingGrants(requested: PluginPermissions, granted: PluginPermissions): string[] {
  const missing: string[] = []
  for (const host of requested.network ?? []) if (!(granted.network ?? []).includes(host)) missing.push(`network:${host}`)
  const rank = { none: 0, 'project-read': 1, 'project-write': 2 }
  if (rank[requested.fs ?? 'none'] > rank[granted.fs ?? 'none']) missing.push(`fs:${requested.fs}`)
  for (const binary of requested.processes ?? []) if (!(granted.processes ?? []).includes(binary)) missing.push(`process:${binary}`)
  for (const secret of requested.secrets ?? []) if (!(granted.secrets ?? []).includes(secret)) missing.push(`secret:${secret}`)
  if (requested.native && !granted.native) missing.push('native')
  return missing
}

/**
 * Installs, activates and runs plugins. Each enabled plugin runs in its own host process with the
 * Node permission model; every effect of a plugin (network, files, processes, secrets, storage) is a
 * request that is checked here against the permissions the user granted.
 */
@Injectable()
export class PluginsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Plugins')
  private readonly hosts = new Map<string, Host>()
  private shuttingDown = false
  private readonly restartTimers = new Set<NodeJS.Timeout>()
  private readonly logs = new Map<string, PluginLogLine[]>()
  private readonly crashes = new Map<string, number[]>()
  private readonly locks = new KeyedMutex()
  private subscription?: Subscription
  private nextCall = 1

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
    private readonly settings: SettingsService,
  ) {}

  get userDir() {
    return path.join(runtimeConfig().dataDir, 'plugins')
  }

  dirOf(record: Pick<PluginRecord, 'id' | 'source'>) {
    return record.source === 'builtin' ? path.join(builtinDir(), record.id) : path.join(this.userDir, record.id)
  }

  async onModuleInit() {
    await fs.mkdir(this.userDir, { recursive: true })
    this.subscription = this.events.stream().subscribe((event) => {
      if (event.type === 'settings_changed' && Array.isArray(event.data.keys) && event.data.keys.includes('lastProjectId')) void this.onProjectChanged()
      this.dispatchEvent(`${event.channel}.${event.type}`, event.data)
    })
  }

  private async currentProject() {
    const settings = await this.settings.get()
    return settings.lastProjectId ? this.prisma.project.findUnique({ where: { id: settings.lastProjectId }, select: { id: true, name: true, repoPath: true } }) : null
  }

  /** Plugins with an fs grant get access to the newly opened project (their process is restarted). */
  private async onProjectChanged() {
    const project = await this.currentProject()
    for (const [id, host] of [...this.hosts]) {
      if (!host.fsGranted || host.projectPath === project?.repoPath) continue
      await this.locks.run(id, async () => {
        await this.stopHost(id)
        await this.activate(id).catch(() => undefined)
      })
    }
  }

  /** Registers the plugins that ship with the app and starts the enabled ones. */
  private builtinsSynced?: Promise<void>
  /** plugin → directories delegated by running extension calls (reference counted). */
  private readonly delegations = new Map<string, Map<string, number>>()

  /** Registers the shipped plugins once; every listing waits for it (independent of when start() runs). */
  private ensureBuiltins() {
    this.builtinsSynced ??= this.syncBuiltins().catch((error: unknown) => this.logger.warn(`Built-in plugins: ${error instanceof Error ? error.message : String(error)}`))
    return this.builtinsSynced
  }

  async start() {
    await this.ensureBuiltins()
    for (const record of await this.prisma.plugin.findMany({ where: { enabled: true } })) {
      void this.activate(record.id).catch((error: unknown) => this.logger.warn(`Plugin ${record.id}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  async onApplicationShutdown() {
    this.shuttingDown = true
    for (const timer of this.restartTimers) clearTimeout(timer)
    this.restartTimers.clear()
    this.subscription?.unsubscribe()
    await Promise.all([...this.hosts.keys()].map((id) => this.stopHost(id)))
  }

  // ---------------------------------------------------------------------------
  // Catalog & installation
  // ---------------------------------------------------------------------------

  private async readManifest(dir: string): Promise<PluginManifest> {
    const file = path.join(dir, MANIFEST_FILE)
    if (!existsSync(file)) throw new BadRequestException(`${MANIFEST_FILE} not found in ${dir}.`)
    try {
      return validateManifest(JSON.parse(await fs.readFile(file, 'utf8')))
    } catch (error) {
      throw new BadRequestException(`Invalid plugin manifest: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Plugins shipped with the app are trusted; their record is updated when a newer version ships. */
  private async syncBuiltins() {
    const dir = builtinDir()
    if (!existsSync(dir)) return
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(path.join(dir, entry.name, MANIFEST_FILE))) continue
      const manifest = await this.readManifest(path.join(dir, entry.name))
      if (manifest.id !== entry.name) continue
      const existing = await this.prisma.plugin.findUnique({ where: { id: manifest.id } })
      if (existing && existing.source !== 'builtin') continue // a user installation with the same id wins
      const integrity = await integrityOf(path.join(dir, entry.name))
      if (!existing) {
        await this.prisma.plugin.create({ data: { id: manifest.id, name: manifest.name, version: manifest.version, source: 'builtin', trust: 'trusted', manifest: asJson(manifest), integrity: asJson(integrity), status: 'installed' } })
      } else if (existing.version !== manifest.version || JSON.stringify(existing.integrity) !== JSON.stringify(integrity)) {
        await this.prisma.plugin.update({ where: { id: manifest.id }, data: { name: manifest.name, version: manifest.version, manifest: asJson(manifest), integrity: asJson(integrity) } })
      }
    }
  }

  async list() {
    await this.ensureBuiltins()
    const records = await this.prisma.plugin.findMany({ orderBy: [{ source: 'asc' }, { name: 'asc' }] })
    return records.map((record) => this.describe(record))
  }

  private describe(record: PluginRecord) {
    const manifest = record.manifest as unknown as PluginManifest
    const host = this.hosts.get(record.id)
    const settings = jsonObject(record.settings)
    return {
      id: record.id,
      name: record.name,
      version: record.version,
      description: manifest.description,
      publisher: manifest.publisher,
      categories: manifest.categories ?? [],
      source: record.source,
      sourceRef: record.sourceRef,
      trust: record.trust,
      enabled: record.enabled,
      status: record.status,
      lastError: record.lastError,
      permissions: manifest.permissions,
      granted: record.granted as PluginPermissions,
      missingGrants: missingGrants(manifest.permissions ?? {}, record.granted as PluginPermissions),
      contributes: manifest.contributes ?? {},
      settings: Object.fromEntries((manifest.contributes?.settings ?? []).filter((setting) => setting.type !== 'secret').map((setting) => [setting.key, settings[setting.key] ?? setting.default ?? null])),
      registrations: host?.registrations ?? null,
      metrics: host?.metrics ?? null,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
    }
  }

  async get(id: string) {
    await this.ensureBuiltins()
    const record = await this.prisma.plugin.findUnique({ where: { id } })
    if (!record) throw new NotFoundException(`Plugin ${id} is not installed.`)
    return { ...this.describe(record), logs: this.logs.get(id) ?? [] }
  }

  /**
   * Installs a plugin from a local folder or a git repository. Third-party code is untrusted: it is
   * only copied (no install scripts run), validated, hashed, and stays disabled until the user grants
   * its permissions.
   */
  async install(input: { folder?: string; gitUrl?: string; allowDowngrade?: boolean }) {
    await this.ensureBuiltins()
    if (!input.folder === !input.gitUrl) throw new BadRequestException('Provide either a folder or a git URL.')
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-plugin-'))
    try {
      let sourceDir: string
      if (input.gitUrl) {
        if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(input.gitUrl)) throw new BadRequestException('Only https:// or ssh git URLs are supported.')
        sourceDir = path.join(staging, 'clone')
        await cloneRepository(input.gitUrl, sourceDir)
      } else {
        sourceDir = path.resolve(input.folder!)
        if (!existsSync(sourceDir)) throw new BadRequestException(`Folder not found: ${input.folder}`)
      }
      const manifest = await this.readManifest(sourceDir)
      return await this.locks.run(manifest.id, async () => {
        const existing = await this.prisma.plugin.findUnique({ where: { id: manifest.id } })
        if (existing?.source === 'builtin') throw new ConflictException(`"${manifest.id}" is a built-in plugin.`)
        if (existing && compareVersions(manifest.version, existing.version) < 0 && !input.allowDowngrade) {
          throw new ConflictException(`Version conflict: ${manifest.version} is older than the installed ${existing.version}. Confirm the downgrade to continue.`)
        }
        if (existing) await this.stopHost(manifest.id)
        const target = path.join(this.userDir, manifest.id)
        const next = `${target}.next`
        await fs.rm(next, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        await fs.cp(sourceDir, next, { recursive: true, filter: (source) => path.basename(source) !== '.git' })
        const integrity = await integrityOf(next)
        await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        await fs.rename(next, target)
        const source = input.gitUrl ? 'git' : 'folder'
        const sourceRef = input.gitUrl ?? sourceDir
        // Grants survive an update only as far as the new version still requests them.
        const previousGrant = (existing?.granted ?? {}) as PluginPermissions
        const granted = this.intersect(previousGrant, manifest.permissions ?? {})
        const stillGranted = missingGrants(manifest.permissions ?? {}, granted).length === 0
        const data = { name: manifest.name, version: manifest.version, source, sourceRef, trust: 'untrusted', manifest: asJson(manifest), integrity: asJson(integrity), granted: asJson(granted), enabled: Boolean(existing?.enabled && stillGranted), status: 'installed', lastError: null }
        const record = existing ? await this.prisma.plugin.update({ where: { id: manifest.id }, data }) : await this.prisma.plugin.create({ data: { id: manifest.id, ...data } })
        this.events.publish('system', 'plugin_installed', { id: manifest.id, version: manifest.version, update: Boolean(existing) })
        if (record.enabled) await this.activate(record.id).catch(() => undefined)
        return this.describe((await this.prisma.plugin.findUnique({ where: { id: manifest.id } }))!)
      })
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Re-installs from the recorded source (git: fresh clone; folder: copy again). */
  async update(id: string) {
    await this.ensureBuiltins()
    const record = await this.prisma.plugin.findUnique({ where: { id } })
    if (!record) throw new NotFoundException(`Plugin ${id} is not installed.`)
    if (record.source === 'builtin') throw new BadRequestException('Built-in plugins are updated with the app.')
    return record.source === 'git' ? this.install({ gitUrl: record.sourceRef! }) : this.install({ folder: record.sourceRef! })
  }

  private intersect(granted: PluginPermissions, requested: PluginPermissions): PluginPermissions {
    const rank = { none: 0, 'project-read': 1, 'project-write': 2 }
    const fsGrant = rank[granted.fs ?? 'none'] >= rank[requested.fs ?? 'none'] ? requested.fs : granted.fs
    return {
      network: (requested.network ?? []).filter((host) => (granted.network ?? []).includes(host)),
      fs: fsGrant ?? 'none',
      processes: (requested.processes ?? []).filter((binary) => (granted.processes ?? []).includes(binary)),
      secrets: (requested.secrets ?? []).filter((secret) => (granted.secrets ?? []).includes(secret)),
      native: Boolean(requested.native && granted.native),
    }
  }

  async uninstall(id: string) {
    await this.ensureBuiltins()
    return this.locks.run(id, async () => {
      const record = await this.prisma.plugin.findUnique({ where: { id } })
      if (!record) throw new NotFoundException(`Plugin ${id} is not installed.`)
      if (record.source === 'builtin') throw new BadRequestException('Built-in plugins can be disabled, not uninstalled.')
      await this.stopHost(id)
      // Windows: the stopped host process may still hold the folder for a moment (EBUSY)
      await fs.rm(path.join(this.userDir, id), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      await fs.rm(path.join(runtimeConfig().dataDir, 'plugin-data', id), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined)
      await this.prisma.plugin.delete({ where: { id } })
      this.logs.delete(id)
      this.events.publish('system', 'plugin_uninstalled', { id })
      return { ok: true }
    })
  }

  // ---------------------------------------------------------------------------
  // Enable / disable / settings
  // ---------------------------------------------------------------------------

  /** Enables a plugin with the permissions the user granted (must cover what the manifest requests). */
  async enable(id: string, grant?: PluginPermissions) {
    await this.ensureBuiltins()
    return this.locks.run(id, async () => {
      const record = await this.prisma.plugin.findUnique({ where: { id } })
      if (!record) throw new NotFoundException(`Plugin ${id} is not installed.`)
      const manifest = record.manifest as unknown as PluginManifest
      const granted = grant ? this.intersect(grant, manifest.permissions ?? {}) : (record.granted as PluginPermissions)
      const missing = missingGrants(manifest.permissions ?? {}, granted)
      if (missing.length) throw new BadRequestException(`Permissions not granted: ${missing.join(', ')}`)
      await this.prisma.plugin.update({ where: { id }, data: { enabled: true, granted: asJson(granted) } })
      this.crashes.delete(id)
      await this.activate(id)
      return this.describe((await this.prisma.plugin.findUnique({ where: { id } }))!)
    })
  }

  async disable(id: string) {
    await this.ensureBuiltins()
    return this.locks.run(id, async () => {
      await this.stopHost(id)
      const record = await this.prisma.plugin.update({ where: { id }, data: { enabled: false, status: 'disabled' } })
      this.events.publish('system', 'plugin_status', { id, status: 'disabled' })
      return this.describe(record)
    })
  }

  async updateSettings(id: string, values: Record<string, unknown>) {
    await this.ensureBuiltins()
    const record = await this.prisma.plugin.findUnique({ where: { id } })
    if (!record) throw new NotFoundException(`Plugin ${id} is not installed.`)
    const declared = new Map(((record.manifest as unknown as PluginManifest).contributes?.settings ?? []).map((setting) => [setting.key, setting]))
    const next = { ...jsonObject(record.settings) }
    for (const [key, value] of Object.entries(values)) {
      const setting = declared.get(key)
      if (!setting || setting.type === 'secret') throw new BadRequestException(`Unknown setting "${key}".`)
      if (setting.type === 'number' && typeof value !== 'number') throw new BadRequestException(`"${key}" must be a number.`)
      if (setting.type === 'boolean' && typeof value !== 'boolean') throw new BadRequestException(`"${key}" must be a boolean.`)
      if ((setting.type === 'string' || setting.type === 'select') && typeof value !== 'string') throw new BadRequestException(`"${key}" must be text.`)
      if (setting.type === 'select' && !(setting.options ?? []).includes(value as string)) throw new BadRequestException(`"${key}" must be one of ${(setting.options ?? []).join(', ')}.`)
      next[key] = value
    }
    return this.describe(await this.prisma.plugin.update({ where: { id }, data: { settings: asJson(next) } }))
  }

  // ---------------------------------------------------------------------------
  // Host process
  // ---------------------------------------------------------------------------

  private log(id: string, level: string, message: string) {
    const lines = this.logs.get(id) ?? []
    lines.push({ at: new Date().toISOString(), level, message: message.slice(0, 4000) })
    if (lines.length > 300) lines.shift()
    this.logs.set(id, lines)
  }

  private async setStatus(id: string, status: string, lastError: string | null = null) {
    await this.prisma.plugin.update({ where: { id }, data: { status, lastError } }).catch(() => undefined)
    this.events.publish('system', 'plugin_status', { id, status, error: lastError })
  }

  /** Starts the host of an enabled plugin after checking its integrity. */
  private async activate(id: string, signal?: AbortSignal): Promise<Registrations> {
    if (this.shuttingDown) throw new Error('Plugin runtime is shutting down.')
    signal?.throwIfAborted()
    const existing = this.hosts.get(id)
    if (existing) return existing.ready
    const record = await this.prisma.plugin.findUniqueOrThrow({ where: { id } })
    const dir = this.dirOf(record)
    const integrity = await integrityOf(dir)
    if (JSON.stringify(integrity) !== JSON.stringify(record.integrity)) {
      await this.prisma.plugin.update({ where: { id }, data: { enabled: false } })
      await this.setStatus(id, 'error', 'Integrity check failed: the plugin files changed after installation. Re-install or update the plugin.')
      throw new BadRequestException(`Integrity check failed for ${id}.`)
    }
    const manifest = record.manifest as unknown as PluginManifest
    const granted = record.granted as PluginPermissions
    const trusted = record.trust === 'trusted'
    const script = hostScript()
    // private data folder: the only place a plugin may write at Node level (besides an fs grant)
    const dataDir = path.join(runtimeConfig().dataDir, 'plugin-data', id)
    await fs.mkdir(dataDir, { recursive: true })
    const execArgv = [`--max-old-space-size=${MEMORY_LIMIT_MB}`, '--permission', `--allow-fs-read=${dir}`, `--allow-fs-read=${script}`, `--allow-fs-read=${dataDir}`, `--allow-fs-write=${dataDir}`]
    // An fs grant also gives Node-level access to the open project's folder (e.g. a SQLite file in
    // the project); the host is restarted when another project is opened.
    let projectPath: string | undefined
    if ((granted.fs ?? 'none') !== 'none') {
      projectPath = (await this.currentProject())?.repoPath
      if (projectPath) {
        execArgv.push(`--allow-fs-read=${projectPath}`)
        if (granted.fs === 'project-write') execArgv.push(`--allow-fs-write=${projectPath}`)
      }
    }
    // trusted (shipped) plugins may start their declared executables themselves (e.g. a browser)
    // native access (sockets, child processes) only for shipped plugins whose grant includes it
    const native = trusted && Boolean(manifest.permissions?.native && granted.native)
    if (native) execArgv.push('--allow-child-process')
    const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
    // minimal environment: no tokens or credentials of the app's own environment reach a plugin
    const passed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'localappdata', 'appdata', 'programfiles', 'programfiles(x86)', 'programw6432', 'lang', 'docker_host'])
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && passed.has(key.toLowerCase())) env[key] = value
    signal?.throwIfAborted()
    if (this.shuttingDown) throw new Error('Plugin runtime is shutting down.')
    const child = fork(script, [], { execPath: process.execPath, execArgv, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd: dir })
    const host: Host = { child, lifetime: new AbortController(), pending: new Map(), stopping: false, ready: Promise.resolve({} as Registrations), projectPath, fsGranted: (granted.fs ?? 'none') !== 'none' }
    this.hosts.set(id, host)
    child.stdout?.on('data', (chunk: Buffer) => this.log(id, 'info', chunk.toString('utf8').trimEnd()))
    child.stderr?.on('data', (chunk: Buffer) => this.log(id, 'error', chunk.toString('utf8').trimEnd()))
    host.ready = new Promise<Registrations>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Plugin did not activate within 20 s.')), 20_000)
      child.on('message', (message: Record<string, unknown>) => {
        if (message.type === 'alive') child.send({ type: 'init', manifest, pluginDir: dir, dataDir, sandboxed: !native })
        else if (message.type === 'ready') {
          clearTimeout(timer)
          host.registrations = message.registrations as Registrations
          resolve(host.registrations)
        } else if (message.type === 'fatal') {
          clearTimeout(timer)
          reject(new Error(String(message.error)))
        } else this.onHostMessage(id, host, message)
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`Plugin host exited (${code ?? signal}).`))
        void this.onHostExit(id, host, code, signal)
      })
    })
    try {
      const registrations = await withAbort(host.ready, signal)
      await this.setStatus(id, 'active')
      this.log(id, 'info', `activated (${trusted ? 'trusted' : 'untrusted'}, ${native ? 'native access' : 'sandboxed'}): ${registrations.commands.length} command(s), ${registrations.views.length} view(s), ${registrations.tools.length} tool(s)`)
      return registrations
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(id, 'error', message)
      await this.stopHost(id)
      await this.setStatus(id, 'error', message)
      throw new BadRequestException(`Plugin ${id} could not be activated: ${message}`)
    }
  }

  private async onHostExit(id: string, host: Host, code: number | null, signal: NodeJS.Signals | null) {
    host.lifetime.abort(new Error('Plugin host exited.'))
    for (const waiter of host.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('The plugin process ended.'))
    }
    host.pending.clear()
    if (this.hosts.get(id) === host) this.hosts.delete(id)
    if (host.stopping || !host.registrations || this.shuttingDown) return
    // crash: restart with backoff, at most MAX_RESTARTS times in RESTART_WINDOW_MS
    const now = Date.now()
    const recent = [...(this.crashes.get(id) ?? []).filter((at) => now - at < RESTART_WINDOW_MS), now]
    this.crashes.set(id, recent)
    this.log(id, 'error', `plugin process crashed (exit ${code ?? signal})`)
    if (recent.length > MAX_RESTARTS) {
      await this.setStatus(id, 'crashed', `Crashed ${recent.length} times in 5 minutes; disabled until it is enabled again.`)
      await this.prisma.plugin.update({ where: { id }, data: { enabled: false } }).catch(() => undefined)
      return
    }
    await this.setStatus(id, 'crashed', `Crashed (exit ${code ?? signal}); restarting.`)
    const timer = setTimeout(() => {
      this.restartTimers.delete(timer)
      if (!this.shuttingDown) void this.activate(id).catch(() => undefined)
    }, 1000 * 2 ** (recent.length - 1))
    this.restartTimers.add(timer)
  }

  private async stopHost(id: string) {
    const host = this.hosts.get(id)
    if (!host) return
    host.stopping = true
    host.lifetime.abort(new Error('Plugin host stopped; delegated requests cancelled.'))
    this.hosts.delete(id)
    if (host.child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        host.child.kill()
        resolve()
      }, 3000)
      host.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        if (host.child.connected) host.child.send({ type: 'shutdown' }, (error) => { if (error) host.child.kill() })
        else host.child.kill()
      } catch {
        host.child.kill()
      }
    })
  }

  private async hostFor(id: string, signal?: AbortSignal): Promise<Host> {
    signal?.throwIfAborted()
    const record = await this.prisma.plugin.findUnique({ where: { id } })
    if (!record?.enabled) throw new BadRequestException(`Plugin ${id} is not enabled.`)
    if (!this.hosts.has(id)) await this.activate(id, signal)
    const host = this.hosts.get(id)!
    await withAbort(host.ready, signal)
    return host
  }

  /** Calls into a plugin (command, view, tool, event, context provider) with a timeout. */
  private async call<T>(id: string, kind: 'command' | 'view' | 'tool' | 'event' | 'context' | 'extension', name: string, args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const host = await this.hostFor(id, signal)
    signal?.throwIfAborted()
    const callId = this.nextCall++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        host.pending.delete(callId)
        this.log(id, 'error', `${kind} ${name} timed out after ${timeoutMs / 1000}s; stopping the plugin and its delegated work`)
        void this.stopHost(id) // also abort delegated HTTP/process requests
        reject(new BadRequestException(`Plugin ${id}: ${kind} "${name}" did not answer within ${timeoutMs / 1000} s.`))
      }, timeoutMs)
      const abort = () => {
        clearTimeout(timer)
        host.pending.delete(callId)
        signal?.removeEventListener('abort', abort)
        void this.stopHost(id)
        reject(new Error(signal?.reason?.name === 'TimeoutError' ? `Plugin ${id}: call timed out after ${timeoutMs / 1000} s.` : `Plugin ${id}: call cancelled.`))
      }
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      host.pending.set(callId, { resolve: (value) => { clean(); resolve(value as T) }, reject: (error) => { clean(); reject(error) }, timer })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      try { host.child.send({ type: 'invoke', id: callId, kind, name, args }, (error) => {
        if (error) { const waiter = host.pending.get(callId); host.pending.delete(callId); waiter?.reject(error); void this.stopHost(id) }
      }) } catch (error) {
        host.pending.delete(callId); clean(); void this.stopHost(id); reject(error)
      }
    })
  }

  async extensionCatalog(kind?: ExtensionKind) {
    await this.ensureBuiltins()
    const result: Array<{ plugin: string; kind: ExtensionKind; id: string; title: string }> = []
    for (const record of await this.prisma.plugin.findMany({ where: { enabled: true } })) {
      const host = await this.hostFor(record.id)
      const manifest = record.manifest as unknown as PluginManifest
      for (const entry of host.registrations?.contributions ?? []) {
        const entryKind = entry.kind as ExtensionKind
        if (!EXTENSION_METHODS[entryKind] || (kind && kind !== entryKind)) continue
        const declared = manifest.contributes?.[entryKind]?.find((item) => item.id === entry.id)
        if (declared) result.push({ plugin: record.id, kind: entryKind, id: entry.id, title: declared.title })
      }
    }
    return result
  }

  async selectedExtension(kind: ExtensionKind) {
    const selected = (await this.settings.get()).pluginExtensions?.[kind]
    if (!selected) return undefined
    // Never fall back silently when the chosen implementation was disabled or removed.
    const available = (await this.extensionCatalog(kind)).find((entry) => entry.plugin === selected.plugin && entry.id === selected.id)
    if (!available) throw new BadRequestException(`Selected ${kind} extension is unavailable. Enable its plugin or clear the selection.`)
    return available
  }

  async selectExtension(kind: ExtensionKind, selected: { plugin: string; id: string } | null) {
    if (selected && !(await this.extensionCatalog(kind)).some((entry) => entry.plugin === selected.plugin && entry.id === selected.id)) throw new BadRequestException('Extension is not active.')
    const current = await this.settings.get()
    await this.settings.update({ pluginExtensions: { ...current.pluginExtensions, [kind]: selected } })
    this.events.publish('system', 'plugins_changed', { kind })
    return { kind, selected }
  }

  async invokeSelected<T>(kind: ExtensionKind, method: string, input: Record<string, unknown>): Promise<T | undefined> {
    const selected = await this.selectedExtension(kind)
    return selected ? this.invokeExtension<T>(selected.plugin, kind, selected.id, method, input) : undefined
  }

  async invokeExtension<T = unknown>(plugin: string, kind: ExtensionKind, id: string, method: string, input: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const limit = Math.min(options.timeoutMs ?? Infinity, EXTENSION_TIMEOUT_MS[kind])
    if (!Number.isFinite(limit) || limit <= 0) throw new BadRequestException('Extension timeout must be positive.')
    const deadline = AbortSignal.timeout(limit)
    options = { ...options, signal: AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]) }
    options.signal?.throwIfAborted()
    if (!EXTENSION_METHODS[kind]?.includes(method)) throw new BadRequestException(`Unsupported extension method ${kind}/${method}.`)
    const host = await this.hostFor(plugin, options.signal)
    if (!host.registrations?.contributions.some((entry) => entry.kind === kind && entry.id === id)) throw new BadRequestException(`Extension ${kind}/${id} is not registered by ${plugin}.`)
    this.log(plugin, 'info', `extension ${kind}/${id}.${method}`)
    // the directories of this call (worktree cwd, project root) are usable by the plugin while it runs
    const dirs = [input.cwd, (input.project as { repoPath?: unknown } | undefined)?.repoPath].filter((dir): dir is string => typeof dir === 'string' && path.isAbsolute(dir)).map((dir) => path.resolve(dir))
    const grants = this.delegations.get(plugin) ?? new Map<string, number>()
    this.delegations.set(plugin, grants)
    for (const dir of dirs) grants.set(dir, (grants.get(dir) ?? 0) + 1)
    try {
      return await this.call<T>(plugin, 'extension', id, { kind, method, input }, limit, options.signal)
    } finally {
      for (const dir of dirs) { const left = (grants.get(dir) ?? 1) - 1; if (left > 0) grants.set(dir, left); else grants.delete(dir) }
    }
  }

  /** A directory handed to a running extension call of this plugin (never an arbitrary path). */
  private delegated(plugin: string, dir: unknown): string {
    const resolved = typeof dir === 'string' && path.isAbsolute(dir) ? path.resolve(dir) : undefined
    if (!resolved || !this.delegations.get(plugin)?.has(resolved)) throw new Error('Permission denied: directory was not handed to this extension call.')
    return resolved
  }

  async runCommand(id: string, command: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    await this.ensureBuiltins()
    const record = await this.prisma.plugin.findUnique({ where: { id } })
    const declared = (record?.manifest as unknown as PluginManifest | undefined)?.contributes?.commands ?? []
    if (!declared.some((entry) => entry.id === command)) throw new BadRequestException(`Command "${command}" is not declared by ${id}.`)
    this.log(id, 'info', `command ${command}`)
    return this.call<CommandResult>(id, 'command', command, args)
  }

  async renderView(id: string, view: string, input: Record<string, unknown> = {}): Promise<ViewNode> {
    await this.ensureBuiltins()
    return this.call<ViewNode>(id, 'view', view, input)
  }

  async invokeTool(id: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureBuiltins()
    const record = await this.prisma.plugin.findUnique({ where: { id } })
    const declared = (record?.manifest as unknown as PluginManifest | undefined)?.contributes?.agentTools ?? []
    if (!declared.some((entry) => entry.name === tool)) throw new BadRequestException(`Tool "${tool}" is not declared by ${id}.`)
    this.log(id, 'info', `tool ${tool}`)
    return this.call(id, 'tool', tool, args)
  }

  /**
   * Plugin tools for autonomous agents: tools of active plugins without side effects (tools that
   * change something outside the conversation stay manual). The role parameter is reserved for
   * per-agent assignment.
   */
  async agentTools(_role: string): Promise<AgentTool[]> {
    const catalog = (await this.toolCatalog()).filter((tool) => tool.active && !tool.sideEffects)
    return catalog.map((tool) => ({
      name: `plugin_${tool.plugin}_${tool.name}`.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64),
      description: `[Plugin ${tool.plugin}] ${tool.description.slice(0, 400)}`,
      parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object' },
      execute: async (args) => {
        const value = await this.invokeTool(tool.plugin, tool.name, args)
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        return text.length > 12_000 ? `${text.slice(0, 12_000)}\n… [truncated]` : text
      },
    }))
  }

  /** Agent tools of enabled plugins with their schema (for agents and the MCP/tool registry). */
  async toolCatalog() {
    await this.ensureBuiltins()
    const records = await this.prisma.plugin.findMany({ where: { enabled: true } })
    return records.flatMap((record) =>
      ((record.manifest as unknown as PluginManifest).contributes?.agentTools ?? []).map((tool) => ({
        plugin: record.id,
        name: tool.name,
        qualifiedName: `${record.id}.${tool.name}`,
        description: tool.description,
        inputSchema: tool.inputSchema,
        sideEffects: Boolean(tool.sideEffects),
        active: Boolean(this.hosts.get(record.id)?.registrations?.tools.includes(tool.name)),
      })),
    )
  }

  /**
   * Installable plugins. Today: the plugins shipped with the app plus entries of
   * <builtin>/catalog.json (git sources). A remote marketplace is another source with the same shape.
   */
  async catalog() {
    await this.ensureBuiltins()
    const installed = new Map((await this.prisma.plugin.findMany()).map((record) => [record.id, record]))
    const entries: Array<{ id: string; name: string; version: string; description: string; categories: string[]; source: string; gitUrl?: string; installedVersion?: string; updateAvailable: boolean }> = []
    const dir = builtinDir()
    if (existsSync(dir)) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !existsSync(path.join(dir, entry.name, MANIFEST_FILE))) continue
        const manifest = await this.readManifest(path.join(dir, entry.name)).catch(() => undefined)
        if (!manifest) continue
        const current = installed.get(manifest.id)
        entries.push({ id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description, categories: manifest.categories ?? [], source: 'builtin', installedVersion: current?.version, updateAvailable: Boolean(current && compareVersions(manifest.version, current.version) > 0) })
      }
      const catalogFile = path.join(dir, 'catalog.json')
      if (existsSync(catalogFile)) {
        const list = JSON.parse(await fs.readFile(catalogFile, 'utf8')) as Array<{ id: string; name: string; version: string; description: string; categories?: string[]; gitUrl: string }>
        for (const item of Array.isArray(list) ? list : []) {
          const current = installed.get(item.id)
          entries.push({ ...item, categories: item.categories ?? [], source: 'git', installedVersion: current?.version, updateAvailable: Boolean(current && compareVersions(item.version, current.version) > 0) })
        }
      }
    }
    return { sources: [{ id: 'builtin', title: 'Mitgeliefert' }], entries }
  }

  /** Extra planning context from enabled plugins (short timeout; failures are skipped). */
  async collectContext(goal: string, project?: { id: string; name: string; repoPath: string }): Promise<Array<{ plugin: string; provider: string; text: string }>> {
    // all providers are asked concurrently: the planner waits for the slowest one, not for the sum
    const calls = [...this.hosts].flatMap(([id, host]) =>
      (host.registrations?.contextProviders ?? []).map(async (provider) => {
        const text = await this.call<string | undefined>(id, 'context', provider, { goal, project }, 3000).catch(() => undefined)
        return typeof text === 'string' && text.trim() ? { plugin: id, provider, text: text.slice(0, 4000) } : undefined
      }),
    )
    return (await Promise.all(calls)).filter((entry): entry is { plugin: string; provider: string; text: string } => Boolean(entry))
  }

  /** Enabled plugins' agent tools (name → plugin) for the tool registry. */
  tools() {
    return [...this.hosts.entries()].flatMap(([plugin, host]) => (host.registrations?.tools ?? []).map((tool) => ({ plugin, tool })))
  }

  private dispatchEvent(type: string, data: Record<string, unknown>) {
    for (const [id, host] of this.hosts) {
      if (!host.registrations?.hooks.includes(type)) continue
      void this.call(id, 'event', type, data, 10_000).catch((error: unknown) => this.log(id, 'warn', `hook ${type}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  // ---------------------------------------------------------------------------
  // Requests from a plugin (the permission boundary)
  // ---------------------------------------------------------------------------

  private onHostMessage(id: string, host: Host, message: Record<string, unknown>) {
    if (message.type === 'result') {
      const waiter = host.pending.get(Number(message.id))
      if (!waiter) return
      host.pending.delete(Number(message.id))
      clearTimeout(waiter.timer)
      if (message.ok) waiter.resolve(message.value)
      else waiter.reject(new BadRequestException(String(message.error)))
      return
    }
    if (message.type === 'log') return this.log(id, String(message.level), String(message.message))
    if (message.type === 'metrics') {
      host.metrics = { rssMb: Number(message.rssMb), heapMb: Number(message.heapMb), cpuMs: Number(message.cpuMs), at: new Date().toISOString() }
      if (host.metrics.rssMb > MEMORY_LIMIT_MB * 2) {
        this.log(id, 'error', `memory ${host.metrics.rssMb} MB exceeds the limit; restarting`)
        host.child.kill()
      }
      return
    }
    if (message.type === 'request') {
      void this.handleRequest(id, String(message.method), (message.params ?? {}) as Record<string, unknown>, host.lifetime.signal).then(
        (value) => host.child.connected && host.child.send({ type: 'response', id: message.id, ok: true, value }),
        (error: unknown) => host.child.connected && host.child.send({ type: 'response', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
      )
    }
  }

  private async handleRequest(id: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const record = await this.prisma.plugin.findUniqueOrThrow({ where: { id } })
    const granted = record.granted as PluginPermissions
    const deny = (what: string): never => {
      this.log(id, 'warn', `denied: ${what}`)
      throw new Error(`Permission denied: ${what} (not granted to this plugin).`)
    }
    switch (method) {
      case 'project':
        return (await this.currentProject()) ?? undefined
      case 'settings.get': {
        const key = String(params.key)
        const declared = ((record.manifest as unknown as PluginManifest).contributes?.settings ?? []).find((setting) => setting.key === key)
        return jsonObject(record.settings)[key] ?? declared?.default
      }
      case 'secrets.get': {
        const name = String(params.name)
        if (!(granted.secrets ?? []).includes(name)) deny(`secret ${name}`)
        // without the desktop shell (standalone runtime) there is no vault: the secret is simply not set
        if (!shellAvailable()) return undefined
        return shellRequest<string | null>('secret:get', { scope: `plugin:${id}`, name }).then((value) => value ?? undefined)
      }
      case 'storage.get':
        return jsonObject(record.storage)[String(params.key)]
      case 'storage.set':
      case 'storage.delete': {
        await this.locks.run(`storage:${id}`, async () => {
          const current = jsonObject((await this.prisma.plugin.findUniqueOrThrow({ where: { id } })).storage)
          if (method === 'storage.set') current[String(params.key)] = params.value
          else delete current[String(params.key)]
          if (Buffer.byteLength(JSON.stringify(current)) > 2 * 1024 * 1024) throw new Error('Plugin storage is limited to 2 MB.')
          await this.prisma.plugin.update({ where: { id }, data: { storage: asJson(current) } })
        })
        return undefined
      }
      case 'http.fetch': {
        const url = new URL(String(params.url))
        if (!['https:', 'http:'].includes(url.protocol)) deny(`protocol ${url.protocol}`)
        if (!hostAllowed(url.host, granted.network) && !settingHosts(record).includes(url.host.toLowerCase())) deny(`network ${url.host}`)
        const init = (params.init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }
        const started = Date.now()
        const response = await fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(Math.min(init.timeoutMs ?? 20_000, 60_000)), ...(signal ? [signal] : [])]) })
        const body = await response.text()
        this.log(id, 'debug', `http ${init.method ?? 'GET'} ${url.host}${url.pathname} → ${response.status}`)
        return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: body.slice(0, 5 * 1024 * 1024), durationMs: Date.now() - started }
      }
      case 'fs.read':
      case 'fs.list':
      case 'fs.write': {
        const level = granted.fs ?? 'none'
        if (level === 'none' || (method === 'fs.write' && level !== 'project-write')) deny(`files (${method})`)
        const root = params.root === undefined || params.root === null ? ((await this.handleRequest(id, 'project', {})) as { repoPath: string } | undefined)?.repoPath : this.delegated(id, params.root)
        if (!root) throw new Error('No project is open.')
        const target = resolveInside(root, String(params.path ?? params.dir ?? '') || '.')
        if (target.relative.split('/')[0] === '.git') deny('the .git directory')
        if (method === 'fs.read') return fs.readFile(target.absolute, 'utf8')
        if (method === 'fs.write') {
          await fs.mkdir(path.dirname(target.absolute), { recursive: true })
          await fs.writeFile(target.absolute, String(params.content ?? ''), 'utf8')
          this.log(id, 'info', `wrote ${target.relative}`)
          return undefined
        }
        const entries = await fs.readdir(target.absolute, { withFileTypes: true })
        return entries.filter((entry) => entry.name !== '.git').map((entry) => ({ name: entry.name, path: target.relative ? `${target.relative}/${entry.name}` : entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
      }
      case 'process.run': {
        const executable = String(params.executable)
        if (!(granted.processes ?? []).includes(executable)) deny(`process ${executable}`)
        const binary = resolveExecutable(executable)
        if (!binary) throw new Error(`${executable} is not installed (not found on PATH).`)
        const options = (params.options ?? {}) as { cwd?: string; timeoutMs?: number; input?: string }
        const project = options.cwd === 'project' ? ((await this.handleRequest(id, 'project', {})) as { repoPath: string } | undefined) : options.cwd ? { repoPath: this.delegated(id, options.cwd) } : undefined
        const args = Array.isArray(params.args) ? params.args.map(String) : []
        const result = await runProcess(binary, args, { cwd: project?.repoPath ?? os.homedir(), env: sanitizedEnv(), timeoutMs: Math.min(options.timeoutMs ?? 60_000, 10 * 60_000), signal, cleanupChildren: true, input: options.input, maxOutputBytes: 4 * 1024 * 1024 })
        if (result.aborted || result.timedOut || result.spawnError) throw new Error(result.aborted ? 'Plugin process cancelled.' : result.timedOut ? 'Plugin process timed out.' : result.spawnError)
        this.log(id, 'info', `process ${executable} ${args.slice(0, 4).join(' ')} → ${result.exitCode}`)
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs }
      }
      default:
        throw new Error(`Unknown request ${method}.`)
    }
  }
}
