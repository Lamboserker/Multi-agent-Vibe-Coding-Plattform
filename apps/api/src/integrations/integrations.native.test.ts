// Opt-in package smoke tests. No models, accounts or OS-level dependency installers are invoked.
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const enabled = process.env.MAC_TEST_INTEGRATIONS_NATIVE === '1'
describe.skipIf(!enabled)('native integration packages (isolated app data)', () => {
  const db = useTempDatabase('mac-native-integrations-')
  process.env.MAC_DATA_DIR = db.dir
  let prisma: import('../common/prisma.service.js').PrismaService
  let mcp: import('../mcp/mcp.service.js').McpService
  let service: import('./integrations.service.js').IntegrationsService
  beforeAll(async () => {
    const [{ PrismaService }, { McpService }, { SkillsService }, { IntegrationsService }, { EventBusService }, { applyMigrations }] = await Promise.all([import('../common/prisma.service.js'), import('../mcp/mcp.service.js'), import('../skills/skills.service.js'), import('./integrations.service.js'), import('../runtime/event-bus.service.js'), import('../runtime/migrator.js')])
    prisma = new PrismaService()
    await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
    const events = new EventBusService()
    mcp = new McpService(prisma, events)
    service = new IntegrationsService(prisma, mcp, new SkillsService(prisma, events), events)
  })
  afterAll(async () => { service?.onApplicationShutdown(); await mcp?.onApplicationShutdown(); await prisma?.$disconnect(); db.cleanup() })
  async function setup(id: string) {
    const job = await service.start(id)
    const until = Date.now() + 180_000
    while (Date.now() < until) {
      const current = await service.job(job.id)
      if (current.phase === 'failed') throw new Error(current.error ?? 'setup failed')
      if (current.phase === 'approval') return current
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('Package setup timed out')
  }
  it('installs pinned Playwright, navigates a local target and returns a real screenshot', async (context) => {
    if (!(await service.check('playwright')).valid) { context.skip(); return }
    const launch = service.runtime.launch.bind(service.runtime)
    const headless = vi.spyOn(service.runtime, 'launch').mockImplementation(async (preset) => { const result = await launch(preset); return { ...result, args: [...result.args, '--headless'] } })
    const target = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="de"><head><title>MCP-Test</title></head><body><h1>Lokales MCP-Testziel</h1><button onclick="this.textContent=\'Geprüft\'">Prüfen</button></body></html>') })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    try {
      const job = await setup('playwright')
      const serverId = job.serverId!
      const tools = await mcp.tools(serverId)
      expect(tools.some((tool) => tool.name === 'browser_navigate')).toBe(true)
      const { port } = target.address() as { port: number }
      const navigation = await mcp.callTool(serverId, 'browser_navigate', { url: `http://127.0.0.1:${port}` })
      expect(navigation.isError).toBe(false)
      expect(navigation.text).toContain('MCP-Test')
      const snapshot = await mcp.callTool(serverId, 'browser_snapshot', {})
      expect(snapshot.text).toContain('Lokales MCP-Testziel')
      const screenshot = await mcp.callTool(serverId, 'browser_take_screenshot', { type: 'png' }, { source: 'manual', includeContent: true })
      expect(screenshot.isError).toBe(false)
      expect((screenshot.content as Array<{ type: string }>).some((block) => block.type === 'image')).toBe(true)
    } finally { headless.mockRestore(); target.close() }
  }, 240_000)
  it.skipIf(process.platform !== 'win32')('installs pinned Windows-MCP and completes the SDK handshake', async (context) => {
    if (!(await service.check('windows-mcp')).valid) { context.skip(); return }
    const job = await setup('windows-mcp')
    expect(job.tools.length).toBeGreaterThan(0)
    expect((await mcp.health(job.serverId!)).ok).toBe(true)
  }, 240_000)
  it('checks an existing Blender installation without installing the application', async (context) => {
    if (!(await service.check('blender')).valid) { context.skip(); return }
    const job = await setup('blender')
    expect(job.tools.length).toBeGreaterThan(0)
  }, 240_000)
})
