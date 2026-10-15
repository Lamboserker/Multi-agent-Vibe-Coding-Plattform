import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type { AgentProfile } from '@prisma/client'
import type { AgentAssignment } from '@multi-ai-coder/engine'
import { PrismaService } from '../common/prisma.service.js'
import { asJson } from '../common/json.js'
import { EventBusService } from '../runtime/event-bus.service.js'

export interface AgentProfileInput {
  name: string
  description?: string
  projectId?: string | null
  model?: string | null
  categories?: string[]
  skills?: string[]
  mcpServers?: string[]
  pluginTools?: boolean
  escalation?: 'premium' | 'local' | 'none'
  maxSteps?: number | null
  maxRepairs?: number | null
  maxContextTokens?: number | null
  permissions?: AgentAssignment['permissions']
  resources?: AgentAssignment['resources']
  instructions?: string
  enabled?: boolean
  priority?: number
}

/** Ready-made agents (the user creates editable copies). */
export const AGENT_TEMPLATES: Array<AgentProfileInput & { id: string }> = [
  {
    id: 'frontend',
    name: 'Frontend-Agent',
    description: 'UI-Komponenten, Styles und Barrierefreiheit.',
    categories: ['frontend', 'ui', 'component', 'komponente', 'react', 'css', 'tsx', 'jsx', 'vue', 'svelte', 'layout', 'button'],
    instructions: 'Follow the existing component structure and styling approach. Use semantic, accessible markup (labels, roles, keyboard support). Keep components small and typed; do not add new UI libraries.',
    escalation: 'premium',
    priority: 10,
  },
  {
    id: 'backend',
    name: 'Backend-Agent',
    description: 'APIs, Services, Datenbankzugriffe.',
    categories: ['backend', 'api', 'endpoint', 'server', 'service', 'controller', 'database', 'datenbank', 'sql', 'migration', 'prisma'],
    instructions: 'Validate all external input, keep handlers thin, return consistent error shapes. Database changes must be additive migrations; never drop data.',
    escalation: 'premium',
    priority: 10,
  },
  {
    id: 'tests',
    name: 'Test-Agent',
    description: 'Schreibt und repariert Tests nach dem Muster des Projekts.',
    categories: ['test', 'tests', 'testing', 'spec', 'vitest', 'jest', 'coverage', 'testfall'],
    skills: ['writing-tests'],
    instructions: 'Only add or change tests unless the task explicitly asks for code changes. Tests must be deterministic.',
    escalation: 'local',
    maxRepairs: 3,
    priority: 20,
  },
  {
    id: 'docs',
    name: 'Doku-Agent',
    description: 'README, Dokumentation, Changelog – günstig, ohne Premium-Eskalation.',
    categories: ['docs', 'doku', 'dokumentation', 'documentation', 'readme', 'changelog', 'markdown', '.md'],
    skills: ['changelog'],
    mcpServers: [],
    pluginTools: false,
    instructions: 'Write concise documentation in the language and tone of the existing docs. Do not change code.',
    escalation: 'none',
    maxSteps: 10,
    priority: 20,
  },
  {
    id: 'refactor',
    name: 'Refactoring-Agent',
    description: 'Umbenennen, Aufräumen, Umstrukturieren ohne Verhaltensänderung.',
    categories: ['refactor', 'refactoring', 'rename', 'umbenennen', 'aufräumen', 'cleanup', 'extract', 'restructure'],
    instructions: 'Behaviour must not change. Update every reference; keep public APIs unless the task says otherwise; run the existing tests mentally before finishing.',
    escalation: 'premium',
    priority: 15,
  },
]

const ESCALATION = ['premium', 'local', 'none']

/** Whether a profile handles a subtask: category or keyword found in title, description or file paths. */
export function profileMatches(profile: Pick<AgentProfile, 'categories'>, subtask: { category: string; title: string; goal: string; files: string[] }) {
  const keywords = (profile.categories as string[]).map((entry) => entry.toLowerCase()).filter(Boolean)
  if (!keywords.length) return 0
  if (keywords.includes(subtask.category.toLowerCase())) return 3
  const text = `${subtask.title}\n${subtask.goal}`.toLowerCase()
  const words = new Set(text.split(/[^\p{L}\p{N}.]+/u).filter(Boolean))
  const files = subtask.files.join('\n').toLowerCase()
  let score = 0
  for (const keyword of keywords) {
    if (words.has(keyword)) score += 2
    else if (keyword.length > 3 && text.includes(keyword)) score += 1
    if (files.includes(keyword)) score += 1
  }
  return score
}

@Injectable()
export class AgentProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBusService,
  ) {}

  templates() {
    return AGENT_TEMPLATES
  }

  async list(projectId?: string) {
    const where = projectId ? { OR: [{ projectId: null }, { projectId }] } : {}
    return this.prisma.agentProfile.findMany({ where, orderBy: [{ priority: 'desc' }, { name: 'asc' }] })
  }

  async get(id: string) {
    const profile = await this.prisma.agentProfile.findUnique({ where: { id } })
    if (!profile) throw new NotFoundException('Agent not found.')
    return profile
  }

  private validate(input: Partial<AgentProfileInput>, partial: boolean) {
    if (input.maxContextTokens != null && (!Number.isSafeInteger(input.maxContextTokens) || input.maxContextTokens < 1024 || input.maxContextTokens > 1048576)) throw new BadRequestException('Invalid maximum context.')
    if (input.permissions !== undefined && (!input.permissions || typeof input.permissions !== 'object' || Array.isArray(input.permissions) || Object.entries(input.permissions).some(([key, value]) => !['read', 'write', 'externalTools'].includes(key) || typeof value !== 'boolean'))) throw new BadRequestException('Invalid agent permissions.')
    if (input.resources !== undefined) {
      const limits: Record<string, [number, number]> = { timeoutMs: [1000, 1800000], maxFiles: [1, 40], maxWriteBytes: [1024, 524288], maxOutputTokens: [128, 65536] }
      if (!input.resources || typeof input.resources !== 'object' || Array.isArray(input.resources) || Object.entries(input.resources).some(([key, value]) => !limits[key] || !Number.isSafeInteger(value) || value < limits[key]![0] || value > limits[key]![1])) throw new BadRequestException('Invalid agent resource limits.')
    }
    if (!partial || input.name !== undefined) if (!input.name?.trim() || input.name.length > 80) throw new BadRequestException('Name is required (max. 80 characters).')
    if (input.escalation !== undefined && !ESCALATION.includes(input.escalation)) throw new BadRequestException('Escalation must be premium, local or none.')
    if (input.maxSteps !== undefined && input.maxSteps !== null && (input.maxSteps < 2 || input.maxSteps > 60)) throw new BadRequestException('maxSteps must be between 2 and 60.')
    if (input.maxRepairs !== undefined && input.maxRepairs !== null && (input.maxRepairs < 0 || input.maxRepairs > 5)) throw new BadRequestException('maxRepairs must be between 0 and 5.')
    if (input.instructions !== undefined && input.instructions.length > 4000) throw new BadRequestException('Instructions are limited to 4000 characters.')
    for (const list of [input.categories, input.skills, input.mcpServers]) if (list && list.length > 50) throw new BadRequestException('Lists are limited to 50 entries.')
  }

  private data(input: Partial<AgentProfileInput>) {
    return {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.model !== undefined ? { model: input.model || null } : {}),
      ...(input.categories !== undefined ? { categories: asJson(input.categories.map((entry) => entry.trim().toLowerCase()).filter(Boolean)) } : {}),
      ...(input.skills !== undefined ? { skills: asJson(input.skills) } : {}),
      ...(input.mcpServers !== undefined ? { mcpServers: asJson(input.mcpServers) } : {}),
      ...(input.pluginTools !== undefined ? { pluginTools: input.pluginTools } : {}),
      ...(input.escalation !== undefined ? { escalation: input.escalation } : {}),
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
      ...(input.maxRepairs !== undefined ? { maxRepairs: input.maxRepairs } : {}),
      ...(input.maxContextTokens !== undefined ? { maxContextTokens: input.maxContextTokens } : {}),
      ...(input.permissions !== undefined ? { permissions: asJson(input.permissions) } : {}),
      ...(input.resources !== undefined ? { resources: asJson(input.resources) } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    }
  }

  async create(input: AgentProfileInput & { template?: string }) {
    this.validate(input, false)
    const profile = await this.prisma.agentProfile.create({ data: { name: input.name.trim(), ...this.data(input), template: input.template ?? null } })
    this.events.publish('system', 'agents_changed', { id: profile.id })
    return profile
  }

  async createFromTemplate(templateId: string, projectId?: string | null) {
    const template = AGENT_TEMPLATES.find((entry) => entry.id === templateId)
    if (!template) throw new NotFoundException('Unknown template.')
    const { id: _id, ...input } = template
    return this.create({ ...input, projectId: projectId ?? null, template: templateId })
  }

  async update(id: string, input: Partial<AgentProfileInput>) {
    this.validate(input, true)
    await this.get(id)
    const profile = await this.prisma.agentProfile.update({ where: { id }, data: this.data(input) })
    this.events.publish('system', 'agents_changed', { id })
    return profile
  }

  async remove(id: string) {
    await this.get(id)
    await this.prisma.subtask.updateMany({ where: { agentId: id, status: { in: ['planned', 'queued'] } }, data: { agentId: null } })
    await this.prisma.agentProfile.delete({ where: { id } })
    this.events.publish('system', 'agents_changed', { id })
    return { ok: true }
  }

  /** Best agent for a subtask: project agents before global ones, then match score, then priority. */
  async match(projectId: string, subtask: { category: string; title: string; goal: string; files: string[] }) {
    const profiles = (await this.list(projectId)).filter((profile) => profile.enabled && profile.role === 'coder')
    let best: { profile: AgentProfile; score: number } | undefined
    for (const profile of profiles) {
      const score = profileMatches(profile, subtask)
      if (score <= 0) continue
      const rank = score * 100 + profile.priority + (profile.projectId ? 1000 : 0)
      if (!best || rank > best.score) best = { profile, score: rank }
    }
    return best?.profile
  }

  toAssignment(profile: AgentProfile): AgentAssignment {
    return {
      mcpServers: profile.mcpServers as string[],
      maxContextTokens: profile.maxContextTokens ?? undefined,
      permissions: profile.permissions as AgentAssignment['permissions'],
      resources: profile.resources as AgentAssignment['resources'],
      id: profile.id,
      name: profile.name,
      escalation: profile.escalation as AgentAssignment['escalation'],
      maxSteps: profile.maxSteps ?? undefined,
      maxRepairs: profile.maxRepairs ?? undefined,
      instructions: profile.instructions || undefined,
    }
  }
}
