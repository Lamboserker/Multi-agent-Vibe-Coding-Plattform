// End-to-end chain without any model call: OrchestratorService → Claude/Codex adapter arguments →
// per-call MCP configuration → session gateway → McpService → real stdio MCP server (official SDK).
// The CLI binaries are local stand-ins (MAC_CLAUDE_BINARY / MAC_CODEX_BINARY) that read the MCP
// configuration exactly as handed to the real CLI and call tools through the official SDK client.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const db = useTempDatabase('mac-orchestrator-mcp-')
process.env.MAC_DATA_DIR = db.dir
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { SettingsService } = await import('../runtime/settings.service.js')
const { McpService } = await import('./mcp.service.js')
const { OrchestratorService } = await import('../orchestration/orchestrator.service.js')
const { orchestratorFirstOutputs } = await import('@multi-ai-coder/engine')

const require = createRequire(import.meta.url)
const sdkClient = require.resolve('@modelcontextprotocol/sdk/client/index.js')
const sdkHttp = require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')
const dir = mkdtempSync(path.join(os.tmpdir(), 'mac-fake-cli-'))

/** Shared MCP-client part of both stand-ins: discover via search_tools, call via call_tool. */
const CLIENT = String.raw`
const { Client } = require(process.env.SDK_CLIENT)
const { StreamableHTTPClientTransport } = require(process.env.SDK_HTTP)
async function useGateway(url) {
  const client = new Client({ name: 'cli-stand-in', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  const listed = (await client.listTools()).tools.map((tool) => tool.name)
  const text = (result) => result.content[0].text
  const found = JSON.parse(text(await client.callTool({ name: 'search_tools', arguments: { query: process.env.FAKE_QUERY } })))
  const notAssigned = await client.callTool({ name: 'call_tool', arguments: { name: process.env.FAKE_FORBIDDEN, arguments: { a: 1, b: 1 } } })
  const target = found.find((tool) => tool.name.endsWith(process.env.FAKE_TOOL))
  const called = target ? text(await client.callTool({ name: 'call_tool', arguments: { name: target.name, arguments: {} } })) : 'not found'
  await client.close()
  return { listed, found: found.map((tool) => tool.name), called, forbiddenError: Boolean(notAssigned.isError) }
}
`

const FAKE_CLAUDE = CLIENT + String.raw`
const fs = require('fs')
const args = process.argv.slice(2)
let input = ''
process.stdin.on('data', (c) => (input += c)).on('end', async () => {
  const file = args[args.indexOf('--mcp-config') + 1]
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  const report = { args, config, ...(await useGateway(config.mcpServers.app.url)) }
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(report))
  const structured = { answer: report.called }
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  out({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'stand-in', tools: [] })
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '73' } } })
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: structured }] } })
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, result: 'done', session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 }, structured_output: structured })
})
`

const FAKE_CODEX = CLIENT + String.raw`
const fs = require('fs')
const args = process.argv.slice(2)
if (args[0] === 'mcp' && args[1] === 'list') { console.log(JSON.stringify([{ name: 'user_own_server', enabled: true }, { name: 'already_off', enabled: false }])); process.exit(0) }
let input = ''
process.stdin.on('data', (c) => (input += c)).on('end', async () => {
  const urlArg = args.find((arg) => arg.startsWith('mcp_servers.app.url='))
  const report = { args, ...(await useGateway(JSON.parse(urlArg.slice('mcp_servers.app.url='.length)))) }
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(report))
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  out({ type: 'thread.started', thread_id: 'thread-1' })
  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: JSON.stringify({ answer: report.called }) } })
  out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })
})
`

function standIn(name: string, source: string) {
  writeFileSync(path.join(dir, `${name}.cjs`), source)
  if (process.platform === 'win32') {
    const binary = path.join(dir, `${name}.cmd`)
    writeFileSync(binary, `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`)
    return binary
  }
  const binary = path.join(dir, name)
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.cjs" "$@"\n`, { mode: 0o755 })
  return binary
}

const prisma = new PrismaService()
const events = new EventBusService()
const settings = new SettingsService(prisma, events)
const mcp = new McpService(prisma, events)
const orchestrators = new OrchestratorService(settings, events, mcp)
const testServer = path.join(here, 'testing', 'test-server.mjs')
const saved = { ...process.env }

beforeAll(async () => {
  await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
  mcp.onModuleInit()
  // assigned to chat: magic_number allowed; assigned to coder only: must stay invisible for chat
  await mcp.create({ name: 'config', transport: 'stdio', command: process.execPath, args: [testServer], agents: ['chat'], defaultPolicy: 'off', toolPolicies: { magic_number: 'allow' } })
  await mcp.create({ name: 'coderonly', transport: 'stdio', command: process.execPath, args: [testServer], agents: ['coder'], defaultPolicy: 'allow' })
  Object.assign(process.env, { MAC_CLAUDE_BINARY: standIn('claude', FAKE_CLAUDE), MAC_CODEX_BINARY: standIn('codex', FAKE_CODEX), SDK_CLIENT: sdkClient, SDK_HTTP: sdkHttp, FAKE_QUERY: 'magic number add', FAKE_TOOL: 'magic_number', FAKE_FORBIDDEN: 'mcp_coderonly_add' })
})

afterAll(async () => {
  process.env = { ...saved }
  await mcp.onApplicationShutdown()
  await prisma.$disconnect()
  db.cleanup()
})

const input = { question: 'Wie lautet die Magic Number?', context: { summary: 'repo', relevantFiles: [], validationCommands: [] } }

describe('MCP for the main orchestrators (no model call)', () => {
  it('Claude Code: --mcp-config with only the session gateway, strict mode, assigned tools only', async () => {
    process.env.FAKE_LOG = path.join(dir, 'claude.json')
    const adapter = await orchestrators.adapter('claude-code')
    const { result } = await adapter.chat(input, { runId: 'chat-claude', cwd: dir })
    expect(result.answer).toBe('7341')
    const report = JSON.parse(readFileSync(process.env.FAKE_LOG, 'utf8'))
    expect(report.args).toContain('--strict-mcp-config')
    // time to first token comes from the streamed text delta
    expect(orchestratorFirstOutputs.filter((entry) => entry.orchestrator === 'claude').at(-1)).toMatchObject({ kind: 'token' })
    expect(Object.keys(report.config.mcpServers)).toEqual(['app'])
    expect(report.config.mcpServers.app.type).toBe('http')
    // the orchestrator sees three small tools, not the upstream schemas
    expect(report.listed).toEqual(['search_tools', 'call_tool', 'read_result'])
    expect(report.found).toEqual(['mcp_config_magic_number'])
    expect(report.forbiddenError).toBe(true)
    const logs = (await mcp.get((await mcp.list()).find((server) => server.name === 'config')!.id)).logs.map((line) => line.message)
    expect(logs.some((line) => line.startsWith('agent call magic_number'))).toBe(true)
  }, 60_000)

  it('Codex: per-call -c overrides, user servers and Codex plugins disabled, global config untouched', async () => {
    process.env.FAKE_LOG = path.join(dir, 'codex.json')
    const adapter = await orchestrators.adapter('codex')
    const { result } = await adapter.chat(input, { runId: 'chat-codex', cwd: dir })
    expect(result.answer).toBe('7341')
    const report = JSON.parse(readFileSync(process.env.FAKE_LOG, 'utf8'))
    const pairs = report.args.flatMap((arg: string, index: number) => (report.args[index - 1] === '-c' ? [arg] : []))
    expect(report.args).toEqual(expect.arrayContaining(['--disable', 'plugins']))
    expect(orchestratorFirstOutputs.filter((entry) => entry.orchestrator === 'codex').at(-1)).toMatchObject({ kind: 'event' })
    expect(pairs).toContain('mcp_servers.user_own_server.enabled=false')
    expect(pairs).not.toContain('mcp_servers.already_off.enabled=false')
    expect(pairs).toContain('mcp_servers.app.enabled_tools=["search_tools","call_tool","read_result"]')
    // pre-approved (codex exec uses approval policy "never"); only the gateway tools, only this server
    for (const tool of ['search_tools', 'call_tool', 'read_result']) expect(pairs).toContain(`mcp_servers.app.tools.${tool}.approval_mode="approve"`)
    expect(pairs.filter((pair: string) => pair.includes('approval_mode'))).toHaveLength(3)
    expect(report.found).toEqual(['mcp_config_magic_number'])
    expect(report.forbiddenError).toBe(true)
  }, 60_000)

  it('the gateway is closed after the call (no lingering endpoint)', async () => {
    const report = JSON.parse(readFileSync(path.join(dir, 'claude.json'), 'utf8'))
    await expect(fetch(report.config.mcpServers.app.url, { method: 'POST', body: '{}' })).rejects.toThrow()
  })
})
