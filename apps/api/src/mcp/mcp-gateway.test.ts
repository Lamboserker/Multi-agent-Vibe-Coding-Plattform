import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openMcpGateway } from './mcp-gateway.js'

describe('session MCP gateway (real SDK HTTP connection)', () => {
  it('returns actual image blocks, preserves error status and pages rich text', async () => {
    let allowed = true
    const image = { type: 'image' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', mimeType: 'image/png' }
    const gateway = await openMcpGateway(async () => allowed ? [{ name: 'render', description: 'render', parameters: { type: 'object' }, execute: async () => 'text fallback', executeContent: async () => ({ isError: true, content: [{ type: 'text' as const, text: 'x'.repeat(13_000) }, image] }) }] : [])
    const client = new Client({ name: 'vision-test', version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url)))
      const result = await client.callTool({ name: 'call_tool', arguments: { name: 'render', arguments: {} } })
      expect(result.isError).toBe(true)
      const blocks = result.content as Array<Record<string, unknown>>
      expect(blocks[1]).toEqual(image)
      const page = JSON.parse(String(blocks[0]!.text))
      expect(page.text).toHaveLength(12_000)
      const tail = await client.callTool({ name: 'read_result', arguments: { reference: page.reference, offset: page.nextOffset } })
      expect(JSON.parse((tail.content as Array<{ text: string }>)[0]!.text).text).toHaveLength(1000)
      allowed = false
      expect((await client.callTool({ name: 'call_tool', arguments: { name: 'render', arguments: {} } })).isError).toBe(true)
    } finally { await client.close(); await gateway.close() }
  })
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
