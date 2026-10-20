import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentTool } from '@multi-ai-coder/engine'
import { resolveInside, runProcess, sanitizedEnv } from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { asJson } from '../common/json.js'
import { EventBusService } from '../runtime/event-bus.service.js'
import { runtimeConfig } from '../runtime/runtime-config.js'
import { namesSkill, parseSkill, renderSkill, SKILL_NAME, SkillFormatError, skillRelevance, type SkillFrontMatter } from './skill-format.js'

export type SkillSource = 'builtin' | 'user' | 'project'
/** Roles an agent can have; skills, MCP servers and plugin tools are assigned to roles. */
export const AGENT_ROLES = ['planner', 'coder', 'chat'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

export interface Skill {
  key: string
  source: SkillSource
  /** Folder the skill was found in (project skills: relative to the project). */
  location: string
  dir: string
  name: string
  description: string
  triggers: string[]
  version?: string
  tools?: string[]
  allowedActions?: string[]
  resources?: string[]
  testTask?: string
  bodyChars: number
  files: string[]
  scripts: string[]
  scriptsHash?: string
  scriptsApproved: boolean
  enabled: boolean
  agents: string[]
  error?: string
  editable: boolean
}

const MAX_FILES = 200
const SCRIPT_TIMEOUT_MS = 120_000

/**
 * Scripts an agent may run for a skill: "allowed actions" name scripts of the skill (with or
 * without the scripts/ prefix); no list = every (approved) script.
 */
export function allowedScripts(skill: Pick<Skill, 'scripts' | 'allowedActions'>): string[] {
  const allowed = (skill.allowedActions ?? []).map((action) => action.replace(/^scripts\//, ''))
  return allowed.length ? skill.scripts.filter((script) => allowed.includes(script.replace(/^scripts\//, ''))) : skill.scripts
}

/** Tools, actions and resources a skill declares, as part of its instructions for the agent. */
function skillRequirements(skill: Pick<Skill, 'tools' | 'allowedActions' | 'resources'>): string {
  const lines = [
    skill.tools?.length ? `Tools this skill uses: ${skill.tools.join(', ')}` : '',
    skill.allowedActions?.length ? `Allowed scripts (run_skill_script): ${skill.allowedActions.join(', ')}` : '',
    skill.resources?.length ? `Resources (read_skill_file for files of the skill): ${skill.resources.join(', ')}` : '',
  ].filter(Boolean)
  return lines.length ? `\n\n${lines.join('\n')}` : ''
}

function builtinSkillsDir() {
  if (process.env.MAC_BUILTIN_SKILLS_DIR) return process.env.MAC_BUILTIN_SKILLS_DIR
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, '../../../../skills'), path.resolve(here, '../../../skills'), path.resolve(process.cwd(), 'skills'), path.resolve(process.cwd(), '../../skills')]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

/** Project folders searched for skills (the second keeps compatibility with existing agent-skill repos). */
export const PROJECT_SKILL_DIRS = ['.multi-ai-coder/skills', '.claude/skills']

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (relative: string, depth: number) => {
    if (depth > 4 || files.length >= MAX_FILES) return
    for (const entry of await fs.readdir(path.join(dir, relative), { withFileTypes: true }).catch(() => [])) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (entry.isDirectory()) await walk(child, depth + 1)
      else if (entry.isFile() && child !== 'SKILL.md') files.push(child)
    }
  }
  await walk('', 0)
  return files.sort()
}

async function hashFiles(dir: string, files: string[]) {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update(await fs.readFile(path.join(dir, file)))
  }
  return hash.digest('hex')
}

/** Interpreter for a skill script by extension (no shell). */
function interpreter(script: string): { command: string; args: string[]; env?: Record<string, string> } | undefined {
  const extension = path.extname(script).toLowerCase()
  if (['.js', '.mjs', '.cjs'].includes(extension)) return { command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }
  if (extension === '.py') return { command: process.platform === 'win32' ? 'python' : 'python3', args: [] }
  if (extension === '.ps1') return { command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] }
  if (extension === '.sh') return { command: 'bash', args: [] }
  return undefined
}

/**
 * Skills: folders with SKILL.md from three sources (shipped with the app, the user's skill folder,
 * the open project). Discovery is automatic; enabling, role assignment and the approval of scripts
 * are stored per skill. Agents get skills progressively: an index (name + description) in the prompt,
 * the full text only for skills that match the task or that the agent loads with `load_skill`.
 */
@Injectable()
export class SkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
  ) {}

  get userDir() {
    return path.join(runtimeConfig().dataDir, 'skills')
  }

  private async roots(projectId?: string): Promise<Array<{ source: SkillSource; dir: string; location: string; projectId?: string }>> {
    const roots: Array<{ source: SkillSource; dir: string; location: string; projectId?: string }> = [
      { source: 'builtin', dir: builtinSkillsDir(), location: 'App' },
      { source: 'user', dir: this.userDir, location: 'Benutzer' },
    ]
    if (projectId) {
      const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { repoPath: true } })
      if (project) for (const relative of PROJECT_SKILL_DIRS) roots.push({ source: 'project', dir: path.join(project.repoPath, relative), location: relative, projectId })
    }
    return roots
  }

  private keyOf(source: SkillSource, name: string, projectId?: string) {
    return source === 'project' ? `project:${projectId}:${name}` : `${source}:${name}`
  }

  /** Discovers all skills visible for a project (later sources do not override earlier names). */
  async list(projectId?: string): Promise<Skill[]> {
    const states = new Map((await this.prisma.skillState.findMany()).map((state) => [state.key, state]))
    const skills: Skill[] = []
    for (const root of await this.roots(projectId)) {
      if (!existsSync(root.dir)) continue
      for (const entry of await fs.readdir(root.dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = path.join(root.dir, entry.name)
        const file = path.join(dir, 'SKILL.md')
        if (!existsSync(file)) continue
        const base = { source: root.source, location: root.location, dir, editable: root.source !== 'builtin' }
        try {
          const { meta, body } = parseSkill(await fs.readFile(file, 'utf8'))
          const key = this.keyOf(root.source, meta.name, root.projectId)
          if (skills.some((skill) => skill.key === key)) continue
          const files = await listFiles(dir)
          const scripts = files.filter((candidate) => candidate.startsWith('scripts/'))
          const scriptsHash = scripts.length ? await hashFiles(dir, scripts) : undefined
          const state = (projectId ? states.get(`activation:${projectId}:${key}`) : undefined) ?? states.get(key)
          skills.push({
            ...base,
            key,
            name: meta.name,
            description: meta.description,
            triggers: meta.triggers,
            version: meta.version,
            tools: meta.tools,
            allowedActions: meta.allowedActions,
            resources: meta.resources,
            testTask: meta.testTask,
            bodyChars: body.length,
            files,
            scripts,
            scriptsHash,
            scriptsApproved: Boolean(scriptsHash && state?.scriptsApprovedHash === scriptsHash),
            enabled: state?.enabled ?? true,
            agents: (state?.agents as string[] | undefined) ?? ['*'],
          })
        } catch (error) {
          skills.push({ ...base, key: this.keyOf(root.source, entry.name, root.projectId), name: entry.name, description: '', triggers: [], bodyChars: 0, files: [], scripts: [], scriptsApproved: false, enabled: false, agents: [], error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    return skills
  }

  async find(key: string, projectId?: string): Promise<Skill> {
    const skill = (await this.list(projectId ?? (key.startsWith('project:') ? key.split(':')[1] : undefined))).find((candidate) => candidate.key === key)
    if (!skill) throw new NotFoundException(`Skill ${key} not found.`)
    return skill
  }

  async get(key: string, projectId?: string) {
    const skill = await this.find(key, projectId)
    const text = await fs.readFile(path.join(skill.dir, 'SKILL.md'), 'utf8')
    const parsed = skill.error ? undefined : parseSkill(text)
    return { ...skill, body: parsed?.body ?? '', raw: text }
  }

  private async state(key: string, patch: { enabled?: boolean; agents?: string[]; scriptsApprovedHash?: string | null }) {
    await this.prisma.skillState.upsert({
      where: { key },
      create: { key, enabled: patch.enabled ?? true, agents: asJson(patch.agents ?? ['*']), scriptsApprovedHash: patch.scriptsApprovedHash ?? null },
      update: { ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }), ...(patch.agents ? { agents: asJson(patch.agents) } : {}), ...(patch.scriptsApprovedHash === undefined ? {} : { scriptsApprovedHash: patch.scriptsApprovedHash }) },
    })
    this.events.publish('system', 'skills_changed', { key })
  }

  async updateState(key: string, patch: { enabled?: boolean; agents?: string[]; projectId?: string }) {
    await this.find(key)
    if (patch.agents && patch.agents.some((agent) => agent !== '*' && !(AGENT_ROLES as readonly string[]).includes(agent))) throw new BadRequestException(`Agents must be "*" or ${AGENT_ROLES.join(', ')}.`)
    if (patch.projectId && !(await this.prisma.project.findUnique({ where: { id: patch.projectId } }))) throw new NotFoundException('Project not found.')
    await this.state(patch.projectId ? `activation:${patch.projectId}:${key}` : key, patch)
    return this.find(key, patch.projectId)
  }

  async exportFolder(key: string, folder: string) {
    const skill = await this.find(key)
    const destination = path.join(path.resolve(folder), skill.name)
    if (existsSync(destination)) throw new ConflictException('Export destination already exists; choose another folder.')
    // listFiles leaves out SKILL.md (it lists the skill's extra files); the export needs it too
    const files = ['SKILL.md', ...(await listFiles(skill.dir))]
    // Validate every source before creating the destination; no symlink escapes or partial overwrite.
    const sources = await Promise.all(files.map(async (file) => {
      const source = resolveInside(skill.dir, file).absolute
      const real = await fs.realpath(source)
      resolveInside(await fs.realpath(skill.dir), path.relative(await fs.realpath(skill.dir), real))
      return { file, content: await fs.readFile(source) }
    }))
    await fs.mkdir(destination, { recursive: true })
    for (const { file, content } of sources) {
      const target = resolveInside(destination, file).absolute
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, { flag: 'wx' })
    }
    return { folder: destination, files: files.length }
  }

  /** Approves the current scripts of a skill; any later change of a script revokes the approval. */
  async approveScripts(key: string, hash: string) {
    const skill = await this.find(key)
    if (!skill.scriptsHash) throw new BadRequestException('The skill has no scripts.')
    if (skill.scriptsHash !== hash) throw new ConflictException('The scripts changed since they were shown. Review them again.')
    await this.state(key, { scriptsApprovedHash: hash })
    return this.find(key)
  }

  async revokeScripts(key: string) {
    await this.state(key, { scriptsApprovedHash: null })
    return this.find(key)
  }

  async readFile(key: string, file: string) {
    const skill = await this.find(key)
    const target = resolveInside(skill.dir, file)
    const stat = await fs.stat(target.absolute)
    if (stat.size > 512 * 1024) throw new BadRequestException('File too large (max. 512 KB).')
    return fs.readFile(target.absolute, 'utf8')
  }

  // ---------------------------------------------------------------------------
  // Builder
  // ---------------------------------------------------------------------------

  private async targetDir(scope: 'user' | 'project', projectId?: string) {
    if (scope === 'user') return this.userDir
    if (!projectId) throw new BadRequestException('projectId is required for project skills.')
    const project = await this.prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new NotFoundException('Project not found.')
    return path.join(project.repoPath, PROJECT_SKILL_DIRS[0]!)
  }

  async create(input: { scope: 'user' | 'project'; projectId?: string; meta: SkillFrontMatter; body: string }) {
    if (!SKILL_NAME.test(input.meta.name)) throw new BadRequestException('Name: lower-case letters, digits and "-" (max. 64).')
    const text = renderSkill(input.meta, input.body)
    parseSkill(text) // validates the description etc.
    const dir = path.join(await this.targetDir(input.scope, input.projectId), input.meta.name)
    if (existsSync(dir)) throw new ConflictException(`A skill named "${input.meta.name}" already exists there.`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'SKILL.md'), text, 'utf8')
    this.events.publish('system', 'skills_changed', { name: input.meta.name })
    return this.find(this.keyOf(input.scope, input.meta.name, input.projectId), input.projectId)
  }

  async update(key: string, input: { meta: SkillFrontMatter; body: string }) {
    const skill = await this.find(key)
    if (!skill.editable) throw new ForbiddenException('Skills shipped with the app cannot be edited; duplicate it instead.')
    if (input.meta.name !== skill.name) throw new BadRequestException('The name of an existing skill cannot be changed.')
    const text = renderSkill(input.meta, input.body)
    try {
      parseSkill(text)
    } catch (error) {
      throw new BadRequestException(error instanceof SkillFormatError ? error.message : String(error))
    }
    await fs.writeFile(path.join(skill.dir, 'SKILL.md'), text, 'utf8')
    this.events.publish('system', 'skills_changed', { key })
    return this.find(key)
  }

  async remove(key: string) {
    const skill = await this.find(key)
    if (!skill.editable) throw new ForbiddenException('Skills shipped with the app can be disabled, not deleted.')
    await fs.rm(skill.dir, { recursive: true, force: true })
    await this.prisma.skillState.deleteMany({ where: { key } })
    this.events.publish('system', 'skills_changed', { key })
    return { ok: true }
  }

  /** Copies a skill folder (e.g. from another repository) into the user's skills. Scripts stay unapproved. */
  async importFolder(folder: string) {
    const source = path.resolve(folder)
    const file = path.join(source, 'SKILL.md')
    if (!existsSync(file)) throw new BadRequestException('The folder has no SKILL.md.')
    let meta: SkillFrontMatter
    try {
      meta = parseSkill(await fs.readFile(file, 'utf8')).meta
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error))
    }
    const target = path.join(this.userDir, meta.name)
    if (existsSync(target)) throw new ConflictException(`A user skill named "${meta.name}" already exists.`)
    await fs.mkdir(this.userDir, { recursive: true })
    await fs.cp(source, target, { recursive: true, filter: (entry) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(entry) })
    this.events.publish('system', 'skills_changed', { name: meta.name })
    return this.find(this.keyOf('user', meta.name))
  }

  // ---------------------------------------------------------------------------
  // Progressive context for agents
  // ---------------------------------------------------------------------------

  /**
   * Enabled skills for a role, the ones relevant for the goal first. `only` restricts the automatic selection;
   * pinned skills (planner choice or named in the goal) bypass it and rank first.
   */
  async forRole(role: AgentRole, projectId: string | undefined, goal: string, only?: string[], pinned?: string[]) {
    const isPinned = (name: string) => Boolean(pinned?.includes(name) || (goal.trim() && namesSkill(name, goal)))
    const skills = (await this.list(projectId)).filter((skill) => !skill.error && skill.enabled && (skill.agents.includes('*') || skill.agents.includes(role)) && (!only?.length || only.includes(skill.name) || isPinned(skill.name)))
    const scored = await Promise.all(
      skills.map(async (skill) => {
        const score = skillRelevance({ name: skill.name, description: skill.description, triggers: skill.triggers }, goal)
        const pinnedSkill = isPinned(skill.name)
        return { skill, pinned: pinnedSkill, score: pinnedSkill ? Math.max(score, 100) : score }
      }),
    )
    return scored.sort((a, b) => b.score - a.score)
  }

  /**
   * Text for a prompt: full instructions of the skills that match the goal (within the budget) and a
   * one-line index of the others (the agent can load them with load_skill, if it has tools).
   */
  async promptContext(role: AgentRole, projectId: string | undefined, goal: string, options: { budgetChars?: number; canLoad: boolean; only?: string[]; pinned?: string[]; exclude?: string[] }) {
    const ranked = (await this.forRole(role, projectId, goal, options.only, options.pinned)).filter(({ skill }) => !options.exclude?.includes(skill.name))
    if (!ranked.length) return { text: '', inlined: [] as string[], indexed: [] as string[], requiresSkillLoad: false }
    let budget = options.budgetChars ?? 6000
    const inlined: string[] = []
    const sections: string[] = []
    for (const { skill, score, pinned } of ranked) {
      // without load_skill a pinned skill can only reach the agent inline: it ignores the budget
      if (score <= 0 || (skill.bodyChars > budget && (options.canLoad || !pinned))) continue
      const { body } = parseSkill(await fs.readFile(path.join(skill.dir, 'SKILL.md'), 'utf8'))
      sections.push(`### Skill: ${skill.name}\n${body}${skillRequirements(skill)}`)
      inlined.push(skill.name)
      budget -= body.length
    }
    const others = ranked.filter(({ skill }) => !inlined.includes(skill.name)).map(({ skill }) => skill)
    const lines: string[] = []
    if (sections.length) lines.push('## Relevant skills (follow these instructions)', ...sections)
    if (others.length && options.canLoad) lines.push('## Other available skills (call load_skill with the name when one applies)', ...others.slice(0, 40).map((skill) => `- ${skill.name}: ${skill.description}`))
    const requiresSkillLoad = options.canLoad && ranked.some(({ skill, score }) => score > 0 && !inlined.includes(skill.name))
    return { text: lines.join('\n\n'), inlined, indexed: options.canLoad ? others.map((skill) => skill.name) : [], requiresSkillLoad }
  }

  /** load_skill / read_skill_file / run_skill_script for an agent (scripts only when approved). */
  async agentTools(role: AgentRole, projectId: string | undefined, cwd: string, only?: string[]): Promise<AgentTool[]> {
    const skills = (await this.forRole(role, projectId, '', only)).map(({ skill }) => skill)
    if (!skills.length) return []
    const byName = new Map(skills.map((skill) => [skill.name, skill]))
    const get = (name: unknown) => {
      const skill = byName.get(String(name))
      if (!skill) throw new Error(`Unknown skill "${String(name)}". Available: ${[...byName.keys()].join(', ')}`)
      return skill
    }
    const tools: AgentTool[] = [
      {
        name: 'load_skill',
        readOnly: true,
        description: 'Load the full instructions of a skill listed under "Other available skills".',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        execute: async (args) => {
          const skill = get(args.name)
          const { body } = parseSkill(await fs.readFile(path.join(skill.dir, 'SKILL.md'), 'utf8'))
          return `${body}${skillRequirements(skill)}${skill.files.length ? `\n\nFiles of this skill (read_skill_file): ${skill.files.join(', ')}` : ''}`
        },
      },
    ]
    if (skills.some((skill) => skill.files.length)) {
      tools.push({
        name: 'read_skill_file',
        readOnly: true,
        description: 'Read a reference file that belongs to a skill.',
        parameters: { type: 'object', properties: { skill: { type: 'string' }, path: { type: 'string' } }, required: ['skill', 'path'] },
        execute: async (args) => this.readFile(get(args.skill).key, String(args.path)),
      })
    }
    const runnable = skills.filter((skill) => skill.scriptsApproved && allowedScripts(skill).length)
    if (runnable.length) {
      tools.push({
        name: 'run_skill_script',
        description: `Run an approved script of a skill in the task's working copy. Skills with approved scripts: ${runnable.map((skill) => `${skill.name} (${allowedScripts(skill).join(', ')})`).join('; ')}`,
        parameters: { type: 'object', properties: { skill: { type: 'string' }, script: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, required: ['skill', 'script'] },
        execute: async (args, signal) => this.runScript(get(args.skill).key, String(args.script), Array.isArray(args.args) ? args.args.map(String) : [], cwd, signal),
      })
    }
    return tools
  }

  /** Runs an approved skill script (no shell, sanitized environment, timeout, output limit). */
  async runScript(key: string, script: string, args: string[], cwd: string, signal?: AbortSignal) {
    const skill = await this.find(key)
    if (!skill.scripts.includes(script)) throw new Error(`"${script}" is not a script of ${skill.name} (scripts/…).`)
    if (!skill.scriptsApproved) throw new Error(`The scripts of ${skill.name} are not approved. Approve them in the skill manager first.`)
    if (!allowedScripts(skill).includes(script)) throw new Error(`"${script}" is not an allowed action of ${skill.name} (allowed: ${allowedScripts(skill).join(', ') || 'none'}).`)
    const runner = interpreter(script)
    if (!runner) throw new Error(`No interpreter for ${path.extname(script)} scripts.`)
    const result = await runProcess(runner.command, [...runner.args, path.join(skill.dir, script), ...args.slice(0, 20)], { cwd, env: sanitizedEnv(runner.env ?? {}), timeoutMs: SCRIPT_TIMEOUT_MS, signal, maxOutputBytes: 256 * 1024 })
    this.events.publish('system', 'skill_script_run', { key, script, exitCode: result.exitCode, durationMs: result.durationMs })
    if (result.spawnError) throw new Error(`${runner.command} could not be started: ${result.spawnError}`)
    return `exit code ${result.exitCode}${result.timedOut ? ' (timeout)' : ''}\n${result.stdout.slice(-12_000)}${result.stderr ? `\n[stderr]\n${result.stderr.slice(-4000)}` : ''}`
  }
}
