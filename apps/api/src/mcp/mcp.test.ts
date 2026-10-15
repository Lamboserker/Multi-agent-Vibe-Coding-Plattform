// MCP manager against real MCP servers built with the official SDK: a stdio server process and a
// Streamable HTTP server with bearer authentication.
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const db = useTempDatabase('mac-mcp-')
process.env.MAC_DATA_DIR = db.dir
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { McpService, compactSchema, policyFor, agentToolName, resultText, diagnoseMcpError } = await import('./mcp.service.js')
const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { buildServer } = (await import('./testing/test-server.mjs' as string)) as { buildServer: () => { connect: (transport: unknown) => Promise<void>; close: () => Promise<void> } }

const prisma = new PrismaService()
const service = new McpService(prisma, new EventBusService())
const stdioScript = path.join(here, 'testing', 'test-server.mjs')
let http: Server
let httpUrl = ''

beforeAll(async () => {
  await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
  service.onModuleInit()
  // Streamable HTTP (stateless): one server instance per request, bearer token required
  http = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer s3cret') {
      response.writeHead(401).end('unauthorized')
      return
    }
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', async () => {
      const server = buildServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      response.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(request, response, body ? JSON.parse(body) : undefined)
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  httpUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`
})

afterAll(async () => {
  await service.onApplicationShutdown()
  http?.close()
  await prisma.$disconnect()
  db.cleanup()
})

describe('helpers', () => {
  it('compacts schemas, names tools for models and truncates results', () => {
    expect(compactSchema({ $schema: 'x', type: 'object', title: 'T', properties: { a: { type: 'string', description: 'd'.repeat(300), examples: ['x'] } } })).toEqual({ type: 'object', properties: { a: { type: 'string', description: `${'d'.repeat(197)}…` } } })
    expect(agentToolName('my server', 'do.thing')).toBe('mcp_my_server_do_thing')
    expect(resultText({ content: [{ type: 'text', text: 'abcdef' }] }, 3)).toBe('abc\n… [3 characters truncated]')
    expect(resultText({ content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] }, 100)).toBe('[image image/png, 0 KB]')
    const tool = { name: 'drop', description: '', inputSchema: {}, annotations: { destructiveHint: true } }
    expect(policyFor({ toolPolicies: {}, defaultPolicy: 'allow' }, tool)).toBe('confirm')
    expect(policyFor({ toolPolicies: { drop: 'allow' }, defaultPolicy: 'confirm' }, tool)).toBe('allow')
  })
})

describe('diagnosis', () => {
  it('turns raw connection errors into actionable hints', () => {
    expect(diagnoseMcpError('spawn nonexistent-cmd ENOENT', 'stdio')).toMatch(/Befehl nicht gefunden/)
    expect(diagnoseMcpError('fetch failed', 'http')).toMatch(/nicht erreichbar/)
    expect(diagnoseMcpError('Streamable HTTP error: Error POSTing to endpoint (HTTP 401)', 'http')).toMatch(/Authentifizierung/)
    expect(diagnoseMcpError('HTTP 404 Not Found', 'http')).toMatch(/URL-Pfad/)
    expect(diagnoseMcpError('Request timed out', 'http')).toMatch(/Zeitüberschreitung/)
    expect(diagnoseMcpError('MCP error -32000: Connection closed', 'stdio')).toMatch(/beendet/)
    expect(diagnoseMcpError('OAuth login required: …', 'http')).toMatch(/OAuth anmelden/)
    expect(diagnoseMcpError('something unusual', 'http')).toBeUndefined()
  })
  it('stores the hint with the status of a server that cannot start', async () => {
    const created = await service.create({ name: 'broken', transport: 'stdio', command: 'definitely-not-installed-mcp-xyz', args: [] })
    await expect(service.tools(created.id, true)).rejects.toThrow(/Befehl nicht gefunden/)
    expect((await service.get(created.id)).lastError).toMatch(/Befehl nicht gefunden/)
    await service.remove(created.id)
  }, 30_000)
})

describe('MCP servers', () => {
  let stdioId = ''

  it('connects to a stdio server, discovers tools and calls them', async () => {
    const created = await service.create({ name: 'local-test', transport: 'stdio', command: process.execPath, args: [stdioScript], defaultPolicy: 'allow', timeoutMs: 5000 })
    stdioId = created.id
    expect(created.status).toBe('idle')
    const tools = await service.tools(stdioId, true)
    expect(tools.map((tool) => tool.name).sort()).toEqual(['add', 'big', 'crash', 'drop_table', 'echo', 'fail', 'magic_number', 'secret_env', 'slow'])
    expect(tools.find((tool) => tool.name === 'drop_table')!.policy).toBe('confirm') // destructive hint
    expect(tools.find((tool) => tool.name === 'add')!.policy).toBe('allow')
    expect((await service.health(stdioId)).ok).toBe(true)
    expect(await service.callTool(stdioId, 'add', { a: 2, b: 3 })).toMatchObject({ isError: false, text: '5' })
    expect(await service.callTool(stdioId, 'fail', {})).toMatchObject({ isError: true, text: 'something went wrong' })
    const details = await service.get(stdioId)
    expect(details.status).toBe('connected')
    expect(details.logs.some((line) => line.message.includes('connected via stdio to mac-test-server 1.2.3'))).toBe(true)
    expect(details.logs.some((line) => line.level === 'stderr' && line.message.includes('ready (stdio)'))).toBe(true)
  }, 30_000)

  it('enforces tool policies for agents and manual calls', async () => {
    // destructive tool: manual call (after the UI confirmation) works, agents never get it
    expect((await service.callTool(stdioId, 'drop_table', { table: 'users' })).text).toBe('dropped users')
    await expect(service.callTool(stdioId, 'drop_table', { table: 'users' }, { source: 'agent' })).rejects.toThrow(/needs a confirmation/)
    await service.update(stdioId, { toolPolicies: { echo: 'off' } })
    await expect(service.callTool(stdioId, 'echo', { text: 'x' })).rejects.toThrow(/disabled/)
    const agentTools = await service.agentTools('coder', 'add two numbers')
    const names = agentTools.map((tool) => tool.name)
    expect(names[0]).toBe('mcp_local-test_add') // most relevant first
    expect(names).not.toContain('mcp_local-test_drop_table')
    expect(names).not.toContain('mcp_local-test_echo')
    expect(await agentTools[0]!.execute({ a: 40, b: 2 })).toBe('42')
    // long results: first page + reference; the complete text is readable page by page via
    // mcp_read_result of the same run only
    const big = agentTools.find((tool) => tool.name === 'mcp_local-test_big')!
    const first = JSON.parse(await big.execute({})) as { text: string; reference: string; totalChars: number; nextOffset: number }
    expect(first).toMatchObject({ totalChars: 50_000, nextOffset: 12_000 })
    const read = agentTools.find((tool) => tool.name === 'mcp_read_result')!
    let full = first.text
    for (let offset: number | null = first.nextOffset; offset !== null; ) {
      const page = JSON.parse(await read.execute({ reference: first.reference, offset })) as { text: string; nextOffset: number | null }
      full += page.text
      offset = page.nextOffset
    }
    expect(full).toBe('x'.repeat(50_000))
    const otherRun = (await service.agentTools('coder', 'big')).find((tool) => tool.name === 'mcp_read_result')!
    await expect(otherRun.execute({ reference: first.reference })).rejects.toThrow(/unavailable/)
    // manual calls: bounded preview plus the complete text for "save completely" in the UI
    const manual = await service.callTool(stdioId, 'big', {}, { source: 'manual', limit: 1000 })
    expect(manual.text.length).toBeLessThan(1100)
    expect(manual.fullText).toBe('x'.repeat(50_000))
    // roles: a server assigned to the planner only is not offered to coders
    await service.update(stdioId, { agents: ['planner'], toolPolicies: {} })
    await expect(read.execute({ reference: first.reference, offset: 12_000 })).rejects.toThrow(/revoked/)
    expect(await service.agentTools('coder', '')).toEqual([])
    await service.update(stdioId, { agents: ['*'] })
  }, 30_000)

  it('times out slow tools and reconnects after a server crash', async () => {
    await expect(service.callTool(stdioId, 'slow', { ms: 10_000 })).rejects.toThrow(/timed out|Request timed out|-32001/i)
    const pidBefore = (await service.get(stdioId)).connection?.connectedAt
    expect(await service.callTool(stdioId, 'crash', {})).toMatchObject({ text: 'bye' })
    // the crash is noticed …
    const deadline = Date.now() + 15_000
    while (!(await service.get(stdioId)).logs.some((line) => line.message.includes('connection closed unexpectedly'))) {
      if (Date.now() > deadline) throw new Error('crash not detected')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // … and the server is reconnected in the background (backoff 1 s) or on the next use
    for (;;) {
      try {
        expect(await service.callTool(stdioId, 'add', { a: 1, b: 1 })).toMatchObject({ text: '2' })
        break
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    const after = await service.get(stdioId)
    expect(after.status).toBe('connected')
    expect(after.connection?.connectedAt).not.toBe(pidBefore)
  }, 40_000)

  it('passes secret environment variables to stdio servers', async () => {
    await service.update(stdioId, { secretEnv: ['TEST_TOKEN'] })
    // no desktop shell in tests: the vault lookup falls back to MAC_MCP_SECRET_<NAME>
    await expect(service.callTool(stdioId, 'secret_env', {})).rejects.toThrow(/TEST_TOKEN is not set/)
    process.env.MAC_MCP_SECRET_TEST_TOKEN = 'abcd'
    expect((await service.callTool(stdioId, 'secret_env', {})).text).toBe('token:4')
  }, 30_000)

  it('connects over Streamable HTTP with a bearer token from the vault', async () => {
    const created = await service.create({ name: 'http-test', transport: 'http', url: httpUrl, secretHeaders: [{ header: 'Authorization', secret: 'token', prefix: 'Bearer ' }], defaultPolicy: 'allow' })
    await expect(service.tools(created.id, true)).rejects.toThrow(/token|not set/i)
    process.env.MAC_MCP_SECRET_TOKEN = 'wrong'
    await expect(service.tools(created.id, true)).rejects.toThrow()
    expect((await service.get(created.id)).status).toBe('error')
    process.env.MAC_MCP_SECRET_TOKEN = 's3cret'
    const tools = await service.tools(created.id, true)
    expect(tools).toHaveLength(9)
    expect((await service.get(created.id)).connection?.kind).toBe('streamable-http')
    expect(await service.callTool(created.id, 'echo', { text: 'über HTTP' })).toMatchObject({ text: 'über HTTP' })
  }, 30_000)

  it('imports configurations (credentials are not stored in plain text) and starts them disabled', async () => {
    const results = await service.importConfig(JSON.stringify({ mcpServers: { imported: { command: 'npx', args: ['-y', 'some-server'], env: { API_TOKEN: 'secret-value', REGION: 'eu' } }, remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc' } } } }))
    expect(results.every((result) => result.ok)).toBe(true)
    const servers = await service.list()
    const imported = servers.find((server) => server.name === 'imported')!
    expect(imported).toMatchObject({ enabled: false, env: { REGION: 'eu' }, secretEnv: ['API_TOKEN'] })
    expect(JSON.stringify(imported)).not.toContain('secret-value')
    const remote = servers.find((server) => server.name === 'remote')!
    expect(remote.secretHeaders).toEqual([{ header: 'Authorization', secret: 'header-authorization', prefix: 'Bearer ' }])
    await expect(service.tools(imported.id, true)).rejects.toThrow(/disabled/)
  })

  it('disconnects disabled servers and validates input', async () => {
    await service.update(stdioId, { enabled: false })
    expect((await service.get(stdioId)).status).toBe('disabled')
    expect((await service.get(stdioId)).connection).toBeNull()
    await expect(service.create({ name: 'bad name!', transport: 'stdio', command: 'x' })).rejects.toThrow(/Name/)
    await expect(service.create({ name: 'nourl', transport: 'http', url: 'ftp://x' })).rejects.toThrow(/http/)
    await expect(service.create({ name: 'local-test', transport: 'stdio', command: 'x' })).rejects.toThrow(/exists/)
  })
})
