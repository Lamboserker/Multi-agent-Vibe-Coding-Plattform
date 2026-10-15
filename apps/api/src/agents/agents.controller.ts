import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { num, str, strList } from '../common/validate.js'
import { ExecutionService } from '../execution/execution.service.js'
import { AgentProfilesService, type AgentProfileInput } from './agent-profiles.service.js'

function input(body: unknown): Partial<AgentProfileInput> {
  const record = (body ?? {}) as Record<string, unknown>
  const has = (key: string) => record[key] !== undefined
  const nullableNumber = (key: string, min: number, max: number) => (record[key] === null ? null : num(body, key, { min, max }))
  if (has('pluginTools') && typeof record.pluginTools !== 'boolean') throw new BadRequestException('"pluginTools" must be a boolean.')
  if (has('enabled') && typeof record.enabled !== 'boolean') throw new BadRequestException('"enabled" must be a boolean.')
  return {
    ...(has('maxContextTokens') ? { maxContextTokens: nullableNumber('maxContextTokens', 1024, 1048576) } : {}),
    ...(has('permissions') ? { permissions: record.permissions as AgentProfileInput['permissions'] } : {}),
    ...(has('resources') ? { resources: record.resources as AgentProfileInput['resources'] } : {}),
    ...(has('name') ? { name: str(body, 'name', { max: 80 }) } : {}),
    ...(has('description') ? { description: str(body, 'description', { optional: true, max: 500 }) } : {}),
    ...(has('projectId') ? { projectId: record.projectId === null ? null : str(body, 'projectId', { max: 100 }) } : {}),
    ...(has('model') ? { model: record.model === null ? null : str(body, 'model', { optional: true, max: 200 }) || null } : {}),
    ...(has('categories') ? { categories: strList(body, 'categories', 50) } : {}),
    ...(has('skills') ? { skills: strList(body, 'skills', 50) } : {}),
    ...(has('mcpServers') ? { mcpServers: strList(body, 'mcpServers', 50) } : {}),
    ...(has('pluginTools') ? { pluginTools: record.pluginTools as boolean } : {}),
    ...(has('escalation') ? { escalation: str(body, 'escalation', { max: 10 }) as AgentProfileInput['escalation'] } : {}),
    ...(has('maxSteps') ? { maxSteps: nullableNumber('maxSteps', 2, 60) } : {}),
    ...(has('maxRepairs') ? { maxRepairs: nullableNumber('maxRepairs', 0, 5) } : {}),
    ...(has('instructions') ? { instructions: str(body, 'instructions', { optional: true, max: 4000 }) } : {}),
    ...(has('enabled') ? { enabled: record.enabled as boolean } : {}),
    ...(has('priority') ? { priority: num(body, 'priority', { min: -100, max: 100 }) } : {}),
  }
}

@Controller()
export class AgentsController {
  constructor(
    private readonly profiles: AgentProfilesService,
    private readonly executions: ExecutionService,
  ) {}

  @Get('agents')
  list(@Query('projectId') projectId?: string) {
    return this.profiles.list(projectId || undefined)
  }

  @Get('agents/templates')
  templates() {
    return this.profiles.templates()
  }

  @Post('agents')
  create(@Body() body: unknown) {
    const template = str(body, 'template', { optional: true, max: 40 })
    if (template) return this.profiles.createFromTemplate(template, (body as { projectId?: string | null }).projectId ?? null)
    return this.profiles.create(input(body) as AgentProfileInput)
  }

  @Patch('agents/:id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.profiles.update(id, input(body))
  }

  @Delete('agents/:id')
  remove(@Param('id') id: string) {
    return this.profiles.remove(id)
  }

  /** Assigns an agent to a planned subtask (null = no agent profile). */
  @Post('subtasks/:id/agent')
  assign(@Param('id') id: string, @Body() body: unknown) {
    const agentId = (body as { agentId?: unknown } | undefined)?.agentId
    if (agentId !== null && typeof agentId !== 'string') throw new BadRequestException('"agentId" must be a string or null.')
    return this.executions.setAgent(id, agentId)
  }
}
