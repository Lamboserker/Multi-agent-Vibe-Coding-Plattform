import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const db = useTempDatabase('mac-agents-')
process.env.MAC_DATA_DIR = db.dir
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { AgentProfilesService, profileMatches } = await import('./agent-profiles.service.js')

const prisma = new PrismaService()
const service = new AgentProfilesService(prisma, new EventBusService())
let projectId = ''

beforeAll(async () => {
  await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
  projectId = (await prisma.project.create({ data: { name: 'agents', repoPath: db.dir } })).id
})

afterAll(async () => {
  await prisma.$disconnect()
  db.cleanup()
})

describe('profileMatches', () => {
  it('scores category, words in title/description and file paths', () => {
    const profile = { categories: ['test', 'vitest', 'components'] }
    expect(profileMatches(profile, { category: 'test', title: '', goal: '', files: [] })).toBe(3)
    expect(profileMatches(profile, { category: 'general', title: 'Add a vitest for Badge', goal: '', files: ['src/components/Badge.test.tsx'] })).toBeGreaterThanOrEqual(3)
    expect(profileMatches(profile, { category: 'general', title: 'Update README', goal: 'docs', files: ['README.md'] })).toBe(0)
    expect(profileMatches({ categories: [] }, { category: 'general', title: 'x', goal: '', files: [] })).toBe(0)
  })
})

describe('AgentProfilesService', () => {
  it('creates agents from templates and picks the best match (project agents first)', async () => {
    const tests = await service.createFromTemplate('tests')
    const docs = await service.createFromTemplate('docs')
    expect(tests).toMatchObject({ name: 'Test-Agent', escalation: 'local', maxRepairs: 3, template: 'tests' })
    expect(docs.mcpServers).toEqual([])
    expect((await service.match(projectId, { category: 'general', title: 'Tests für den Login ergänzen', goal: 'Vitest-Tests schreiben', files: [] }))?.id).toBe(tests.id)
    expect((await service.match(projectId, { category: 'general', title: 'README aktualisieren', goal: '', files: ['README.md'] }))?.id).toBe(docs.id)
    expect(await service.match(projectId, { category: 'general', title: 'Fix the router', goal: '', files: ['src/router.ts'] })).toBeUndefined()
    // a project-specific agent with the same keywords wins over the global one
    const projectTests = await service.create({ name: 'Projekt-Tests', projectId, categories: ['test', 'tests'], escalation: 'none' })
    expect((await service.match(projectId, { category: 'test', title: 'x', goal: '', files: [] }))?.id).toBe(projectTests.id)
    // disabled agents are skipped
    await service.update(projectTests.id, { enabled: false })
    expect((await service.match(projectId, { category: 'test', title: 'x', goal: '', files: [] }))?.id).toBe(tests.id)
    expect(service.toAssignment(tests)).toEqual({ id: tests.id, name: 'Test-Agent', escalation: 'local', maxSteps: undefined, maxRepairs: 3, instructions: expect.stringContaining('deterministic'), mcpServers: ['*'], maxContextTokens: undefined, permissions: {}, resources: {} })
  })

  it('stores context budget, permissions and resource limits and hands them to the engine', async () => {
    const limited = await service.create({ name: 'Begrenzt', maxContextTokens: 8192, permissions: { read: true, write: false, externalTools: false }, resources: { timeoutMs: 60_000, maxFiles: 3, maxWriteBytes: 10_000, maxOutputTokens: 2000 } })
    expect(service.toAssignment(limited)).toMatchObject({ maxContextTokens: 8192, permissions: { read: true, write: false, externalTools: false }, resources: { timeoutMs: 60_000, maxFiles: 3, maxWriteBytes: 10_000, maxOutputTokens: 2000 } })
    await expect(service.create({ name: 'x', maxContextTokens: 10 })).rejects.toThrow(/context/)
    await expect(service.create({ name: 'x', permissions: { delete: true } as never })).rejects.toThrow(/permissions/)
    await expect(service.create({ name: 'x', resources: { maxFiles: -1 } })).rejects.toThrow(/resource/)
  })

  it('validates input and unassigns deleted agents from planned subtasks', async () => {
    await expect(service.create({ name: '' })).rejects.toThrow(/Name/)
    await expect(service.create({ name: 'x', escalation: 'always' as never })).rejects.toThrow(/Escalation/)
    await expect(service.create({ name: 'x', maxSteps: 500 })).rejects.toThrow(/maxSteps/)
    const agent = await service.create({ name: 'Temp', categories: ['temp'] })
    const task = await prisma.task.create({ data: { projectId, userPrompt: 't' } })
    const subtask = await prisma.subtask.create({ data: { taskId: task.id, title: 's', goal: 'g', status: 'planned', expectedChange: 'x', assignedAgentType: 'LocalCoderAgent', selectedModelClass: 'local_llm', agentId: agent.id } })
    await service.remove(agent.id)
    expect((await prisma.subtask.findUniqueOrThrow({ where: { id: subtask.id } })).agentId).toBeNull()
  })
})
