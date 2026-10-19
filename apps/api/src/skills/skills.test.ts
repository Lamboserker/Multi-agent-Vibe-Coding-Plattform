import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'
import { parseSkill, renderSkill, skillRelevance } from './skill-format.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const db = useTempDatabase('mac-skills-')
process.env.MAC_DATA_DIR = db.dir
process.env.MAC_BUILTIN_SKILLS_DIR = path.resolve(here, '../../../../skills')
const { PrismaService } = await import('../common/prisma.service.js')
const { applyMigrations } = await import('../runtime/migrator.js')
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { SkillsService } = await import('./skills.service.js')
const { AgentResourcesService } = await import('../agents/agent-resources.service.js')

const prisma = new PrismaService()
const service = new SkillsService(prisma, new EventBusService())
const repo = mkdtempSync(path.join(os.tmpdir(), 'mac-skills-repo-'))
let projectId = ''

beforeAll(async () => {
  await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'Add login form'], { cwd: repo })
  // a project skill in the compatibility folder .claude/skills
  mkdirSync(path.join(repo, '.claude', 'skills', 'deploy'), { recursive: true })
  writeFileSync(path.join(repo, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: How to deploy this service.\ntriggers:\n  - deploy\n  - rollout\n---\nRun `make deploy` and watch the health check.\n')
  writeFileSync(path.join(repo, '.claude', 'skills', 'deploy', 'checklist.md'), '- tag the release\n')
  mkdirSync(path.join(repo, '.claude', 'skills', 'broken'), { recursive: true })
  writeFileSync(path.join(repo, '.claude', 'skills', 'broken', 'SKILL.md'), 'no front matter')
  projectId = (await prisma.project.create({ data: { name: 'skills', repoPath: repo } })).id
})

afterAll(async () => {
  await prisma.$disconnect()
  db.cleanup()
})

describe('SKILL.md format', () => {
  it('parses front matter (inline and block lists) and round-trips', () => {
    const parsed = parseSkill('---\nname: my-skill\ndescription: "Does: things"\ntriggers: [Foo, bar baz]\n---\n# Body\ntext')
    expect(parsed.meta).toEqual({ name: 'my-skill', description: 'Does: things', triggers: ['foo', 'bar baz'], version: undefined, tools: [], allowedActions: [], resources: [], testTask: '' })
    expect(parsed.body).toBe('# Body\ntext')
    expect(parseSkill(renderSkill(parsed.meta, parsed.body))).toEqual(parsed)
    // builder fields survive a round trip (URLs with ":" and commas in the test task included)
    const full = { name: 'release', description: 'Release notes.', triggers: ['release'], version: '1.2.0', tools: ['load_skill', 'mcp_*'], allowedActions: ['notes.mjs'], resources: ['notes.md', 'https://example.com/a,b'], testTask: 'Prepare the release notes: v2, with highlights' }
    expect(parseSkill(renderSkill(full, 'Body')).meta).toEqual(full)
    expect(() => parseSkill('---\nname: Bad Name\ndescription: x\n---\n')).toThrow(/name/)
    expect(() => parseSkill('---\nname: ok\n---\n')).toThrow(/description/)
  })

  it('scores relevance by triggers and name parts', () => {
    const meta = { name: 'writing-tests', description: '', triggers: ['vitest', 'release notes'] }
    expect(skillRelevance(meta, 'Add vitest coverage')).toBe(2)
    expect(skillRelevance(meta, 'write the release notes')).toBe(2)
    expect(skillRelevance(meta, 'Fix the tests for login')).toBe(1)
    expect(skillRelevance(meta, 'Refactor the router')).toBe(0)
  })
})

describe('SkillsService', () => {
  it('discovers built-in, user and project skills (including .claude/skills) and reports broken ones', async () => {
    const skills = await service.list(projectId)
    const keys = skills.map((skill) => skill.key)
    expect(keys).toEqual(expect.arrayContaining(['builtin:writing-tests', 'builtin:code-review', 'builtin:changelog', `project:${projectId}:deploy`]))
    const deploy = skills.find((skill) => skill.name === 'deploy')!
    expect(deploy).toMatchObject({ source: 'project', location: '.claude/skills', triggers: ['deploy', 'rollout'], files: ['checklist.md'], enabled: true, editable: true })
    expect(skills.find((skill) => skill.name === 'broken')!.error).toMatch(/front matter/)
    expect(skills.find((skill) => skill.name === 'changelog')).toMatchObject({ scripts: ['scripts/recent-changes.mjs'], scriptsApproved: false, editable: false })
  })

  it('creates, edits and deletes skills with the builder', async () => {
    const created = await service.create({ scope: 'user', meta: { name: 'api-style', description: 'REST conventions of the team.', triggers: ['endpoint', 'rest'] }, body: '# API style\nUse plural nouns.' })
    expect(created).toMatchObject({ key: 'user:api-style', source: 'user', triggers: ['endpoint', 'rest'] })
    await expect(service.create({ scope: 'user', meta: { name: 'api-style', description: 'x', triggers: [] }, body: 'x' })).rejects.toThrow(/exists/)
    const updated = await service.update('user:api-style', { meta: { name: 'api-style', description: 'REST conventions.', triggers: ['endpoint'] }, body: 'Use plural nouns and kebab-case.' })
    expect(updated.triggers).toEqual(['endpoint'])
    expect((await service.get('user:api-style')).body).toBe('Use plural nouns and kebab-case.')
    await expect(service.update('builtin:code-review', { meta: { name: 'code-review', description: 'x', triggers: [] }, body: 'x' })).rejects.toThrow(/cannot be edited/)
    const project = await service.create({ scope: 'project', projectId, meta: { name: 'db-migrations', description: 'How to write migrations.', triggers: ['migration'] }, body: 'Only additive migrations.' })
    expect(project.location).toBe('.multi-ai-coder/skills')
    expect(existsSync(path.join(repo, '.multi-ai-coder', 'skills', 'db-migrations', 'SKILL.md'))).toBe(true)
    await service.remove(project.key)
    expect(existsSync(path.join(repo, '.multi-ai-coder', 'skills', 'db-migrations'))).toBe(false)
  })

  it('builds progressive context: matching skills inlined, the rest as an index with load_skill', async () => {
    const context = await service.promptContext('coder', projectId, 'Add a vitest test for the login endpoint', { canLoad: true })
    expect(context.inlined).toEqual(expect.arrayContaining(['writing-tests', 'api-style']))
    expect(context.text).toContain('### Skill: writing-tests')
    expect(context.text).toContain('Use plural nouns')
    expect(context.indexed).toEqual(expect.arrayContaining(['deploy', 'code-review']))
    expect(context.requiresSkillLoad).toBe(false)
    const bounded = await service.promptContext('coder', projectId, 'Add a vitest test for the login endpoint', { canLoad: true, budgetChars: 1 })
    expect(bounded.requiresSkillLoad).toBe(true)
    expect(bounded.indexed).toContain('writing-tests')
    expect(context.text).toContain('- deploy: How to deploy this service.')
    // without tools (structured models) only the inlined part is given
    expect((await service.promptContext('coder', projectId, 'Add a vitest test', { canLoad: false })).text).not.toContain('load_skill')
    const tools = await service.agentTools('coder', projectId, repo)
    const load = tools.find((tool) => tool.name === 'load_skill')!
    expect(await load.execute({ name: 'deploy' })).toContain('make deploy')
    expect(await load.execute({ name: 'deploy' })).toContain('checklist.md')
    expect(await tools.find((tool) => tool.name === 'read_skill_file')!.execute({ skill: 'deploy', path: 'checklist.md' })).toContain('tag the release')
    await expect(tools.find((tool) => tool.name === 'read_skill_file')!.execute({ skill: 'deploy', path: '../../.git/config' })).rejects.toThrow()
    // scripts are not offered before approval
    expect(tools.some((tool) => tool.name === 'run_skill_script')).toBe(false)
  })

  it('respects enable state and role assignment', async () => {
    await service.updateState('builtin:writing-tests', { agents: ['planner'] })
    expect((await service.promptContext('coder', projectId, 'vitest', { canLoad: true })).inlined).not.toContain('writing-tests')
    expect((await service.promptContext('planner', projectId, 'vitest', { canLoad: false })).inlined).toContain('writing-tests')
    await service.updateState('builtin:writing-tests', { agents: ['*'], enabled: false })
    expect((await service.promptContext('planner', projectId, 'vitest', { canLoad: false })).inlined).not.toContain('writing-tests')
    await service.updateState('builtin:writing-tests', { enabled: true })
    await expect(service.updateState('builtin:writing-tests', { agents: ['hacker'] })).rejects.toThrow(/Agents must be/)
  })

  it('runs skill scripts only after approval, and a changed script revokes it', async () => {
    const userSkill = path.join(db.dir, 'skills', 'stats')
    mkdirSync(path.join(userSkill, 'scripts'), { recursive: true })
    writeFileSync(path.join(userSkill, 'SKILL.md'), '---\nname: stats\ndescription: Repository statistics.\n---\nRun the script.\n')
    writeFileSync(path.join(userSkill, 'scripts', 'count.mjs'), "console.log('files:' + process.argv.slice(2).join(','))\n")
    const skill = await service.find('user:stats')
    await expect(service.runScript(skill.key, 'scripts/count.mjs', [], repo)).rejects.toThrow(/not approved/)
    await expect(service.approveScripts(skill.key, 'wrong-hash')).rejects.toThrow(/changed/)
    await service.approveScripts(skill.key, skill.scriptsHash!)
    expect(await service.runScript(skill.key, 'scripts/count.mjs', ['a', 'b'], repo)).toContain('files:a,b')
    const tools = await service.agentTools('coder', projectId, repo)
    expect(tools.some((tool) => tool.name === 'run_skill_script')).toBe(true)
    // the shipped changelog script reads git history of the working copy
    const changelog = await service.find('builtin:changelog')
    await service.approveScripts(changelog.key, changelog.scriptsHash!)
    expect(await service.runScript(changelog.key, 'scripts/recent-changes.mjs', [], repo)).toContain('Add login form')
    // modifying a script invalidates the approval
    appendFileSync(path.join(userSkill, 'scripts', 'count.mjs'), "console.log('changed')\n")
    expect((await service.find('user:stats')).scriptsApproved).toBe(false)
    await expect(service.runScript('user:stats', 'scripts/count.mjs', [], repo)).rejects.toThrow(/not approved/)
    await expect(service.runScript('user:stats', '../SKILL.md', [], repo)).rejects.toThrow(/not a script/)
  })

  it('builder fields take effect: allowed actions limit scripts, tools/resources reach the agent, export, project activation, test task', async () => {
    const created = await service.create({ scope: 'user', meta: { name: 'release', description: 'How we write release notes.', triggers: ['release'], tools: ['load_skill', 'mcp_*'], allowedActions: ['notes.mjs'], resources: ['template.md', 'https://example.com/guide'], testTask: 'Write the release notes for v2' }, body: 'Use the template.' })
    const dir = path.join(db.dir, 'skills', 'release')
    mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    writeFileSync(path.join(dir, 'scripts', 'notes.mjs'), "console.log('notes ok')\n")
    writeFileSync(path.join(dir, 'scripts', 'publish.mjs'), "console.log('published')\n")
    writeFileSync(path.join(dir, 'template.md'), '## Highlights\n')
    const skill = await service.find(created.key)
    await service.approveScripts(skill.key, skill.scriptsHash!)
    // allowed actions: only notes.mjs may run, even though both scripts are approved
    expect(await service.runScript(skill.key, 'scripts/notes.mjs', [], repo)).toContain('notes ok')
    await expect(service.runScript(skill.key, 'scripts/publish.mjs', [], repo)).rejects.toThrow(/not an allowed action/)
    const runTool = (await service.agentTools('coder', projectId, repo, ['release'])).find((tool) => tool.name === 'run_skill_script')!
    expect(runTool.description).toContain('release (scripts/notes.mjs)')
    expect(runTool.description).not.toContain('publish')
    // tools, actions and resources are part of the instructions the agent gets
    const context = await service.promptContext('coder', projectId, 'prepare the release', { canLoad: true })
    expect(context.inlined).toContain('release')
    expect(context.text).toContain('Tools this skill uses: load_skill, mcp_*')
    expect(context.text).toContain('Resources (read_skill_file for files of the skill): template.md, https://example.com/guide')
    // export contains SKILL.md with all fields, resources and scripts
    const target = mkdtempSync(path.join(os.tmpdir(), 'mac-skill-export-'))
    const exported = await service.exportFolder(skill.key, target)
    expect(exported.files).toBe(4)
    const reparsed = parseSkill(readFileSync(path.join(exported.folder, 'SKILL.md'), 'utf8')).meta
    expect(reparsed).toMatchObject({ allowedActions: ['notes.mjs'], resources: ['template.md', 'https://example.com/guide'], testTask: 'Write the release notes for v2' })
    expect(readFileSync(path.join(exported.folder, 'template.md'), 'utf8')).toBe('## Highlights\n')
    // project activation: disabled for this project only
    await service.updateState(skill.key, { enabled: false, projectId })
    expect((await service.list(projectId)).find((entry) => entry.key === skill.key)!.enabled).toBe(false)
    expect((await service.list()).find((entry) => entry.key === skill.key)!.enabled).toBe(true)
    expect((await service.promptContext('coder', projectId, 'prepare the release', { canLoad: true })).inlined).not.toContain('release')
    await service.updateState(skill.key, { enabled: true, projectId })
    // test task: selection, resources, tools and actions are checked without a model call
    const resources = new AgentResourcesService(service, { agentTools: async () => [{ name: 'mcp_docs_search' }] } as never, { agentTools: async () => [] } as never)
    expect(await resources.testSkill(skill.key, projectId)).toMatchObject({ ok: true, role: 'coder', selection: 'inlined', missingResources: [], missingTools: [], unknownActions: [] })
    await service.update(skill.key, { meta: { ...reparsed, tools: ['web_browser'], allowedActions: ['missing.mjs'], resources: ['gone.md'], testTask: 'Refactor the router' }, body: 'Use the template.' })
    expect(await resources.testSkill(skill.key, projectId)).toMatchObject({ ok: false, selection: 'offered', score: 0, missingResources: ['gone.md'], missingTools: ['web_browser'], unknownActions: ['missing.mjs'] })
  })

  it('imports a skill folder into the user skills', async () => {
    const source = mkdtempSync(path.join(os.tmpdir(), 'mac-skill-import-'))
    writeFileSync(path.join(source, 'SKILL.md'), '---\nname: imported-skill\ndescription: Imported.\n---\nBody\n')
    expect((await service.importFolder(source)).key).toBe('user:imported-skill')
    await expect(service.importFolder(source)).rejects.toThrow(/exists/)
  })
})

describe('built-in UI design skills', () => {
  it('give a UI task the design rules plus the framework recipe, inline within the local agent budget', async () => {
    const context = await service.promptContext('coder', projectId, 'Dashboard-Layout mit Sidebar und Stat-Cards (Bootstrap 5, React-Komponente)', { canLoad: true, budgetChars: 6500 })
    expect(context.inlined).toEqual(expect.arrayContaining(['ui-design', 'ui-bootstrap']))
    expect(context.requiresSkillLoad).toBe(false)
    expect(context.text).toContain('--accent')
    expect(context.text).toContain('offcanvas')
    const tailwind = await service.promptContext('coder', projectId, 'Navbar component with Tailwind', { canLoad: true, budgetChars: 6500 })
    expect(tailwind.inlined).toEqual(expect.arrayContaining(['ui-design', 'ui-tailwind']))
    expect(tailwind.inlined).not.toContain('ui-bootstrap')
  })

  it('stay out of backend work', async () => {
    const context = await service.promptContext('coder', projectId, 'Add a NestJS endpoint that returns the users table with pagination and a request header check', { canLoad: true, budgetChars: 6500 })
    expect(context.inlined.filter((name) => name.startsWith('ui-'))).toEqual([])
  })

  it('reach the planner, so the plan names tokens and classes for the local tasks', async () => {
    const context = await service.promptContext('planner', projectId, 'Erstelle mit Vite ein React-Projekt mit einem modernen Dashboard, nutze Bootstrap als Styling', { canLoad: false, budgetChars: 8000 })
    expect(context.inlined).toEqual(expect.arrayContaining(['ui-design', 'ui-bootstrap']))
  })
})
