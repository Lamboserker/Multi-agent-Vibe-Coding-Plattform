import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import type { McpServer as McpServerRecord } from '@prisma/client'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveExecutable, type AgentTool } from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { asJson, jsonObject } from '../common/json.js'
import { EventBusService } from '../runtime/event-bus.service.js'
import { shellAvailable, shellRequest } from '../runtime/shell-bridge.js'
import { AGENT_ROLES, type AgentRole } from '../skills/skills.service.js'
import { McpOAuthProvider } from './mcp-oauth.js'
import { MAX_MCP_RESULT_BYTES, richMcpContent, READ_RESULT_DESCRIPTION, READ_RESULT_SCHEMA, ResultPages } from './mcp-results.js'

export type ToolPolicy = 'allow' | 'confirm' | 'off'

export interface McpToolInfo {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string }
}

export interface McpServerInput {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  secretEnv?: string[]
  cwd?: string
  url?: string
  headers?: Record<string, string>
  secretHeaders?: Array<{ header: string; secret: string; prefix?: string }>
  oauth?: { enabled?: boolean; clientId?: string; scope?: string }
  enabled?: boolean
  timeoutMs?: number
  toolPolicies?: Record<string, ToolPolicy>
  defaultPolicy?: ToolPolicy
  agents?: string[]
}

interface Connection {
  client: Client
  transport: Transport
  kind: 'stdio' | 'streamable-http' | 'sse'
  connectedAt: number
  lastUsed: number
  closing: boolean
}

const NAME = /^[A-Za-z0-9][\w.-]{0,47}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
const SECRET_NAME = /^[\w.-]{1,120}$/
const IDLE_MS = 10 * 60_000
const HEALTH_INTERVAL_MS = 60_000
const AGENT_RESULT_CHARS = 12_000
const MANUAL_RESULT_CHARS = 100_000
const MAX_AGENT_TOOLS = 24

/** The SDK is loaded on first use (keeps it off the runtime's startup path). */
let sdkPromise: Promise<{
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client
  SSEClientTransport: typeof import('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport
  StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport
  getDefaultEnvironment: typeof import('@modelcontextprotocol/sdk/client/stdio.js').getDefaultEnvironment
  StreamableHTTPClientTransport: typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport
}> | undefined
function sdk() {
  sdkPromise ??= Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]).then(([client, sse, stdio, http]) => ({ Client: client.Client, SSEClientTransport: sse.SSEClientTransport, StdioClientTransport: stdio.StdioClientTransport, getDefaultEnvironment: stdio.getDefaultEnvironment, StreamableHTTPClientTransport: http.StreamableHTTPClientTransport }))
  return sdkPromise
}

/** Compact JSON schema for model prompts: no $schema/examples/titles, short descriptions, bounded depth. */
export function compactSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map((item) => compactSchema(item, depth + 1))
  if (depth > 6) return { type: (schema as { type?: unknown }).type ?? 'object' }
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (['$schema', 'examples', 'title', '$comment', 'additionalProperties'].includes(key)) continue
    if (key === 'description' && typeof value === 'string') result[key] = value.length > 200 ? `${value.slice(0, 197)}…` : value
    else result[key] = typeof value === 'object' ? compactSchema(value, depth + 1) : value
  }
  return result
}

/** Text of a tool result: text parts joined; images/audio/resources summarized; truncated. */
export function resultText(result: { content?: Array<Record<string, unknown>>; structuredContent?: unknown; isError?: boolean; toolResult?: unknown }, limit: number): string {
  const parts: string[] = []
  for (const item of result.content ?? []) {
    if (item.type === 'text') parts.push(String(item.text ?? ''))
    else if (item.type === 'image' || item.type === 'audio') parts.push(`[${item.type} ${String(item.mimeType ?? '')}, ${Math.round((String(item.data ?? '').length * 3) / 4 / 1024)} KB]`)
    else if (item.type === 'resource') {
      const resource = (item.resource ?? {}) as { uri?: string; text?: string }
      parts.push(resource.text ? `[resource ${resource.uri}]\n${resource.text}` : `[resource ${resource.uri}]`)
    } else if (item.type === 'resource_link') parts.push(`[link ${String(item.uri ?? '')}${item.name ? ` ${String(item.name)}` : ''}]`)
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2))
  if (!parts.length && result.toolResult !== undefined) parts.push(JSON.stringify(result.toolResult, null, 2))
  const text = parts.join('\n')
  return text.length > limit ? `${text.slice(0, limit)}\n… [${text.length - limit} characters truncated]` : text
}

/** Actionable hint for a failed connection (shown in the MCP manager next to the raw error). */
export function diagnoseMcpError(message: string, transport: string, commandFound = true): string | undefined {
  const text = message.toLowerCase()
  if (/oauth login required/.test(text)) return 'Anmeldung fehlt: im MCP-Manager „OAuth anmelden“ ausführen.'
  if (/secret .* is not set|secret for header/.test(text)) return 'Zugangsdaten fehlen: im MCP-Manager unter Secrets hinterlegen.'
  // on Windows a missing command only shows up as "Connection closed"
  if (transport === 'stdio' && (!commandFound || /enoent|not recognized|not found/.test(text))) return 'Befehl nicht gefunden: Pfad prüfen bzw. Programm installieren (z. B. Node/npx, uvx, Python) und die App neu starten.'
  if (/eacces|eperm|permission denied/.test(text)) return 'Keine Berechtigung, den Befehl auszuführen oder das Verzeichnis zu öffnen.'
  if (transport === 'stdio' && /connection closed|exited|closed/.test(text)) return 'Der Serverprozess hat sich beendet: Protokoll (stderr) prüfen, häufig fehlen Argumente oder Umgebungsvariablen.'
  if (/econnrefused|fetch failed|enotfound|getaddrinfo|socket hang up|econnreset/.test(text)) return 'Server nicht erreichbar: URL, Port und ob der Server läuft prüfen (Proxy/Firewall).'
  if (/\b401\b|unauthori[sz]ed|invalid_token|invalid_grant/.test(text)) return 'Authentifizierung abgelehnt: Token/Secret prüfen bzw. OAuth neu anmelden.'
  if (/\b403\b|forbidden/.test(text)) return 'Zugriff verweigert: fehlende Rechte/Scopes des Tokens.'
  if (/\b404\b|not found/.test(text)) return 'Endpunkt nicht gefunden: URL-Pfad prüfen (oft /mcp oder /sse).'
  if (/certificate|self.signed|cert_/.test(text)) return 'TLS-Zertifikat ungültig oder nicht vertrauenswürdig.'
  if (/timed? ?out|timeout/.test(text)) return 'Zeitüberschreitung: Server antwortet nicht rechtzeitig (Start dauert zu lange oder Netzwerk); Timeout erhöhen oder Server prüfen.'
  if (/https/.test(text)) return 'Entfernte OAuth-Endpunkte müssen HTTPS verwenden.'
  return undefined
}

/** Policy of a tool: explicit setting, else destructive tools need confirmation, else the server default. */
export function policyFor(server: Pick<McpServerRecord, 'toolPolicies' | 'defaultPolicy'>, tool: McpToolInfo): ToolPolicy {
  const explicit = jsonObject(server.toolPolicies)[tool.name]
  if (explicit === 'allow' || explicit === 'confirm' || explicit === 'off') return explicit
  if (tool.annotations?.destructiveHint && !tool.annotations.readOnlyHint) return 'confirm'
  return (server.defaultPolicy as ToolPolicy) ?? 'confirm'
}

/** Model-facing tool name: mcp_<server>_<tool>, [A-Za-z0-9_-], max. 64 characters. */
export function agentToolName(server: string, tool: string) {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, '_')
  return `mcp_${clean(server)}_${clean(tool)}`.slice(0, 64)
}

@Injectable()
export class McpService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('MCP')
  private readonly connections = new Map<string, Connection>()
  private readonly connecting = new Map<string, Promise<Connection>>()
  private readonly logs = new Map<string, Array<{ at: string; level: string; message: string }>>()
  private readonly reconnects = new Map<string, number>()
  private readonly oauthProviders = new Map<string, McpOAuthProvider>()
  private timer?: NodeJS.Timeout

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.maintain(), HEALTH_INTERVAL_MS)
    this.timer.unref()
  }

  async onApplicationShutdown() {
    await Promise.all([...this.oauthProviders.values()].map((provider) => provider.cancel()))
    if (this.timer) clearInterval(this.timer)
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }

  private log(id: string, level: string, message: string) {
    const lines = this.logs.get(id) ?? []
    lines.push({ at: new Date().toISOString(), level, message: message.slice(0, 2000) })
    if (lines.length > 300) lines.shift()
    this.logs.set(id, lines)
  }

  private async setStatus(id: string, status: string, lastError: string | null = null) {
    await this.prisma.mcpServer.update({ where: { id }, data: { status, lastError } }).catch(() => undefined)
    this.events.publish('system', 'mcp_status', { id, status, error: lastError })
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  private validate(input: Partial<McpServerInput>, partial: boolean) {
    if (input.oauth && (typeof input.oauth.enabled !== 'boolean' || (input.oauth.clientId !== undefined && typeof input.oauth.clientId !== 'string') || (input.oauth.scope !== undefined && typeof input.oauth.scope !== 'string'))) throw new BadRequestException('Invalid OAuth configuration.')
    if (!partial || input.name !== undefined) if (!input.name || !NAME.test(input.name)) throw new BadRequestException('Name: letters, digits, ".", "_" or "-" (max. 48).')
    if (!partial || input.transport !== undefined) if (!['stdio', 'http'].includes(String(input.transport))) throw new BadRequestException('Transport must be stdio or http.')
    if (input.transport === 'stdio' && !partial && !input.command?.trim()) throw new BadRequestException('A command is required for stdio servers.')
    if (input.command !== undefined && input.command && (input.command.length > 500 || /[\r\n]/.test(input.command))) throw new BadRequestException('Invalid command.')
    if (input.transport === 'http' && !partial && !input.url) throw new BadRequestException('A URL is required for HTTP servers.')
    if (input.url) {
      let url: URL
      try {
        url = new URL(input.url)
      } catch {
        throw new BadRequestException('Invalid URL.')
      }
      if (!['http:', 'https:'].includes(url.protocol)) throw new BadRequestException('The URL must use http or https.')
    }
    if (input.args && (input.args.length > 100 || input.args.some((arg) => typeof arg !== 'string' || arg.length > 2000))) throw new BadRequestException('Invalid arguments.')
    for (const key of Object.keys(input.env ?? {})) if (!ENV_NAME.test(key)) throw new BadRequestException(`Invalid environment variable "${key}".`)
    for (const key of input.secretEnv ?? []) if (!ENV_NAME.test(key)) throw new BadRequestException(`Invalid environment variable "${key}".`)
    for (const key of Object.keys(input.headers ?? {})) if (!HEADER_NAME.test(key)) throw new BadRequestException(`Invalid header "${key}".`)
    for (const entry of input.secretHeaders ?? []) if (!HEADER_NAME.test(entry.header) || !SECRET_NAME.test(entry.secret)) throw new BadRequestException('Invalid secret header.')
    if (input.timeoutMs !== undefined && (input.timeoutMs < 1000 || input.timeoutMs > 30 * 60_000)) throw new BadRequestException('Timeout must be between 1 s and 30 min.')
    for (const policy of [input.defaultPolicy, ...Object.values(input.toolPolicies ?? {})]) if (policy !== undefined && !['allow', 'confirm', 'off'].includes(policy)) throw new BadRequestException('Policy must be allow, confirm or off.')
    if (input.agents && input.agents.some((agent) => agent !== '*' && !(AGENT_ROLES as readonly string[]).includes(agent))) throw new BadRequestException(`Agents must be "*" or ${AGENT_ROLES.join(', ')}.`)
  }

  private data(input: Partial<McpServerInput>) {
    return {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.transport !== undefined ? { transport: input.transport } : {}),
      ...(input.command !== undefined ? { command: input.command || null } : {}),
      ...(input.args !== undefined ? { args: asJson(input.args) } : {}),
      ...(input.env !== undefined ? { env: asJson(input.env) } : {}),
      ...(input.secretEnv !== undefined ? { secretEnv: asJson(input.secretEnv) } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd || null } : {}),
      ...(input.url !== undefined ? { url: input.url || null } : {}),
      ...(input.headers !== undefined ? { headers: asJson(input.headers) } : {}),
      ...(input.secretHeaders !== undefined ? { secretHeaders: asJson(input.secretHeaders) } : {}),
      ...(input.oauth !== undefined ? { oauth: asJson(input.oauth) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.toolPolicies !== undefined ? { toolPolicies: asJson(input.toolPolicies) } : {}),
      ...(input.defaultPolicy !== undefined ? { defaultPolicy: input.defaultPolicy } : {}),
      ...(input.agents !== undefined ? { agents: asJson(input.agents) } : {}),
    }
  }

  describe(record: McpServerRecord) {
    const tools = (record.tools as McpToolInfo[] | null) ?? null
    const connection = this.connections.get(record.id)
    return {
      id: record.id,
      name: record.name,
      transport: record.transport,
      command: record.command,
      args: record.args as string[],
      env: record.env as Record<string, string>,
      secretEnv: record.secretEnv as string[],
      cwd: record.cwd,
      url: record.url,
      headers: record.headers as Record<string, string>,
      secretHeaders: record.secretHeaders as Array<{ header: string; secret: string; prefix?: string }>,
      oauth: record.oauth,
      enabled: record.enabled,
      timeoutMs: record.timeoutMs,
      toolPolicies: record.toolPolicies as Record<string, ToolPolicy>,
      defaultPolicy: record.defaultPolicy as ToolPolicy,
      agents: record.agents as string[],
      status: record.status,
      lastError: record.lastError,
      connection: connection ? { kind: connection.kind, connectedAt: new Date(connection.connectedAt).toISOString(), lastUsed: new Date(connection.lastUsed).toISOString() } : null,
      tools: tools?.map((tool) => ({ ...tool, policy: policyFor(record, tool) })) ?? null,
      toolsAt: record.toolsAt,
      createdAt: record.createdAt,
    }
  }

  async list() {
    return (await this.prisma.mcpServer.findMany({ orderBy: { name: 'asc' } })).map((record) => this.describe(record))
  }

  private async record(id: string) {
    const record = await this.prisma.mcpServer.findUnique({ where: { id } })
    if (!record) throw new NotFoundException('MCP server not found.')
    return record
  }

  async get(id: string) {
    return { ...this.describe(await this.record(id)), logs: this.logs.get(id) ?? [] }
  }

  async create(input: McpServerInput) {
    this.validate(input, false)
    if (await this.prisma.mcpServer.findUnique({ where: { name: input.name } })) throw new ConflictException(`A server named "${input.name}" exists already.`)
    const record = await this.prisma.mcpServer.create({ data: { name: input.name, transport: input.transport, ...this.data(input) } })
    this.events.publish('system', 'mcp_changed', { id: record.id })
    return this.describe(record)
  }

  async update(id: string, input: Partial<McpServerInput>) {
    this.validate(input, true)
    const before = await this.record(id)
    const record = await this.prisma.mcpServer.update({ where: { id }, data: this.data(input) })
    // connection settings changed: the next use reconnects with the new configuration
    const connectionKeys: Array<keyof McpServerInput> = ['transport', 'command', 'args', 'env', 'secretEnv', 'cwd', 'url', 'headers', 'secretHeaders', 'oauth']
    if (input.url !== undefined || input.oauth !== undefined) {
      await this.oauthProviders.get(id)?.cancel()
      this.oauthProviders.delete(id)
      if (shellAvailable()) for (const name of ['oauth-client', 'oauth-tokens']) await shellRequest('secret:delete', { scope: `mcp:${id}`, name })
    }
    if (connectionKeys.some((key) => input[key] !== undefined) || (before.enabled && input.enabled === false)) await this.disconnect(id)
    if (input.enabled === false) await this.setStatus(id, 'disabled')
    else if (input.enabled === true && before.status === 'disabled') await this.setStatus(id, 'idle')
    this.events.publish('system', 'mcp_changed', { id })
    return this.describe(record)
  }

  async remove(id: string) {
    await this.oauthProviders.get(id)?.cancel()
    this.oauthProviders.delete(id)
    await this.disconnect(id)
    await this.prisma.mcpServer.delete({ where: { id } })
    this.logs.delete(id)
    this.events.publish('system', 'mcp_changed', { id })
    return { ok: true }
  }

  /**
   * Imports servers from the common JSON format ({ "mcpServers": { name: { command, args, env } | { url, headers } } }).
   * Values of environment variables/headers that look like credentials go to the encrypted vault.
   */
  async importConfig(json: string) {
    let parsed: { mcpServers?: Record<string, Record<string, unknown>>; servers?: Record<string, Record<string, unknown>> }
    try {
      parsed = JSON.parse(json) as typeof parsed
    } catch {
      throw new BadRequestException('Invalid JSON.')
    }
    const servers = parsed.mcpServers ?? parsed.servers
    if (!servers || typeof servers !== 'object') throw new BadRequestException('Expected { "mcpServers": { … } }.')
    const sensitive = /(token|secret|key|password|passwd|auth|credential|cookie)/i
    const results: Array<{ name: string; ok: boolean; id?: string; error?: string; secretsStored?: string[] }> = []
    for (const [name, raw] of Object.entries(servers)) {
      try {
        const entry = raw ?? {}
        const type = String(entry.type ?? (entry.url ? 'http' : 'stdio'))
        const env: Record<string, string> = {}
        const secretEnv: string[] = []
        const secretValues: Record<string, string> = {}
        for (const [key, value] of Object.entries((entry.env ?? {}) as Record<string, unknown>)) {
          if (sensitive.test(key) && String(value)) {
            secretEnv.push(key)
            secretValues[key] = String(value)
          } else env[key] = String(value)
        }
        const headers: Record<string, string> = {}
        const secretHeaders: Array<{ header: string; secret: string; prefix?: string }> = []
        for (const [key, value] of Object.entries((entry.headers ?? {}) as Record<string, unknown>)) {
          if (/^(authorization|x-api-key|api-key|cookie)$/i.test(key) || sensitive.test(key)) {
            const secret = `header-${key.toLowerCase()}`
            const text = String(value)
            const bearer = /^Bearer\s+/i.exec(text)
            secretHeaders.push({ header: key, secret, prefix: bearer ? 'Bearer ' : undefined })
            secretValues[secret] = bearer ? text.slice(bearer[0].length) : text
          } else headers[key] = String(value)
        }
        const created = await this.create({
          name: name.replace(/[^\w.-]+/g, '-').slice(0, 48),
          transport: type === 'stdio' ? 'stdio' : 'http',
          command: entry.command ? String(entry.command) : undefined,
          args: Array.isArray(entry.args) ? entry.args.map(String) : [],
          env,
          secretEnv,
          cwd: entry.cwd ? String(entry.cwd) : undefined,
          url: entry.url ? String(entry.url) : undefined,
          headers,
          secretHeaders,
          // imported servers start disabled: their commands were not written by the user in this app
          enabled: false,
        })
        const stored: string[] = []
        for (const [secret, value] of Object.entries(secretValues)) {
          if (shellAvailable()) {
            await shellRequest('secret:set', { scope: `mcp:${created.id}`, name: secret, value })
            stored.push(secret)
          }
        }
        results.push({ name, ok: true, id: created.id, secretsStored: stored })
      } catch (error) {
        results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }

  /** MCP configurations found in a project (.mcp.json); shown for import, never started automatically. */
  async discover(repoPath: string) {
    const found: Array<{ file: string; servers: string[]; json: string }> = []
    for (const file of ['.mcp.json', '.vscode/mcp.json', '.cursor/mcp.json']) {
      const absolute = path.join(repoPath, file)
      if (!existsSync(absolute)) continue
      try {
        const json = await fs.readFile(absolute, 'utf8')
        const parsed = JSON.parse(json) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> }
        found.push({ file, servers: Object.keys(parsed.mcpServers ?? parsed.servers ?? {}), json })
      } catch {
        found.push({ file, servers: [], json: '' })
      }
    }
    return found
  }

  // ---------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------

  private async secret(id: string, name: string): Promise<string | undefined> {
    if (!shellAvailable()) return process.env[`MAC_MCP_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]
    return (await shellRequest<string | null>('secret:get', { scope: `mcp:${id}`, name }).catch(() => null)) ?? undefined
  }

  private oauthProvider(record: McpServerRecord) {
    let provider = this.oauthProviders.get(record.id)
    if (!provider) {
      const scope = `mcp:${record.id}`
      provider = new McpOAuthProvider({
        get: async (name) => { if (!shellAvailable()) throw new Error('OAuth requires the desktop encrypted credential vault.'); return this.secret(record.id, name) },
        set: async (name, value) => { await shellRequest('secret:set', { scope, name, value }) },
        delete: async (name) => { await shellRequest('secret:delete', { scope, name }) },
      }, jsonObject(record.oauth) as { clientId?: string; scope?: string })
      this.oauthProviders.set(record.id, provider)
    }
    return provider
  }

  async loginOAuth(id: string) {
    const record = await this.record(id)
    if (!record.enabled || record.transport !== 'http' || !jsonObject(record.oauth).enabled) throw new BadRequestException('Enable OAuth for this HTTP server first.')
    if (!shellAvailable()) throw new BadRequestException('OAuth requires the desktop encrypted credential vault.')
    await this.disconnect(id)
    const provider = this.oauthProvider(record)
    const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js')
    await provider.begin(async (code) => {
      try {
        const result = await auth(provider, { serverUrl: record.url!, authorizationCode: code })
        if (result !== 'AUTHORIZED') throw new Error('OAuth token exchange did not authorize the client.')
        await this.setStatus(id, 'idle')
        this.log(id, 'info', 'OAuth authorization completed; credentials saved in encrypted vault.')
      } catch (error) { await this.setStatus(id, 'error', 'OAuth token exchange failed. Start login again.'); throw error }
    })
    try {
      // A dynamic registration belongs to the new callback listener.
      if (!jsonObject(record.oauth).clientId) await provider.invalidateCredentials('client')
      const result = await auth(provider, { serverUrl: record.url! })
      return { authorized: result === 'AUTHORIZED', authorizationUrl: provider.authorizationUrl }
    } catch (error) {
      await provider.cancel()
      throw new BadRequestException(`OAuth login could not start: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async cancelOAuthLogin(id: string) {
    await this.oauthProviders.get(id)?.cancel()
  }

  async logoutOAuth(id: string) {
    const record = await this.record(id)
    await this.disconnect(id)
    const provider = this.oauthProvider(record)
    await provider.cancel()
    await provider.invalidateCredentials('all')
    return { ok: true }
  }

  private async transportFor(record: McpServerRecord, kind: 'stdio' | 'streamable-http' | 'sse'): Promise<Transport> {
    const { getDefaultEnvironment, StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport } = await sdk()
    if (kind === 'stdio') {
      const env: Record<string, string> = { ...getDefaultEnvironment(), ...(record.env as Record<string, string>) }
      for (const name of record.secretEnv as string[]) {
        const value = await this.secret(record.id, name)
        if (value === undefined) throw new Error(`Secret environment variable ${name} is not set (MCP manager → server → secrets).`)
        env[name] = value
      }
      const transport = new StdioClientTransport({ command: record.command!, args: record.args as string[], env, cwd: record.cwd ?? undefined, stderr: 'pipe' })
      transport.stderr?.on('data', (chunk: Buffer) => this.log(record.id, 'stderr', chunk.toString('utf8').trimEnd()))
      return transport
    }
    const headers: Record<string, string> = { ...(record.headers as Record<string, string>) }
    for (const entry of record.secretHeaders as Array<{ header: string; secret: string; prefix?: string }>) {
      const value = await this.secret(record.id, entry.secret)
      if (value === undefined) throw new Error(`Secret for header ${entry.header} is not set (MCP manager → server → secrets).`)
      headers[entry.header] = `${entry.prefix ?? ''}${value}`
    }
    const url = new URL(record.url!)
    const authProvider = jsonObject(record.oauth).enabled ? this.oauthProvider(record) : undefined
    await authProvider?.requireLogin()
    return kind === 'streamable-http' ? new StreamableHTTPClientTransport(url, { authProvider, requestInit: { headers } }) : new SSEClientTransport(url, { authProvider, requestInit: { headers }, eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) } })
  }

  private async open(record: McpServerRecord): Promise<Connection> {
    const kinds: Array<'stdio' | 'streamable-http' | 'sse'> = record.transport === 'stdio' ? ['stdio'] : ['streamable-http', 'sse']
    let lastError: unknown
    for (const kind of kinds) {
      const transport = await this.transportFor(record, kind)
      const client = new (await sdk()).Client({ name: 'multi-ai-coder', version: '0.3.0' }, { capabilities: {} })
      try {
        await client.connect(transport, { timeout: Math.min(record.timeoutMs, 60_000) })
        const connection: Connection = { client, transport, kind, connectedAt: Date.now(), lastUsed: Date.now(), closing: false }
        // client.onclose (not transport.onclose: the SDK's protocol layer owns that handler)
        client.onclose = () => void this.onClosed(record.id, connection)
        const version = client.getServerVersion()
        this.log(record.id, 'info', `connected via ${kind}${version ? ` to ${version.name} ${version.version}` : ''}`)
        return connection
      } catch (error) {
        lastError = error
        this.log(record.id, 'error', `${kind}: ${error instanceof Error ? error.message : String(error)}`)
        await client.close().catch(() => undefined)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /** Connects (once; concurrent callers share the attempt) and refreshes the tool list. */
  async connect(id: string): Promise<Connection> {
    const existing = this.connections.get(id)
    if (existing) return existing
    const pending = this.connecting.get(id)
    if (pending) return pending
    const attempt = (async () => {
      const record = await this.record(id)
      if (!record.enabled) throw new BadRequestException(`MCP server ${record.name} is disabled.`)
      await this.setStatus(id, 'connecting')
      try {
        const connection = await this.open(record)
        this.connections.set(id, connection)
        await this.refreshTools(id, connection)
        this.reconnects.delete(id)
        await this.setStatus(id, 'connected')
        return connection
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error)
        const command = record.command ?? ''
        const commandFound = record.transport !== 'stdio' || (path.isAbsolute(command) ? existsSync(command) : Boolean(resolveExecutable(command)))
        const hint = diagnoseMcpError(raw, record.transport, commandFound)
        const message = hint ? `${raw} — ${hint}` : raw
        await this.setStatus(id, 'error', message)
        throw new BadRequestException(`MCP server ${record.name}: ${message}`)
      }
    })()
    this.connecting.set(id, attempt)
    try {
      return await attempt
    } finally {
      this.connecting.delete(id)
    }
  }

  private async refreshTools(id: string, connection: Connection) {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    do {
      const page = await connection.client.listTools(cursor ? { cursor } : undefined)
      for (const tool of page.tools) tools.push({ name: tool.name, title: tool.title, description: tool.description ?? '', inputSchema: tool.inputSchema as Record<string, unknown>, annotations: tool.annotations })
      cursor = page.nextCursor
    } while (cursor && tools.length < 500)
    await this.prisma.mcpServer.update({ where: { id }, data: { tools: asJson(tools), toolsAt: new Date() } })
    this.log(id, 'info', `${tools.length} tool(s) discovered`)
    return tools
  }

  async tools(id: string, refresh = false) {
    if (refresh) await this.refreshTools(id, await this.connect(id))
    return this.describe(await this.record(id)).tools ?? []
  }

  async disconnect(id: string) {
    const connection = this.connections.get(id)
    if (!connection) return
    connection.closing = true
    this.connections.delete(id)
    await connection.client.close().catch(() => undefined)
    const record = await this.prisma.mcpServer.findUnique({ where: { id } })
    if (record) await this.setStatus(id, record.enabled ? 'idle' : 'disabled')
  }

  /** Unexpected close (server crashed/network): reconnect with backoff while the server is in use. */
  private async onClosed(id: string, connection: Connection) {
    if (connection.closing || this.connections.get(id) !== connection) return
    this.connections.delete(id)
    const attempts = (this.reconnects.get(id) ?? 0) + 1
    this.reconnects.set(id, attempts)
    this.log(id, 'error', 'connection closed unexpectedly')
    if (Date.now() - connection.lastUsed > IDLE_MS || attempts > 3) {
      await this.setStatus(id, 'error', attempts > 3 ? 'Connection lost; reconnecting failed 3 times.' : 'Connection lost.')
      return
    }
    await this.setStatus(id, 'connecting', `Connection lost; reconnecting (attempt ${attempts}).`)
    setTimeout(() => void this.connect(id).catch(() => undefined), 1000 * 2 ** (attempts - 1)).unref()
  }

  /** Health check of a server (connects if needed): round trip of an MCP ping. */
  async health(id: string) {
    const started = Date.now()
    const connection = await this.connect(id)
    await connection.client.ping({ timeout: 10_000 })
    return { ok: true, ms: Date.now() - started, kind: connection.kind }
  }

  /** Pings active connections and closes idle ones (lazy connections reopen on the next use). */
  private async maintain() {
    for (const [id, connection] of [...this.connections]) {
      if (Date.now() - connection.lastUsed > IDLE_MS) {
        this.log(id, 'info', 'idle; disconnected')
        await this.disconnect(id)
        continue
      }
      try {
        await connection.client.ping({ timeout: 10_000 })
      } catch (error) {
        this.log(id, 'error', `health check failed: ${error instanceof Error ? error.message : String(error)}`)
        connection.closing = false
        await connection.client.close().catch(() => undefined)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tool calls
  // ---------------------------------------------------------------------------

  /**
   * Calls a tool. Manual calls (from the MCP manager, after the user confirmed) are allowed for
   * "allow" and "confirm" tools; agents may only call "allow" tools.
   */
  async callTool(id: string, name: string, args: Record<string, unknown>, options: { source: 'manual' | 'agent'; signal?: AbortSignal; limit?: number; includeContent?: boolean } = { source: 'manual' }) {
    const record = await this.record(id)
    const tool = ((record.tools as McpToolInfo[] | null) ?? []).find((candidate) => candidate.name === name)
    if (!tool) throw new BadRequestException(`Tool "${name}" is unknown (refresh the tool list).`)
    const policy = policyFor(record, tool)
    if (policy === 'off') throw new BadRequestException(`Tool "${name}" is disabled.`)
    if (options.source === 'agent' && policy !== 'allow') throw new BadRequestException(`Tool "${name}" needs a confirmation and is not available to agents.`)
    const connection = await this.connect(id)
    connection.lastUsed = Date.now()
    const started = Date.now()
    try {
      const result = await connection.client.callTool({ name, arguments: args }, undefined, { timeout: record.timeoutMs, signal: options.signal, resetTimeoutOnProgress: true })
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_MCP_RESULT_BYTES) throw new Error('Tool result exceeds the 16 MB byte limit; a complete result cannot be retained.')
      const text = resultText(result as never, options.limit ?? (options.source === 'agent' ? AGENT_RESULT_CHARS : MANUAL_RESULT_CHARS))
      // manual calls: the UI shows a bounded preview and can save the complete text
      const fullText = options.source === 'manual' && text.endsWith('characters truncated]') ? resultText(result as never, Number.MAX_SAFE_INTEGER) : undefined
      this.log(id, result.isError ? 'warn' : 'info', `${options.source} call ${name} (${Date.now() - started} ms)${result.isError ? ' → error' : ''}`)
      this.events.publish('system', 'mcp_tool_called', { id, tool: name, source: options.source, ms: Date.now() - started, isError: Boolean(result.isError) })
      return { isError: Boolean(result.isError), text, durationMs: Date.now() - started, content: options.source === 'manual' || options.includeContent ? result.content : undefined, structuredContent: options.includeContent ? result.structuredContent : undefined, ...(fullText ? { fullText } : {}) }
    } catch (error) {
      this.log(id, 'error', `${options.source} call ${name} failed after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`)
      throw new BadRequestException(`MCP ${record.name}/${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Tools of the servers assigned to a role, as agent tools: only "allow" tools, definitions from the
   * cached list (no connection until a tool is actually called), at most MAX_AGENT_TOOLS ranked by
   * relevance to the goal, compact schemas. Long results come back page by page: the first page plus
   * a reference that only this call's `mcp_read_result` tool can read (one store per agent run).
   * `resultLimit` = MAX_SAFE_INTEGER returns raw results (the orchestrator gateway pages itself).
   */
  /** Whether any enabled server is shared with this role (cheap check before opening a gateway). */
  async hasServersFor(role: AgentRole, onlyServers: string[] = ['*']): Promise<boolean> {
    if (!onlyServers.length) return false
    const servers = await this.prisma.mcpServer.findMany({ where: { enabled: true }, select: { id: true, agents: true } })
    return servers.some((server) => {
      const agents = server.agents as string[]
      return (agents.includes('*') || agents.includes(role)) && (onlyServers.includes('*') || onlyServers.includes(server.id))
    })
  }

  async agentTools(role: AgentRole, goal: string, onlyServers: string[] = ['*'], resultLimit = AGENT_RESULT_CHARS): Promise<AgentTool[]> {
    if (!onlyServers.length) return []
    const catalogNames = new Map((await this.prisma.integrationInstallation.findMany()).map((entry) => [entry.serverId, `catalog-${entry.presetId}`]))
    const servers = (await this.prisma.mcpServer.findMany({ where: { enabled: true } })).filter((server) => {
      const agents = server.agents as string[]
      return (agents.includes('*') || agents.includes(role)) && (onlyServers.includes('*') || onlyServers.includes(server.id))
    })
    const words = new Set(goal.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2))
    const candidates: Array<{ server: McpServerRecord; tool: McpToolInfo; score: number }> = []
    for (const server of servers) {
      let tools = server.tools as McpToolInfo[] | null
      if (!tools) {
        // never discovered: one short attempt so the agent knows what exists
        tools = await Promise.race([this.tools(server.id, true).catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000))])
        if (!tools) continue
      }
      for (const tool of tools) {
        if (policyFor(server, tool) !== 'allow') continue
        const text = `${tool.name} ${tool.description}`.toLowerCase()
        let score = 0
        for (const word of words) if (text.includes(word)) score += 1
        candidates.push({ server, tool, score })
      }
    }
    const pages = new ResultPages(resultLimit === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : resultLimit)
    const tools: AgentTool[] = candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_AGENT_TOOLS)
      .map(({ server, tool }) => ({
        name: agentToolName(catalogNames.get(server.id) ?? server.name, tool.name),
        description: `[MCP ${server.name}] ${(tool.description || tool.title || tool.name).slice(0, 400)}`,
        readOnly: tool.annotations?.readOnlyHint === true,
        parameters: (compactSchema(tool.inputSchema) as Record<string, unknown>) ?? { type: 'object' },
        executeContent: async (args, signal) => {
          const current = await this.record(server.id)
          const assignments = current.agents as string[]
          if (!current.enabled || (!assignments.includes('*') && !assignments.includes(role))) throw new BadRequestException('MCP server is no longer assigned to this agent.')
          const result = await this.callTool(server.id, tool.name, args, { source: 'agent', signal, limit: Number.MAX_SAFE_INTEGER, includeContent: true })
          return { isError: result.isError, content: richMcpContent(result) }
        },
        execute: async (args, signal) => {
          const current = await this.record(server.id)
          const assignments = current.agents as string[]
          if (!current.enabled || (!assignments.includes('*') && !assignments.includes(role))) throw new BadRequestException('MCP server is no longer assigned to this agent.')
          const result = await this.callTool(server.id, tool.name, args, { source: 'agent', signal, limit: Number.MAX_SAFE_INTEGER })
          return pages.page(result.isError ? `Error from ${tool.name}: ${result.text}` : result.text || '(no output)', async () => {
            const current = await this.record(server.id).catch(() => undefined)
            const assignments = current?.agents as string[] | undefined
            return Boolean(current?.enabled && assignments && (assignments.includes('*') || assignments.includes(role)) && policyFor(current, tool) === 'allow')
          })
        },
      }))
    if (tools.length && resultLimit !== Number.MAX_SAFE_INTEGER) {
      tools.push({ name: 'mcp_read_result', readOnly: true, description: READ_RESULT_DESCRIPTION, parameters: READ_RESULT_SCHEMA, execute: async (args) => pages.read(args.reference, args.offset ?? 0) })
    }
    return tools
  }
}
