import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const db = useTempDatabase('mac-agents-')
process.env.MAC_DATA_DIR = db.dir
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { AgentProfilesService, AGENT_TEMPLATES, assignAgents, bestProfile, profileByName, profileMatches, profilesNamedIn } =await import('./agent-profiles.service.js')

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
    expect(profileMatches(profile, { category: 'test', title: '', goal: '', files: [] })).toBe(10)
    expect(profileMatches(profile, { category: 'general', title: 'Add a vitest for Badge', goal: '', files: ['src/components/Badge.test.tsx'] })).toBeGreaterThanOrEqual(3)
    expect(profileMatches(profile, { category: 'general', title: 'Update README', goal: 'docs', files: ['README.md'] })).toBe(0)
    expect(profileMatches({ categories: [] }, { category: 'general', title: 'x', goal: '', files: [] })).toBe(0)
  })
})

describe('agent assignment helpers', () => {
  type Profile = Parameters<typeof bestProfile>[0][number]
  const profile = (template: (typeof AGENT_TEMPLATES)[number], extra: Partial<Profile> = {}): Profile =>
    ({ id: template.id, name: template.name, enabled: true, role: 'coder', projectId: null, priority: template.priority ?? 0, categories: template.categories ?? [], ...extra }) as Profile
  const profiles = AGENT_TEMPLATES.map((template) => profile(template))
  const task = { agent: '', category: 'react-ui', title: 'Button anlegen', description: 'x', relevantFiles: [] as string[], newFiles: [] as string[] }
  const idOf = (entry: { id: string } | undefined) => entry?.id

  it('treats a planner category as a hit via its alias', () => {
    const frontend = profiles.find((entry) => entry.id === 'frontend')!
    expect(profileMatches(frontend, { category: 'react-ui', title: '', goal: '', files: [] })).toBe(10)
  })

  it('does not let frontend words outweigh a documentation category', () => {
    const picked = bestProfile(profiles, {
      category: 'documentation',
      title: 'Dashboard-Grundstruktur und Umsetzung dokumentieren',
      goal: 'Beschreibt die React Komponente, das Layout, CSS und den Button des Dashboards.',
      files: ['src/components/Dashboard.tsx', 'docs/dashboard.md'],
    })
    expect(picked?.name).toBe('Doku-Agent')
  })

  it('ranks a category hit above project agents and priority, project agents above global ones otherwise', () => {
    const [frontend, , tests, docs] = AGENT_TEMPLATES
    const docTask = { category: 'documentation', title: 'Layout dokumentieren', goal: '', files: [] }
    // a project agent with a keyword hit only, or a much higher priority, does not beat a global category hit
    expect(bestProfile([profile(frontend!, { projectId: 'p' }), profile(docs!)], docTask)?.id).toBe('docs')
    expect(bestProfile([profile(frontend!, { priority: 100 }), profile(docs!, { priority: -100 })], docTask)?.id).toBe('docs')
    // equal category hit: the project agent wins; keyword hits only: the project agent wins over a stronger global one
    expect(bestProfile([profile(docs!), profile(docs!, { id: 'mine', projectId: 'p' })], docTask)?.id).toBe('mine')
    const general = { category: 'general', title: 'Vitest Tests für den Button', goal: '', files: [] }
    expect(bestProfile([profile(tests!), profile(frontend!, { projectId: 'p' })], general)?.id).toBe('frontend')
  })

  it('finds names with spaces and regex characters', () => {
    const special = profile(AGENT_TEMPLATES[0]!, { id: 'special', name: 'C++ Agent (beta)' })
    expect(profilesNamedIn([special], 'Bitte den c++ agent (beta) nutzen').map(idOf)).toEqual(['special'])
    expect(profilesNamedIn([special], 'Bitte C Agent beta nutzen')).toEqual([])
  })

  it('prefers the planner choice (case-insensitive), ignores unknown names', () => {
    expect(idOf(assignAgents(profiles, [{ ...task, agent: 'test-agent' }], '')[0])).toBe('tests')
    expect(idOf(assignAgents(profiles, [{ ...task, agent: 'Ghost-Agent' }], '')[0])).toBe('frontend')
  })

  it('uses an agent named in the request only for a one-task plan naming exactly one agent', () => {
    const prompt = 'Lass den Doku-Agent die README schreiben'
    expect(idOf(assignAgents(profiles, [task], prompt)[0])).toBe('docs')
    expect(assignAgents(profiles, [task, task], prompt).map(idOf)).toEqual(['frontend', 'frontend'])
    expect(idOf(assignAgents(profiles, [task], 'Doku-Agent und Test-Agent sollen helfen')[0])).toBe('frontend')
  })

  it('assigns a mixed plan by category although the request names the Doku-Agent', () => {
    const prompt = 'Erstelle eine Grundstruktur für modernes Vibe Coding. Nutze den Skill "projekt-doku" und einen Doku-Agent.'
    const docTask = { ...task, category: 'documentation', title: 'Vibe-Coding-Einstieg', newFiles: ['docs/vibe-coding.md'] }
    expect(assignAgents(profiles, [docTask, task], prompt).map(idOf)).toEqual(['docs', 'frontend'])
  })

  it('prefers project profiles by name and ignores disabled ones', () => {
    const docs = AGENT_TEMPLATES.find((entry) => entry.id === 'docs')!
    const list = [profile(docs), profile(docs, { id: 'mine', projectId: 'p' }), profile(AGENT_TEMPLATES[0]!, { name: 'Off', enabled: false })]
    expect(profileByName(list, ' doku-agent ')?.id).toBe('mine')
    expect(profilesNamedIn(list, 'Doku-Agent bitte').map(idOf)).toEqual(['mine'])
    expect(profileByName(list, 'Off')).toBeUndefined()
    expect(profileByName(list, '')).toBeUndefined()
  })

  it('matches names as whole words including hyphens', () => {
    expect(profilesNamedIn(profiles, 'Der Doku-Agent schreibt').map(idOf)).toEqual(['docs'])
    expect(profilesNamedIn(profiles, 'Die Doku-Agenten schreiben')).toEqual([])
    expect(profilesNamedIn(profiles, 'Eine Doku-Agent-Vorlage nutzen')).toEqual([])
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
