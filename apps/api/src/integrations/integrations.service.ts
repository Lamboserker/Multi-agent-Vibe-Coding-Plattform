import { BadRequestException, ConflictException, Injectable, NotFoundException, OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { INTEGRATION_CATALOG_VERSION, MCP_PRESETS, SKILL_CATALOG, WORKFLOW_BUNDLES, type GrantGroup, type IntegrationCatalog, type McpPreset, type SetupJob, type SetupJobDetails, type SetupPhase } from '@multi-ai-coder/shared'
import { PrismaService } from '../common/prisma.service.js'
import { asJson } from '../common/json.js'
import { McpService, type McpServerInput, type McpToolInfo, type ToolPolicy } from '../mcp/mcp.service.js'
import { SkillsService, AGENT_ROLES } from '../skills/skills.service.js'
import { EventBusService } from '../runtime/event-bus.service.js'
import { runtimeConfig } from '../runtime/runtime-config.js'
import { shellAvailable, shellRequest } from '../runtime/shell-bridge.js'
import { IntegrationRuntime } from './integration-runtime.js'
import { KeyedMutex } from '../common/locks.js'

export interface SetupInput {
  values?: Record<string, string>
  install?: string[]
  installServer?: boolean
  installAddon?: boolean
  reuseServerId?: string
}
interface StoredConfig { values: Record<string, string>; install: string[]; installServer: boolean; installAddon: boolean; reuseServerId?: string; toolSnapshot?: Record<string, string> }
const interrupted: SetupPhase[] = ['checking', 'installing', 'configuring', 'testing']
const terminal = new Set(['ready', 'failed', 'cancelled'])
const toolSignature = (tool: McpToolInfo) => createHash('sha256').update(JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations })).digest('hex')
class SetupFailure extends Error {}

export function toolGroup(presetId: string, tool: McpToolInfo): GrantGroup {
  if (tool.annotations?.destructiveHint && !tool.annotations.readOnlyHint) return 'write'
  const name = tool.name.toLowerCase()
  if (/execute|evaluate|eval|script|terminal|command|python|shell/.test(name)) return 'code'
  if (presetId === 'higgsfield' && /generat|create|render|submit|upscale|variation/.test(name)) return 'generate'
  if (tool.annotations?.readOnlyHint) return 'read'
  if (presetId === 'windows-mcp') return 'desktop'
  if (presetId === 'playwright' || presetId === 'chrome-devtools') return 'browser'
  return 'write'
}

/** Setup jobs contain public parameters only; credential values are never stored in the database. */
@Injectable()
export class IntegrationsService implements OnModuleInit, OnApplicationShutdown {
  readonly runtime = new IntegrationRuntime(runtimeConfig().dataDir)
  private readonly running = new Map<string, AbortController>()
  private readonly starting = new Map<string, Promise<SetupJobDetails>>()
  private readonly mutations = new KeyedMutex()

  constructor(private readonly prisma: PrismaService, private readonly mcp: McpService, private readonly skills: SkillsService, private readonly events: EventBusService) {}

  async onModuleInit() {
    await this.prisma.integrationSetupJob.updateMany({ where: { phase: { in: interrupted } }, data: { phase: 'failed', error: 'Die App wurde während der Einrichtung beendet. Einrichtung erneut versuchen.', message: 'Einrichtung unterbrochen.' } })
  }
  onApplicationShutdown() { for (const controller of this.running.values()) controller.abort() }

  private preset(id: string) {
    const preset = MCP_PRESETS.find((entry) => entry.id === id)
    if (!preset) throw new NotFoundException('Integration nicht gefunden.')
    return preset
  }
  private bundle(id: string) {
    const bundle = WORKFLOW_BUNDLES.find((entry) => entry.id === id)
    if (!bundle) throw new NotFoundException('Workflow-Paket nicht gefunden.')
    return bundle
  }
  private describe(record: { id: string; presetId: string; phase: string; serverId: string | null; message: string; error: string | null; createdAt: Date; updatedAt: Date }): SetupJob {
    return { id: record.id, presetId: record.presetId, phase: record.phase as SetupPhase, serverId: record.serverId, message: record.message, error: record.error, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() }
  }
  private async record(id: string) {
    const job = await this.prisma.integrationSetupJob.findUnique({ where: { id } })
    if (!job) throw new NotFoundException('Einrichtungsauftrag nicht gefunden.')
    return job
  }
  private async phase(id: string, phase: SetupPhase, message: string, extra: { error?: string | null; serverId?: string } = {}) {
    await this.prisma.integrationSetupJob.updateMany({ where: { id, phase: { not: 'cancelled' } }, data: { phase, message, error: null, ...extra } })
    this.events.publish('system', 'integration_setup_changed', { id, phase })
  }

  async catalog(): Promise<IntegrationCatalog> {
    const [installations, servers, skills, bundles, jobs] = await Promise.all([
      this.prisma.integrationInstallation.findMany(), this.mcp.list(), this.skills.list(), this.prisma.integrationBundle.findMany(),
      this.prisma.integrationSetupJob.findMany({ orderBy: { createdAt: 'desc' }, take: 60 }),
    ])
    return {
      version: INTEGRATION_CATALOG_VERSION, platform: this.runtime.platform,
      presets: MCP_PRESETS.map((preset) => {
        const installation = installations.find((entry) => entry.presetId === preset.id)
        const server = servers.find((entry) => entry.id === installation?.serverId)
        return { ...preset, serverId: server?.id, status: server?.status }
      }),
      skills: SKILL_CATALOG.map((skill) => ({ ...skill, enabled: skills.find((entry) => entry.key === `builtin:${skill.id}`)?.enabled ?? false })),
      bundles: WORKFLOW_BUNDLES.map((bundle) => ({ ...bundle, active: bundles.some((entry) => entry.id === bundle.id), selectedOptional: (bundles.find((entry) => entry.id === bundle.id)?.optional as string[] | undefined) ?? [] })), jobs: jobs.map((entry) => this.describe(entry)),
    }
  }

  async check(id: string) {
    const preset = this.preset(id)
    const supported = preset.platforms.includes(this.runtime.platform)
    const checks = await Promise.all(preset.prerequisites.map((entry) => this.runtime.check(entry)))
    return { supported, platform: this.runtime.platform, checks, valid: supported && checks.every((entry) => entry.available) }
  }

  private async values(preset: McpPreset, values: Record<string, string> = {}, skipRequired = false) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new BadRequestException('Ungültige Einrichtungsparameter.')
    const known = new Map(preset.fields.map((field) => [field.key, field]))
    for (const [key, value] of Object.entries(values)) {
      const field = known.get(key)
      if (!field || typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) throw new BadRequestException('Unbekannter oder ungültiger Einrichtungsparameter.')
    }
    const merged = Object.fromEntries(preset.fields.filter((field) => field.defaultValue).map((field) => [field.key, field.defaultValue!]))
    Object.assign(merged, values)
    for (const field of preset.fields) {
      const value = merged[field.key]?.trim()
      if (!skipRequired && field.type !== 'secret' && field.required && !value) throw new BadRequestException(`${field.label} fehlt.`)
      if (!value) continue
      if (field.type === 'port' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new BadRequestException(`${field.label} muss zwischen 1 und 65535 liegen.`)
      if (field.type === 'directory') {
        if (!path.isAbsolute(value) || !(await fs.stat(value).catch(() => undefined))?.isDirectory()) throw new BadRequestException(`${field.label} muss ein vorhandenes absolutes Verzeichnis sein.`)
        if (field.key === 'repository' && !(await fs.stat(path.join(value, '.git')).catch(() => undefined))) throw new BadRequestException('Das gewählte Verzeichnis ist kein Git-Arbeitsverzeichnis.')
      }
      if (field.type === 'url') {
        let url: URL
        try { url = new URL(value) } catch { throw new BadRequestException(`${field.label} ist keine gültige URL.`) }
        const localService = field.target === 'env' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        if ((!localService && url.protocol !== 'https:') || url.username || url.password || url.hash || [...url.searchParams.keys()].some((key) => /token|secret|password|key/i.test(key))) throw new BadRequestException('Endpunkte benötigen HTTPS ohne eingebettete Zugangsdaten; lokale Datendienste dürfen HTTP verwenden.')
      }
    }
    return merged
  }

  start(id: string, input: SetupInput = {}): Promise<SetupJobDetails> {
    const pending = this.starting.get(id)
    if (pending) return pending
    const promise = this.startOnce(id, input).finally(() => this.starting.delete(id))
    this.starting.set(id, promise)
    return promise
  }

  private async startOnce(id: string, input: SetupInput) {
    const preset = this.preset(id)
    if (!preset.platforms.includes(this.runtime.platform)) throw new BadRequestException('Diese Integration unterstützt das aktuelle Betriebssystem nicht.')
    const previous = await this.prisma.integrationSetupJob.findFirst({ where: { presetId: id }, orderBy: { createdAt: 'desc' } })
    if (previous && !terminal.has(previous.phase)) return this.job(previous.id)
    if (previous?.phase === 'ready' && previous.serverId && await this.prisma.mcpServer.findUnique({ where: { id: previous.serverId } })) throw new ConflictException('Diese Integration ist eingerichtet. Für eine weitere Verbindung den MCP-Manager verwenden.')
    const values = await this.values(preset, input.values, Boolean(input.reuseServerId))
    const install = input.install ?? []
    if (!Array.isArray(install) || install.some((entry) => !preset.prerequisites.includes(entry))) throw new BadRequestException('Unbekannter Installationsschritt.')
    if (input.installAddon && preset.id !== 'blender') throw new BadRequestException('Diese Integration benötigt kein unterstütztes Add-on.')
    if (input.reuseServerId) {
      const server = await this.mcp.get(input.reuseServerId)
      if (server.transport !== preset.transport) throw new BadRequestException('Die vorhandene Verbindung hat einen anderen Transport.')
      if (await this.prisma.integrationInstallation.findUnique({ where: { serverId: server.id } })) throw new ConflictException('Die Verbindung gehört bereits zu einer Integration.')
    }
    const config: StoredConfig = { values: Object.fromEntries(Object.entries(values).filter(([key]) => preset.fields.find((field) => field.key === key)?.type !== 'secret')), install, installServer: input.installServer ?? true, installAddon: input.installAddon ?? false, ...(input.reuseServerId ? { reuseServerId: input.reuseServerId } : {}) }
    const job = await this.prisma.integrationSetupJob.create({ data: { presetId: id, phase: 'checking', message: 'Voraussetzungen werden geprüft.', config: asJson(config) } })
    this.run(job.id, values)
    return this.job(job.id)
  }

  private run(id: string, values: Record<string, string>) {
    if (this.running.has(id)) return
    const controller = new AbortController()
    this.running.set(id, controller)
    void this.execute(id, values, controller.signal).catch(async (error: unknown) => {
      if (!controller.signal.aborted) await this.phase(id, 'failed', 'Einrichtung fehlgeschlagen.', { error: error instanceof SetupFailure ? error.message : 'Einrichtung fehlgeschlagen. Voraussetzungen, Anmeldung und Verbindung im MCP-Manager prüfen und erneut versuchen.' })
    }).finally(() => this.running.delete(id))
  }

  private async execute(id: string, values: Record<string, string>, signal: AbortSignal) {
    const job = await this.record(id)
    const preset = this.preset(job.presetId)
    const config = job.config as unknown as StoredConfig
    const ensureActive = () => { if (signal.aborted) throw new Error('Einrichtung abgebrochen.') }
    const installed = await this.prisma.integrationInstallation.findUnique({ where: { presetId: preset.id } })
    let server: Awaited<ReturnType<McpService['create']>> | undefined = installed ? await this.mcp.get(installed.serverId).catch(() => undefined) : undefined
    if (config.reuseServerId && !server) server = await this.mcp.get(config.reuseServerId)
    if (!server) {
      for (const requirement of preset.prerequisites) {
        ensureActive()
        const check = await this.runtime.check(requirement)
        if (!check.available) {
          if (!config.install.includes(requirement)) throw new SetupFailure(`${check.label} fehlt. Den angebotenen Installationsschritt auswählen oder das Programm manuell installieren.`)
          await this.phase(id, 'installing', `${check.label} wird installiert.`)
          await this.runtime.installPrerequisite(requirement, signal)
          if (!(await this.runtime.check(requirement)).available) throw new Error('Programm nach Installation nicht verfügbar.')
        }
      }
      ensureActive()
      if (preset.runtime && config.installServer) {
        await this.phase(id, 'installing', 'Festgeschriebenes Serverpaket wird installiert.')
        await this.runtime.installPackage(preset, signal)
      }
      if (config.installAddon) {
        await this.phase(id, 'installing', 'Blender-Add-on wird installiert; anschließend in Blender aktivieren.')
        await this.runtime.installAddon(preset, signal)
      }
      ensureActive()
      await this.phase(id, 'configuring', 'MCP-Verbindung wird angelegt.')
      const input = await this.serverInput(preset, { ...config.values, ...values })
      ensureActive()
      server = await this.mcp.create(input)
    }
    if (!server) throw new Error('Verbindung fehlt.')
    await this.prisma.integrationInstallation.upsert({ where: { presetId: preset.id }, create: { presetId: preset.id, catalogVersion: preset.version, packageVersion: preset.packageVersion, serverId: server.id, owned: !config.reuseServerId }, update: { serverId: server.id, catalogVersion: preset.version, packageVersion: preset.packageVersion } })
    await this.prisma.integrationSetupJob.update({ where: { id }, data: { serverId: server.id } })
    ensureActive()
    await this.phase(id, 'configuring', 'Verbindung konfiguriert.', { serverId: server.id })
    ensureActive()
    await this.credentials(preset, server.id, values)
    ensureActive()
    if (!server.enabled) await this.mcp.update(server.id, { enabled: true })
    if (preset.auth === 'oauth') {
      await this.phase(id, 'authentication', 'Anmelden und danach „Verbindung prüfen“ wählen.')
      return
    }
    if (preset.auth === 'secret') {
      if (!shellAvailable()) throw new Error('Zugangsdaten benötigen den Desktop-Tresor.')
      const names = await shellRequest<{ names: string[] }>('secret:names', { scope: `mcp:${server.id}` })
      if (preset.fields.some((field) => field.type === 'secret' && field.required && !names.names.includes(field.key))) {
        await this.phase(id, 'authentication', 'Notwendige Zugangsdaten ergänzen und Verbindung prüfen.')
        return
      }
    }
    await this.test(id, signal)
  }

  private async serverInput(preset: McpPreset, values: Record<string, string>): Promise<McpServerInput> {
    const input: McpServerInput = { name: `catalog-${preset.id}`, transport: preset.transport, enabled: true, defaultPolicy: 'confirm', agents: [], env: { ...preset.env } }
    if (preset.transport === 'stdio') {
      const launch = await this.runtime.launch(preset)
      Object.assign(input, launch, { args: [...launch.args, ...preset.args.map((arg) => arg.replace(/\{([\w-]+)\}/g, (_match, key: string) => values[key] ?? ''))] })
      if (preset.id === 'playwright' || preset.id === 'chrome-devtools') {
        const chrome = (await this.runtime.check('chrome')).path
        if (chrome) input.args!.push('--executable-path', chrome)
      }
      if (preset.prerequisites.includes('git')) {
        const git = (await this.runtime.check('git')).path
        if (git) input.env = { ...input.env, PATH: [path.dirname(git), process.env.PATH ?? process.env.Path ?? ''].join(path.delimiter) }
      }
    } else {
      input.url = preset.fields.find((field) => field.target === 'url') ? values[preset.fields.find((field) => field.target === 'url')!.key] : preset.url
      if (preset.auth === 'oauth') input.oauth = { enabled: true }
    }
    input.secretEnv = preset.fields.filter((field) => field.type === 'secret' && field.target === 'env' && (field.required || values[field.key])).map((field) => field.key)
    input.secretHeaders = preset.fields.filter((field) => field.type === 'secret' && field.target === 'header').map((field) => ({ header: 'Authorization', secret: field.key, prefix: 'Bearer ' }))
    for (const field of preset.fields.filter((entry) => entry.type !== 'secret' && entry.target === 'env')) input.env![field.key] = values[field.key] ?? ''
    return input
  }

  private async credentials(preset: McpPreset, serverId: string, values: Record<string, string>) {
    const provided: string[] = []
    for (const field of preset.fields.filter((entry) => entry.type === 'secret')) {
      const value = values[field.key]
      if (!value) continue
      if (!shellAvailable()) throw new BadRequestException('Zugangsdaten benötigen den verschlüsselten Desktop-Tresor.')
      await shellRequest('secret:set', { scope: `mcp:${serverId}`, name: field.key, value })
      if (field.target === 'env') provided.push(field.key)
    }
    if (provided.length) {
      const server = await this.mcp.get(serverId)
      if (provided.some((name) => !server.secretEnv.includes(name))) await this.mcp.update(serverId, { secretEnv: [...new Set([...server.secretEnv, ...provided])] })
    }
  }

  async job(id: string): Promise<SetupJobDetails> {
    const record = await this.record(id)
    const server = record.serverId ? await this.mcp.get(record.serverId).catch(() => undefined) : undefined
    return { ...this.describe(record), values: (record.config as unknown as StoredConfig).values, roles: server?.agents ?? [], tools: (server?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, policy: tool.policy, group: toolGroup(record.presetId, tool) })) }
  }

  async login(id: string) {
    const job = await this.record(id)
    if (job.phase !== 'authentication' || !job.serverId || this.preset(job.presetId).auth !== 'oauth') throw new BadRequestException('Dieser Auftrag wartet nicht auf eine OAuth-Anmeldung.')
    return this.mcp.loginOAuth(job.serverId)
  }

  resume(id: string, input: SetupInput = {}) { return this.mutations.run(id, () => this.resumeOnce(id, input)) }

  private async resumeOnce(id: string, input: SetupInput) {
    const job = await this.record(id)
    if (!['failed', 'authentication'].includes(job.phase)) throw new ConflictException('Dieser Auftrag kann derzeit nicht fortgesetzt werden.')
    if (this.running.has(id)) return this.job(id)
    const preset = this.preset(job.presetId)
    const config = job.config as unknown as StoredConfig
    const values = await this.values(preset, { ...config.values, ...input.values }, Boolean(config.reuseServerId))
    if (input.installAddon && preset.id !== 'blender') throw new BadRequestException('Diese Integration benötigt kein unterstütztes Add-on.')
    if (job.serverId) {
      await this.credentials(preset, job.serverId, values)
      await this.phase(id, 'testing', 'Verbindung und Werkzeugliste werden geprüft.')
      const controller = new AbortController()
      this.running.set(id, controller)
      void (async () => {
        if (input.installAddon) {
          await this.phase(id, 'installing', 'Blender-Add-on wird installiert; anschließend in Blender aktivieren.')
          await this.runtime.installAddon(preset, controller.signal)
        }
        await this.test(id, controller.signal)
      })().catch(async () => {
        if (!controller.signal.aborted) await this.phase(id, 'failed', 'Verbindungstest fehlgeschlagen.', { error: 'Verbindung nicht bereit. Bei Blender das Add-on aktivieren und dessen Server starten; ansonsten Anmeldung und Voraussetzungen im MCP-Manager prüfen.' })
      }).finally(() => this.running.delete(id))
    } else {
      const install = input.install ?? config.install
      if (!Array.isArray(install) || install.some((entry) => !preset.prerequisites.includes(entry))) throw new BadRequestException('Unbekannter Installationsschritt.')
      const next = { ...config, values: Object.fromEntries(Object.entries(values).filter(([key]) => preset.fields.find((field) => field.key === key)?.type !== 'secret')), install, installServer: input.installServer ?? config.installServer, installAddon: input.installAddon ?? config.installAddon }
      await this.prisma.integrationSetupJob.update({ where: { id }, data: { config: asJson(next), phase: 'checking', error: null } })
      this.run(id, values)
    }
    return this.job(id)
  }

  private async test(id: string, signal: AbortSignal) {
    const job = await this.record(id)
    if (signal.aborted || job.phase === 'cancelled' || !job.serverId) return
    await this.phase(id, 'testing', 'Verbindung und Werkzeugliste werden geprüft.')
    const tools = await this.mcp.tools(job.serverId, true)
    if (signal.aborted) return
    const health = await this.mcp.health(job.serverId)
    if (!health.ok) throw new Error('MCP-Verbindung antwortet nicht.')
    const latest = await this.record(id)
    if (signal.aborted || latest.phase === 'cancelled') return
    await this.prisma.integrationSetupJob.update({ where: { id }, data: { config: asJson({ ...(latest.config as unknown as StoredConfig), toolSnapshot: Object.fromEntries(tools.map((tool) => [tool.name, toolSignature(tool)])) }) } })
    await this.phase(id, 'approval', 'Verbindung bereit. Konkrete Werkzeuge und Agentenrollen freigeben.')
  }

  approve(id: string, roles: string[], allow: string[]) { return this.mutations.run(id, () => this.approveOnce(id, roles, allow)) }

  private async approveOnce(id: string, roles: string[], allow: string[]) {
    const job = await this.record(id)
    if (job.phase !== 'approval' || !job.serverId) throw new ConflictException('Zuerst die Verbindung erfolgreich prüfen.')
    if (!Array.isArray(roles) || roles.some((role) => !(AGENT_ROLES as readonly string[]).includes(role))) throw new BadRequestException('Ungültige Agentenrolle.')
    const server = await this.mcp.get(job.serverId)
    const tools = await this.mcp.tools(server.id, true)
    const snapshot = (job.config as unknown as StoredConfig).toolSnapshot ?? {}
    if (!Array.isArray(allow) || allow.some((name) => !tools.some((tool) => tool.name === name && snapshot[name] === toolSignature(tool)))) {
      await this.phase(id, 'failed', 'Werkzeugliste geändert.', { error: 'Die Werkzeugliste hat sich geändert. Verbindung erneut prüfen und Freigaben kontrollieren.' })
      throw new BadRequestException('Die Werkzeugliste hat sich geändert. Freigaben erneut prüfen.')
    }
    // Materialize existing permissions before tightening the default for future tools.
    const policies: Record<string, ToolPolicy> = { ...Object.fromEntries((server.tools ?? []).filter((tool) => tool.policy !== 'confirm').map((tool) => [tool.name, tool.policy])), ...server.toolPolicies }
    for (const name of allow) policies[name] = 'allow'
    await this.mcp.update(server.id, { defaultPolicy: 'confirm', toolPolicies: policies, agents: [...new Set([...server.agents, ...roles])] })
    await this.phase(id, 'ready', 'Integration eingerichtet und ausgewählte Werkzeuge freigegeben.')
    return this.job(id)
  }

  cancel(id: string) { return this.mutations.run(id, () => this.cancelOnce(id)) }

  private async cancelOnce(id: string) {
    const job = await this.record(id)
    if (terminal.has(job.phase)) return this.job(id)
    this.running.get(id)?.abort()
    await this.prisma.integrationSetupJob.update({ where: { id }, data: { phase: 'cancelled', message: 'Einrichtung abgebrochen. Bereits installierte Programme und Verbindungen bleiben erhalten.', error: null } })
    if (job.serverId) await this.mcp.cancelOAuthLogin(job.serverId)
    this.events.publish('system', 'integration_setup_changed', { id, phase: 'cancelled' })
    return this.job(id)
  }

  async activateSkill(id: string, enabled: boolean) {
    if (!SKILL_CATALOG.some((entry) => entry.id === id)) throw new NotFoundException('Katalog-Skill nicht gefunden.')
    return this.skills.updateState(`builtin:${id}`, { enabled })
  }

  async activateBundle(id: string, optional: string[] = []) {
    const bundle = this.bundle(id)
    if (!Array.isArray(optional) || optional.some((entry) => !bundle.optional.includes(entry))) throw new BadRequestException('Unbekannte optionale Integration.')
    const members = [...bundle.required, ...new Set(optional)]
    for (const presetId of members) {
      const installation = await this.prisma.integrationInstallation.findUnique({ where: { presetId } })
      const job = await this.prisma.integrationSetupJob.findFirst({ where: { presetId }, orderBy: { createdAt: 'desc' } })
      if (!installation || job?.phase !== 'ready' || !(await this.mcp.get(installation.serverId).catch(() => undefined))?.enabled) throw new BadRequestException(`Zuerst ${this.preset(presetId).title} einrichten und freigeben.`)
    }
    const skills = bundle.skills.filter((skillId) => {
      const skill = SKILL_CATALOG.find((entry) => entry.id === skillId)!
      return skill.tools.every((tool) => !tool.startsWith('mcp_') || members.some((presetId) => tool.startsWith(`mcp_catalog-${presetId}_`)) || members.some((presetId) => tool.startsWith(`mcp_${presetId}_`)))
    })
    for (const skillId of skills) await this.skills.updateState(`builtin:${skillId}`, { enabled: true })
    await this.prisma.integrationBundle.upsert({ where: { id }, create: { id, version: bundle.version, optional: asJson(optional), members: asJson([...members, ...skills.map((skillId) => `skill:${skillId}`)]) }, update: { version: bundle.version, optional: asJson(optional), members: asJson([...members, ...skills.map((skillId) => `skill:${skillId}`)]) } })
    this.events.publish('system', 'integrations_changed', { bundleId: id })
    return { ok: true, skills, members }
  }

  async detachBundle(id: string) {
    this.bundle(id)
    await this.prisma.integrationBundle.deleteMany({ where: { id } })
    this.events.publish('system', 'integrations_changed', { bundleId: id })
    return { ok: true, message: 'Paketzuordnung entfernt. Server, Skills und Freigaben bleiben erhalten und können einzeln verwaltet werden.' }
  }
}
