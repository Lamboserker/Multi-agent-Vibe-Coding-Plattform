// MCP OAuth (authorization code + PKCE) against a local authorization server that follows the MCP
// authorization spec: protected-resource metadata, authorization-server metadata, dynamic client
// registration, S256 PKCE, state, loopback callback, refresh. The desktop vault is simulated through
// the same parent-port protocol the Electron shell uses, so credentials never touch the database.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { useTempDatabase } from '../test-db.js'

const vault = new Map<string, string>()
const listeners: Array<(message: { data: unknown }) => void> = []
;(process as unknown as { parentPort: unknown }).parentPort = {
  on: (_event: string, listener: (message: { data: unknown }) => void) => listeners.push(listener),
  postMessage: (message: { type: string; id: number; method: string; params: { scope: string; name: string; value?: string } }) => {
    const key = `${message.params.scope}/${message.params.name}`
    let value: unknown = null
    if (message.method === 'secret:get') value = vault.get(key) ?? null
    if (message.method === 'secret:set') vault.set(key, message.params.value!)
    if (message.method === 'secret:delete') vault.delete(key)
    queueMicrotask(() => listeners.forEach((listener) => listener({ data: { type: 'shell-response', id: message.id, ok: true, value } })))
  },
}

const db = useTempDatabase('mac-mcp-oauth-')
process.env.MAC_DATA_DIR = db.dir
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { MIGRATIONS_DIR } = await import('../test-db.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { McpService } = await import('./mcp.service.js')
const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { buildServer } = (await import('./testing/test-server.mjs' as string)) as { buildServer: () => { connect: (transport: unknown) => Promise<void>; close: () => Promise<void> } }

const prisma = new PrismaService()
const service = new McpService(prisma, new EventBusService())
let http: Server
let base = ''
const clients = new Map<string, string[]>() // client_id → redirect_uris
const codes = new Map<string, { challenge: string; redirect: string; client: string }>()
const access = new Set<string>()
const refresh = new Set<string>()
const seen = { registrations: 0, refreshes: 0, challengeMethod: '', authorizeState: '' }

function form(body: string) { return Object.fromEntries(new URLSearchParams(body)) }
function issue() {
  const token = { access_token: randomBytes(16).toString('hex'), refresh_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 3600 }
  access.add(token.access_token)
  refresh.add(token.refresh_token)
  return token
}

beforeAll(async () => {
  await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
  service.onModuleInit()
  http = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', async () => {
      const url = new URL(request.url!, base)
      const json = (status: number, value: unknown) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] })
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })
      }
      if (url.pathname === '/register') {
        const metadata = JSON.parse(body) as { redirect_uris: string[] }
        const id = `client-${++seen.registrations}`
        clients.set(id, metadata.redirect_uris)
        return json(201, { ...metadata, client_id: id })
      }
      if (url.pathname === '/authorize') {
        const p = Object.fromEntries(url.searchParams)
        seen.challengeMethod = p.code_challenge_method ?? ''
        seen.authorizeState = p.state ?? ''
        if (!clients.get(p.client_id!)?.includes(p.redirect_uri!) || p.code_challenge_method !== 'S256' || !p.code_challenge) return json(400, { error: 'invalid_request' })
        const code = randomBytes(8).toString('hex')
        codes.set(code, { challenge: p.code_challenge, redirect: p.redirect_uri!, client: p.client_id! })
        return response.writeHead(302, { Location: `${p.redirect_uri}?code=${code}&state=${encodeURIComponent(p.state ?? '')}` }).end()
      }
      if (url.pathname === '/token') {
        const p = form(body)
        if (p.grant_type === 'authorization_code') {
          const entry = codes.get(p.code!)
          codes.delete(p.code!)
          const challenge = createHash('sha256').update(p.code_verifier ?? '').digest('base64url')
          if (!entry || entry.challenge !== challenge || entry.redirect !== p.redirect_uri || entry.client !== p.client_id) return json(400, { error: 'invalid_grant' })
          return json(200, issue())
        }
        if (p.grant_type === 'refresh_token' && refresh.delete(p.refresh_token!)) { seen.refreshes++; return json(200, issue()) }
        return json(400, { error: 'invalid_grant' })
      }
      if (url.pathname === '/mcp') {
        const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
        if (!token || !access.has(token)) return response.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end()
        const server = buildServer()
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        response.on('close', () => { void transport.close(); void server.close() })
        await server.connect(transport)
        return transport.handleRequest(request, response, body ? JSON.parse(body) : undefined)
      }
      response.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
})

afterAll(async () => {
  await service.onApplicationShutdown()
  http?.close()
  await prisma.$disconnect()
  db.cleanup()
})

describe('MCP OAuth', () => {
  let id = ''

  it('without login the connection fails with a clear instruction instead of opening anything', async () => {
    id = (await service.create({ name: 'oauth-test', transport: 'http', url: `${base}/mcp`, oauth: { enabled: true }, defaultPolicy: 'allow' })).id
    await expect(service.tools(id, true)).rejects.toThrow(/OAuth login required/)
    expect(seen.registrations).toBe(0) // no registration without a callback
  }, 30_000)

  it('login: discovery, dynamic registration, PKCE S256, state check, loopback callback, encrypted vault', async () => {
    const { authorized, authorizationUrl } = await service.loginOAuth(id)
    expect(authorized).toBe(false)
    const auth = new URL(authorizationUrl!)
    expect(auth.origin + auth.pathname).toBe(`${base}/authorize`)
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    const state = auth.searchParams.get('state')!
    expect(state).toMatch(/^[0-9a-f]{64}$/)
    const redirect = auth.searchParams.get('redirect_uri')!
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    // forged callback (wrong state) is rejected and does not consume the login
    expect((await fetch(`${redirect}?code=forged&state=${'0'.repeat(64)}`)).status).toBe(400)

    const toCallback = await fetch(authorizationUrl!, { redirect: 'manual' })
    expect(toCallback.status).toBe(302)
    const done = await fetch(toCallback.headers.get('location')!)
    expect(done.status).toBe(200)
    expect(await done.text()).toMatch(/Anmeldung abgeschlossen/)
    // the callback listener is single-use and closed afterwards
    await expect(fetch(toCallback.headers.get('location')!)).rejects.toThrow()

    const tokens = JSON.parse(vault.get(`mcp:${id}/oauth-tokens`)!) as { access_token: string; refresh_token: string }
    expect(access.has(tokens.access_token)).toBe(true)
    expect(vault.get(`mcp:${id}/oauth-client`)).toContain('client-')
    // nothing secret in the database file
    const file = [db.file, `${db.file}-wal`].filter(existsSync).map((name) => readFileSync(name).toString('latin1')).join('')
    expect(file.includes(tokens.access_token)).toBe(false)
    expect(file.includes(tokens.refresh_token)).toBe(false)
  }, 30_000)

  it('uses the access token, then refreshes transparently when the server revokes it', async () => {
    expect(await service.tools(id, true)).toHaveLength(9)
    expect(await service.callTool(id, 'echo', { text: 'mit OAuth' })).toMatchObject({ text: 'mit OAuth' })
    access.clear() // access token expired / revoked on the server
    await service.disconnect(id)
    expect(await service.callTool(id, 'echo', { text: 'nach Refresh' })).toMatchObject({ text: 'nach Refresh' })
    expect(seen.refreshes).toBe(1)
  }, 30_000)

  it('logout removes client and tokens from the vault; the next connection needs a new login', async () => {
    await service.logoutOAuth(id)
    expect(vault.has(`mcp:${id}/oauth-tokens`)).toBe(false)
    expect(vault.has(`mcp:${id}/oauth-client`)).toBe(false)
    await expect(service.tools(id, true)).rejects.toThrow(/OAuth login required/)
  }, 30_000)

  it('an authorization endpoint without HTTPS on a remote host is refused', async () => {
    const { McpOAuthProvider } = await import('./mcp-oauth.js')
    const provider = new McpOAuthProvider({ get: async () => undefined, set: async () => undefined, delete: async () => undefined })
    await provider.begin(async () => undefined)
    expect(() => provider.redirectToAuthorization(new URL('http://evil.example/authorize'))).toThrow(/HTTPS/)
    await provider.cancel()
  })
})

