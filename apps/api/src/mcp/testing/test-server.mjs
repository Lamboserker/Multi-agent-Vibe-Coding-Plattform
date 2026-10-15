// MCP test server (official SDK). Run directly for stdio: `node test-server.mjs`; imported by tests
// for the Streamable HTTP transport.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

export function buildServer() {
  const server = new McpServer({ name: 'mac-test-server', version: '1.2.3' })
  server.registerTool('echo', { description: 'Returns the given text.', inputSchema: { text: z.string().describe('Text to return') } }, async ({ text }) => ({ content: [{ type: 'text', text }] }))
  server.registerTool(
    'add',
    { description: 'Adds two numbers.', inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  )
  server.registerTool('magic_number', { description: 'Returns the magic number of the project configuration service.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: '7341' }] }))
  server.registerTool('drop_table', { description: 'Deletes a table.', inputSchema: { table: z.string() }, annotations: { destructiveHint: true } }, async ({ table }) => ({ content: [{ type: 'text', text: `dropped ${table}` }] }))
  server.registerTool('slow', { description: 'Waits.', inputSchema: { ms: z.number() } }, async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return { content: [{ type: 'text', text: `waited ${ms}` }] }
  })
  server.registerTool('big', { description: 'Returns a large text.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'x'.repeat(50_000) }] }))
  server.registerTool('fail', { description: 'Returns a tool error.', inputSchema: {} }, async () => ({ isError: true, content: [{ type: 'text', text: 'something went wrong' }] }))
  server.registerTool('secret_env', { description: 'Tells whether TEST_TOKEN is set.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: process.env.TEST_TOKEN ? `token:${process.env.TEST_TOKEN.length}` : 'no token' }] }))
  server.registerTool('crash', { description: 'Exits the server process.', inputSchema: {} }, async () => {
    setTimeout(() => process.exit(1), 20)
    return { content: [{ type: 'text', text: 'bye' }] }
  })
  return server
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await buildServer().connect(new StdioServerTransport())
  console.error('mac-test-server ready (stdio)')
}
