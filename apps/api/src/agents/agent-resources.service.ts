import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import type { AgentTool, SkillOffer } from '@multi-ai-coder/engine'
import { McpService } from '../mcp/mcp.service.js'
import { PluginsService } from '../plugins/plugins.service.js'
import { SkillsService, type AgentRole } from '../skills/skills.service.js'
import { namesSkill, skillRelevance } from '../skills/skill-format.js'

/** File tools every local agent has (see runLocalAgent). */
const BUILTIN_AGENT_TOOLS = ['read_file', 'list_files', 'search_code', 'write_file', 'edit_file', 'finish']

export interface AgentResources {
  tools: AgentTool[]
  instructions?: string
  requiredTools?: string[]
  /** Short labels for the run log ("2 Skills", "MCP github"). */
  sources: string[]
}

/**
 * Everything an agent gets besides the repository: skills (progressively), tools of MCP servers and
 * plugins assigned to its role. Only tools that need no confirmation reach autonomous agents.
 */
@Injectable()
export class AgentResourcesService {
  private readonly logger = new Logger('AgentResources')

  constructor(
    private readonly skills: SkillsService,
    private readonly mcp: McpService,
    private readonly plugins: PluginsService,
  ) {}

  /** For a tool-calling or structured local agent working on one task. */
  async forAgent(role: AgentRole, input: { projectId?: string; goal: string; cwd: string; supportsTools: boolean; pinned?: string[]; profile?: { skills: string[]; mcpServers: string[]; pluginTools: boolean } }): Promise<AgentResources> {
    const sources: string[] = []
    const only = input.profile?.skills.length ? input.profile.skills : undefined
    // 6500: a core skill plus one framework recipe (e.g. ui-design + ui-bootstrap) fit without load_skill
    const skillContext = await this.skills.promptContext(role, input.projectId, input.goal, { budgetChars: input.supportsTools ? 6500 : 8000, canLoad: input.supportsTools, only, pinned: input.pinned })
    const requiredTools = skillContext.requiresSkillLoad ? ['load_skill'] : []
    // what the agent was shown (profile skills plus pinned ones): load_skill must find exactly these
    const presented = [...skillContext.inlined, ...skillContext.indexed]
    if (presented.length) sources.push(`Skills: ${presented.slice(0, 6).join(', ')}`)
    if (!input.supportsTools) return { tools: [], instructions: skillContext.text || undefined, sources, requiredTools }
    const [skillTools, mcpTools, pluginTools] = await Promise.all([
      presented.length ? this.skills.agentTools(role, input.projectId, input.cwd, presented) : Promise.resolve([]),
      this.mcp.agentTools(role, input.goal, input.profile?.mcpServers ?? ['*']).catch((error: unknown) => {
        this.logger.warn(`MCP tools unavailable: ${error instanceof Error ? error.message : String(error)}`)
        return [] as AgentTool[]
      }),
      input.profile && !input.profile.pluginTools ? Promise.resolve([] as AgentTool[]) : this.plugins.agentTools(role).catch(() => [] as AgentTool[]),
    ])
    if (mcpTools.length) sources.push(`${mcpTools.length} MCP-Werkzeug(e)`)
    if (pluginTools.length) sources.push(`${pluginTools.length} Plugin-Werkzeug(e)`)
    // skills only need load_skill when not everything was inlined
    const tools = [...(skillContext.indexed.length ? skillTools : skillTools.filter((tool) => tool.name !== 'load_skill')), ...mcpTools, ...pluginTools]
    const external = [...mcpTools, ...pluginTools]
    // the base prompt only describes the file tools: name the others and when to use them
    const toolSection = external.length
      ? `## Additional tools\nBesides the file tools you can call:\n${external.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}\nWhen the task needs information one of these tools provides (or names the tool), call it first and use its result. Never guess or invent such values.`
      : ''
    const instructions = [skillContext.text, toolSection].filter(Boolean).join('\n\n')
    return { tools, instructions: instructions || undefined, sources, requiredTools }
  }

  /**
   * Checks a skill against its test task without a model call: would the skill be selected for the
   * task (inlined or offered), do its resources exist, are the tools it needs available to the role,
   * do its allowed actions name real scripts.
   */
  async testSkill(key: string, projectId?: string) {
    const skill = await this.skills.find(key, projectId)
    if (!skill.testTask?.trim()) throw new BadRequestException('The skill has no test task.')
    const role = (skill.agents.includes('*') || !skill.agents.length ? 'coder' : skill.agents[0]) as AgentRole
    const context = await this.skills.promptContext(role, projectId, skill.testTask, { budgetChars: 5000, canLoad: true })
    const selection = context.inlined.includes(skill.name) ? 'inlined' : context.indexed.includes(skill.name) ? 'offered' : 'not_selected'
    const score = skillRelevance({ name: skill.name, description: skill.description, triggers: skill.triggers }, skill.testTask)
    const missingResources = (skill.resources ?? []).filter((resource) => !/^https?:\/\//.test(resource) && !skill.files.includes(resource.replace(/^\.\//, '')))
    const [mcpTools, pluginTools] = await Promise.all([this.mcp.agentTools(role, skill.testTask).catch(() => [] as AgentTool[]), this.plugins.agentTools(role).catch(() => [] as AgentTool[])])
    const available = [...BUILTIN_AGENT_TOOLS, 'load_skill', 'read_skill_file', 'run_skill_script', ...mcpTools.map((tool) => tool.name), ...pluginTools.map((tool) => tool.name)]
    const matches = (pattern: string) => {
      const expression = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
      return available.some((name) => expression.test(name))
    }
    const missingTools = (skill.tools ?? []).filter((tool) => !matches(tool))
    const unknownActions = (skill.allowedActions ?? []).filter((action) => !skill.scripts.some((script) => script.replace(/^scripts\//, '') === action.replace(/^scripts\//, '')))
    return {
      // only offered in the index without any relevance would never be picked for such a task
      ok: selection !== 'not_selected' && score > 0 && !missingResources.length && !missingTools.length && !unknownActions.length,
      role,
      selection,
      score,
      missingResources,
      missingTools,
      unknownActions,
      prompt: context.text.slice(0, 6000),
    }
  }

  /** Text for a premium prompt (planning, chat): skills only; the CLI orchestrators bring their own tools. */
  async promptContext(role: AgentRole, projectId: string | undefined, goal: string, exclude?: string[]) {
    return this.skills.promptContext(role, projectId, goal, { budgetChars: 8000, canLoad: false, exclude })
  }

  /** Active skills offered to the planner, which attaches them to tasks; named skills are flagged as requested. */
  async catalog(projectId: string | undefined, goal: string, limit = 40): Promise<SkillOffer[]> {
    // Only skills that reach a coder agent (like forRole: '*' or 'coder'; empty means none); the planner assigns tasks to coders.
    const skills = (await this.skills.list(projectId)).filter((skill) => !skill.error && skill.enabled && (skill.agents.includes('*') || skill.agents.includes('coder')))
    return skills
      .map((skill) => ({ name: skill.name, description: skill.description, requested: namesSkill(skill.name, goal) }))
      .sort((a, b) => Number(b.requested) - Number(a.requested))
      .slice(0, limit)
  }
}
