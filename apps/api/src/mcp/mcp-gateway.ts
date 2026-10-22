import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AgentTool } from '@multi-ai-coder/engine'
import { MAX_MCP_RESULT_BYTES, ResultPages } from './mcp-results.js'

/** One loopback capability endpoint per call. Upstream secrets never leave McpService. */
export async function openMcpGateway(loadTools: (query: string) => Promise<AgentTool[]>) {
  const [{ Server }, { StreamableHTTPServerTransport }, schemas] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ])
  const route = `/mcp/${randomBytes(32).toString('hex')}`
  // bounded retention; references disappear when the CLI call ends
  const results = new ResultPages()
  const definitions = [
    { name: 'search_tools', description: 'Find assigned MCP tools for a goal; returns their compact schemas. Search before calling.', inputSchema: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'call_tool', description: 'Call an assigned tool by name after search_tools. Long results include a reference for read_result.', inputSchema: { type: 'object' as const, properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name', 'arguments'] } },
    { name: 'read_result', description: 'Read another page of a complete tool result in this session.', inputSchema: { type: 'object' as const, properties: { reference: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['reference'] } },
  ]
  const active = new Set<InstanceType<typeof Server>>()
  const http = createServer((req, res) => {
    void (async () => {
      if (req.url !== route) { res.writeHead(404).end(); return }
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      const server = new Server({ name: 'multi-ai-coder-assigned-tools', version: '0.3.0' }, { capabilities: { tools: {} } })
      active.add(server)
      server.setRequestHandler(schemas.ListToolsRequestSchema, async () => ({ tools: definitions }))
      server.setRequestHandler(schemas.CallToolRequestSchema, async (request) => {
        try {
          const args = request.params.arguments ?? {}
          let text: string
          if (request.params.name === 'search_tools') {
            if (typeof args.query !== 'string') throw new Error('query must be a string.')
            const tools = await loadTools(args.query)
            text = JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })))
          } else if (request.params.name === 'call_tool') {
            if (typeof args.name !== 'string' || !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) throw new Error('name and arguments are required.')
            // Resolve again on every invocation: disabled/reassigned tools cannot use a stale handle.
            const tool = (await loadTools(args.name)).find((entry) => entry.name === args.name)
            if (!tool) throw new Error('Tool is unavailable or is not assigned to this agent.')
            if (tool.executeContent) {
              const result = await tool.executeContent(args.arguments as Record<string, unknown>)
              if (Buffer.byteLength(JSON.stringify(result)) > MAX_MCP_RESULT_BYTES) throw new Error('MCP result exceeds the 16 MB byte limit.')
              // Check assignments again after a potentially long-running screenshot/render call.
              const permitted = async () => (await loadTools(tool.name)).some((candidate) => candidate.name === tool.name)
              if (!(await permitted())) throw new Error('Tool permission was revoked.')
              return { isError: Boolean(result.isError), content: result.content.map((block) => block.type === 'text' ? { type: 'text' as const, text: results.page(block.text, permitted) } : block) }
            }
            text = results.page(await tool.execute(args.arguments as Record<string, unknown>), async () => (await loadTools(tool.name)).some((candidate) => candidate.name === tool.name))
          } else if (request.params.name === 'read_result') {
            text = await results.read(args.reference, args.offset ?? 0)
          } else throw new Error('Unknown gateway tool.')
          return { content: [{ type: 'text' as const, text }] }
        } catch (error) {
          return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }
        }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => { active.delete(server); void server.close() })
      await server.connect(transport)
      await transport.handleRequest(req, res)
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  const address = http.address() as { port: number }
  return {
    url: `http://127.0.0.1:${address.port}${route}`,
    async close() {
      results.clear()
      await Promise.all([...active].map((server) => server.close().catch(() => undefined)))
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}
