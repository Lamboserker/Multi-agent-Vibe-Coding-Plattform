import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MCP_PRESETS, SKILL_CATALOG, WORKFLOW_BUNDLES } from '@multi-ai-coder/shared'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'
import { parseSkill, skillRelevance } from '../skills/skill-format.js'

const vault = vi.hoisted(() => new Map<string, string>())
vi.mock('../runtime/shell-bridge.js', () => ({
  shellAvailable: () => true,
  shellRequest: async (method: string, params: Record<string, string>) => {
    const key = `${params.scope}/${params.name}`
    if (method === 'secret:set') { vault.set(key, params.value!); return true }
    if (method === 'secret:get') return vault.get(key) ?? null
    if (method === 'secret:names') return { names: [...vault.keys()].filter((entry) => entry.startsWith(`${params.scope}/`)).map((entry) => entry.slice(params.scope!.length + 1)) }
    if (method === 'secret:delete') return vault.delete(key)
    throw new Error('Unsupported shell method')
  },
}))
const db = useTempDatabase('mac-integrations-')
process.env.MAC_DATA_DIR = db.dir
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
process.env.MAC_BUILTIN_SKILLS_DIR = path.join(repo, 'skills')
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { McpService } = await import('../mcp/mcp.service.js')
const { SkillsService } = await import('../skills/skills.service.js')
const { IntegrationsService, toolGroup } = await import('./integrations.service.js')
const { IntegrationsController } = await import('./integrations.controller.js')
const prisma = new PrismaService()
const events = new EventBusService()
const mcp = new McpService(prisma, events)
const skills = new SkillsService(prisma, events)
const service = new IntegrationsService(prisma, mcp, skills, events)
const controller = new IntegrationsController(service)
const script = path.join(repo, 'apps/api/src/mcp/testing/test-server.mjs')

async function waitPhase(id: string, phase: string) {
  let result = await service.job(id)
  for (let attempt = 0; attempt < 150 && result.phase !== phase; attempt++) {
    if (result.phase === 'failed' && phase !== 'failed') throw new Error(result.error ?? 'setup failed')
    await new Promise((resolve) => setTimeout(resolve, 25))
    result = await service.job(id)
  }
  expect(result.phase).toBe(phase)
  return result
}
async function testConnection(presetId: string) {
  const server = await mcp.create({ name: `test-${presetId}`, transport: 'stdio', command: process.execPath, args: [script], defaultPolicy: 'confirm', agents: [] })
  const job = await service.start(presetId, { reuseServerId: server.id })
  await waitPhase(job.id, 'approval')
  return { job, server }
}

beforeAll(async () => { await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined); await service.onModuleInit() })
afterAll(async () => { service.onApplicationShutdown(); await mcp.onApplicationShutdown(); await prisma.$disconnect(); db.cleanup() })

describe('shipped integrations catalog', () => {
  it('has exactly 30 presets, 40 real skills and 8 complete bundles', () => {
    expect(MCP_PRESETS).toHaveLength(30); expect(SKILL_CATALOG).toHaveLength(40); expect(WORKFLOW_BUNDLES).toHaveLength(8)
    for (const entries of [MCP_PRESETS, SKILL_CATALOG, WORKFLOW_BUNDLES]) expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
    for (const preset of MCP_PRESETS) {
      expect(preset.source).toMatch(/^https:\/\//); expect(preset.docs).toMatch(/^https:\/\//)
      expect(preset.platforms.length).toBeGreaterThan(0)
      if (preset.runtime) expect(preset.packageVersion).toMatch(/^\d+\.\d+\.\d+$/)
      for (const skillId of preset.skills) expect(SKILL_CATALOG.some((entry) => entry.id === skillId)).toBe(true)
    }
    for (const skill of SKILL_CATALOG) {
      const { meta, body } = parseSkill(readFileSync(path.join(repo, 'skills', skill.id, 'SKILL.md'), 'utf8'))
      expect(meta.name).toBe(skill.id); expect(meta.tools).toEqual(skill.tools)
      expect(meta.testTask).toBe(skill.testTask); expect(skillRelevance(meta, meta.testTask!)).toBeGreaterThan(0)
      expect(body).toContain(skill.output); expect(body.length).toBeGreaterThan(500)
    }
    for (const bundle of WORKFLOW_BUNDLES) {
      for (const id of [...bundle.required, ...bundle.optional]) expect(MCP_PRESETS.some((entry) => entry.id === id)).toBe(true)
      for (const id of bundle.skills) expect(SKILL_CATALOG.some((entry) => entry.id === id)).toBe(true)
    }
  })
  it('defaults only new bundled skills to disabled, preserves explicit state', async () => {
    expect((await skills.find('builtin:browser-control')).enabled).toBe(false)
    expect((await skills.find('builtin:writing-tests')).enabled).toBe(true)
    await service.activateSkill('browser-control', true)
    expect((await skills.find('builtin:browser-control')).enabled).toBe(true)
    await service.activateSkill('browser-control', false)
    const catalog = await service.catalog()
    expect(catalog.skills.filter((entry) => entry.enabled)).toHaveLength(0)
  })
})

describe('persistent setup with real SDK subprocesses', () => {
  it('reuses an explicit server, deduplicates clicks and grants exact tools only', async () => {
    const server = await mcp.create({ name: 'user-playwright', transport: 'stdio', command: process.execPath, args: [script], defaultPolicy: 'confirm', agents: ['chat'], toolPolicies: { echo: 'allow' } })
    const [a, b] = await Promise.all([service.start('playwright', { reuseServerId: server.id }), service.start('playwright', { reuseServerId: server.id })])
    expect(a.id).toBe(b.id)
    const details = await waitPhase(a.id, 'approval')
    expect(details.tools.find((entry) => entry.name === 'drop_table')?.group).toBe('write')
    await service.approve(a.id, ['coder'], ['add'])
    const current = await mcp.get(server.id)
    expect(current.toolPolicies).toEqual({ echo: 'allow', add: 'allow' })
    expect(current.defaultPolicy).toBe('confirm'); expect(current.agents).toEqual(['chat', 'coder'])
    expect((await service.job(a.id)).phase).toBe('ready')
    const tools = await mcp.agentTools('coder', 'add')
    expect(tools.some((entry) => entry.name === 'mcp_catalog-playwright_add')).toBe(true)
    expect(tools.some((entry) => entry.name.endsWith('_drop_table'))).toBe(false)
    const add = tools.find((entry) => entry.name === 'mcp_catalog-playwright_add')!
    expect(await add.execute({ a: 2, b: 3 })).toBe('5')
    await mcp.update(server.id, { agents: [] })
    await expect(add.executeContent!({ a: 2, b: 3 })).rejects.toThrow(/assigned/)
    await mcp.update(server.id, { agents: ['coder', 'chat'] })
  })
  it('rejects changed schemas and requires a new test before approval', async () => {
    const { job, server } = await testConnection('chrome-devtools')
    const original = mcp.tools.bind(mcp)
    const spy = vi.spyOn(mcp, 'tools').mockImplementation(async (...args) => (await original(...args)).map((tool) => tool.name === 'add' ? { ...tool, inputSchema: { type: 'object', required: ['different'] } } : tool))
    await expect(service.approve(job.id, ['coder'], ['add'])).rejects.toThrow(/geändert/)
    expect((await service.job(job.id)).phase).toBe('failed')
    expect((await mcp.get(server.id)).toolPolicies).toEqual({})
    spy.mockRestore()
    await service.resume(job.id)
    await waitPhase(job.id, 'approval')
    await service.approve(job.id, ['chat'], ['add'])
  })
  it('stops at missing dependencies and retries without duplicate servers', async () => {
    const spy = vi.spyOn(service.runtime, 'check').mockImplementation(async (id) => ({ id, label: id, available: false, installable: true, instruction: 'install' }))
    const first = await service.start('memory', { installServer: false })
    const failed = await waitPhase(first.id, 'failed')
    expect(failed.error).toContain('fehlt')
    expect(await prisma.integrationInstallation.findUnique({ where: { presetId: 'memory' } })).toBeNull()
    spy.mockRestore()
  })
  it('cancels an active installation and keeps cancellation after a late return', async () => {
    let entered = false
    const check = vi.spyOn(service.runtime, 'check').mockImplementation(async (id) => ({ id, label: id, available: true, installable: false, instruction: '' }))
    const install = vi.spyOn(service.runtime, 'installPackage').mockImplementation(async (_preset, signal) => { entered = true; await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) })
    const job = await service.start('sequential-thinking')
    await vi.waitFor(() => expect(entered).toBe(true))
    await service.cancel(job.id)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect((await service.job(job.id)).phase).toBe('cancelled')
    check.mockRestore(); install.mockRestore()
  })
  it('stores credentials only in the vault and pauses for OAuth', async () => {
    const offline = vi.spyOn(mcp, 'tools').mockRejectedValue(new Error('Offline fixture'))
    const github = await service.start('github', { values: { token: 'never-store-this-token' } })
    await waitPhase(github.id, 'failed') // No outbound account access is needed to assert storage.
    const record = await prisma.integrationSetupJob.findUniqueOrThrow({ where: { id: github.id } })
    expect(JSON.stringify(record)).not.toContain('never-store-this-token')
    expect(vault.get(`mcp:${record.serverId}/token`)).toBe('never-store-this-token')
    offline.mockRestore()
    const remote = await service.start('higgsfield')
    await waitPhase(remote.id, 'authentication')
    const reopened = new IntegrationsService(prisma, mcp, skills, events)
    await reopened.onModuleInit()
    expect((await reopened.job(remote.id)).phase).toBe('authentication')
    await service.cancel(remote.id)
    expect((await service.job(remote.id)).phase).toBe('cancelled')
  }, 30_000)
  it('marks interrupted jobs failed on restart while retaining completed jobs', async () => {
    const interrupted = await prisma.integrationSetupJob.create({ data: { presetId: 'time', phase: 'installing', config: { values: {} } } })
    await service.onModuleInit()
    expect((await service.job(interrupted.id)).phase).toBe('failed')
    expect((await service.catalog()).jobs.some((entry) => entry.presetId === 'playwright' && entry.phase === 'ready')).toBe(true)
  })
  it('activates shared skills via packages without changing existing permissions', async () => {
    await testConnection('context7').then(async ({ job }) => service.approve(job.id, ['coder'], ['add']))
    await service.activateBundle('web')
    await service.activateBundle('browser-qa')
    expect((await skills.find('builtin:browser-control')).enabled).toBe(true)
    await service.detachBundle('web')
    expect((await skills.find('builtin:browser-control')).enabled).toBe(true)
    expect((await service.catalog()).bundles.find((entry) => entry.id === 'browser-qa')?.active).toBe(true)
    await expect(service.activateBundle('research')).rejects.toThrow(/einrichten/)
  })
})

describe('validation and classification', () => {
  it('rejects arbitrary actions, non-local directories, unknown fields and embedded credentials', async () => {
    expect(() => controller.setup('memory', { command: 'arbitrary' })).toThrow(/Unbekanntes/)
    await expect(service.start('time', { install: ['arbitrary'] })).rejects.toThrow(/Installationsschritt/)
    await expect(service.start('filesystem', { values: { root: '../outside' } })).rejects.toThrow(/absolutes/)
    await expect(service.start('gitlab', { values: { endpoint: 'https://user:secret@example.test/mcp' } })).rejects.toThrow(/Zugangsdaten/)
    await expect(service.start('gitlab', { values: { endpoint: 'https://example.test/mcp?token=secret' } })).rejects.toThrow(/Zugangsdaten/)
    await expect(service.start('gitlab', { values: { unknown: 'x' } })).rejects.toThrow(/Unbekannter/)
  })
  it('classifies code and paid generation independently of navigation and reads', () => {
    const tool = (name: string) => ({ name, description: '', inputSchema: {} })
    expect(toolGroup('playwright', tool('browser_evaluate'))).toBe('code')
    expect(toolGroup('playwright', tool('browser_click'))).toBe('browser')
    expect(toolGroup('higgsfield', tool('generate_video'))).toBe('generate')
    expect(toolGroup('windows-mcp', tool('click'))).toBe('desktop')
  })
})
