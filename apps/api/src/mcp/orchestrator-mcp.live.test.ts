// LIVE: one real model call each through Claude Code and Codex (uses the user's subscriptions).
// Runs ONLY with MAC_LIVE_PREMIUM_MCP=claude, =codex or =both — never in the normal test run.
// Proves that the real CLI, configured exactly like the app does it, discovers an assigned tool via
// search_tools and calls it via call_tool on a real stdio MCP server (magic_number → 7341).
// Global CLI configuration is not changed: Claude gets --mcp-config/--strict-mcp-config for this call,
// Codex gets -c overrides for this call.
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const which = process.env.MAC_LIVE_PREMIUM_MCP ?? ''
const here = path.dirname(fileURLToPath(import.meta.url))
const db = useTempDatabase('mac-live-mcp-')
process.env.MAC_DATA_DIR = db.dir
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { SettingsService } = await import('../runtime/settings.service.js')
const { McpService } = await import('./mcp.service.js')
const { OrchestratorService } = await import('../orchestration/orchestrator.service.js')
const { orchestratorFirstOutputs } = await import('@multi-ai-coder/engine')

const prisma = new PrismaService()
const events = new EventBusService()
const mcp = new McpService(prisma, events)
const orchestrators = new OrchestratorService(new SettingsService(prisma, events), events, mcp)
const cwd = mkdtempSync(path.join(os.tmpdir(), 'mac-live-mcp-cwd-'))
let serverId = ''

beforeAll(async () => {
  if (!which) return
  await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
  mcp.onModuleInit()
  serverId = (await mcp.create({ name: 'config', transport: 'stdio', command: process.execPath, args: [path.join(here, 'testing', 'test-server.mjs')], agents: ['chat'], defaultPolicy: 'off', toolPolicies: { magic_number: 'allow' } })).id
})

afterAll(async () => {
  await mcp.onApplicationShutdown()
  await prisma.$disconnect()
  db.cleanup()
})

const question = 'Use your MCP tools: call search_tools with the query "magic number", then call_tool with the tool it returns (arguments {}). Answer with the number the tool returned and nothing else.'
const input = { question, context: { summary: 'Test repository without files.', relevantFiles: [], validationCommands: [] } }

describe.each([['claude-code', 'claude'], ['codex', 'codex']] as const)('LIVE %s: real MCP tool call through the session gateway', (id, key) => {
  it.skipIf(which !== key && which !== 'both')('answers 7341 from the real MCP tool', async () => {
    const adapter = await orchestrators.adapter(id)
    const { result, meta } = await adapter.chat(input, { runId: `live-${key}`, cwd, timeoutMs: 5 * 60_000 })
    console.log(`[live:${key}]`, JSON.stringify({ answer: result.answer, durationMs: meta.durationMs, usage: meta.usage, firstOutput: orchestratorFirstOutputs.at(-1) }))
    expect(result.answer).toContain('7341')
    const logs = (await mcp.get(serverId)).logs.map((line) => line.message)
    expect(logs.some((line) => line.startsWith('agent call magic_number'))).toBe(true)
  }, 6 * 60_000)
})
