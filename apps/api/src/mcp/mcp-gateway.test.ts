import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openMcpGateway } from './mcp-gateway.js'

describe('session MCP gateway (real SDK HTTP connection)', () => {
  it('defers schemas, filters calls, retrieves complete output and isolates sessions', async () => {
    let allowed = true
    let loads = 0
    const full = 'a'.repeat(12_000) + 'tail-secret-for-session'
    const load = async () => {
      loads++
      return allowed ? [{ name: 'assigned', description: 'only this tool', parameters: { type: 'object' }, execute: async () => full }] : []
    }
    const first = await openMcpGateway(load)
    const second = await openMcpGateway(load)
    const a = new Client({ name: 'test', version: '1' })
    const b = new Client({ name: 'test', version: '1' })
    const parsed = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text)
    try {
      await a.connect(new StreamableHTTPClientTransport(new URL(first.url)))
      await b.connect(new StreamableHTTPClientTransport(new URL(second.url)))
      expect((await a.listTools()).tools.map((tool) => tool.name)).toEqual(['search_tools', 'call_tool', 'read_result'])
      expect(loads).toBe(0)
      expect(parsed(await a.callTool({ name: 'search_tools', arguments: { query: 'assigned' } }))[0].name).toBe('assigned')
      const output = parsed(await a.callTool({ name: 'call_tool', arguments: { name: 'assigned', arguments: {} } }))
      expect(output.text).toHaveLength(12_000)
      expect(parsed(await a.callTool({ name: 'read_result', arguments: { reference: output.reference, offset: 12_000 } })).text).toBe('tail-secret-for-session')
      expect((await b.callTool({ name: 'read_result', arguments: { reference: output.reference } })).isError).toBe(true)
      allowed = false
      expect((await a.callTool({ name: 'read_result', arguments: { reference: output.reference, offset: 12_000 } })).isError).toBe(true)
      expect((await a.callTool({ name: 'call_tool', arguments: { name: 'assigned', arguments: {} } })).isError).toBe(true)
      expect((await fetch(first.url.replace(/.$/, 'z'), { method: 'POST' })).status).toBe(404)
    } finally {
      await Promise.all([a.close(), b.close()])
      await Promise.all([first.close(), second.close()])
    }
  })
})
