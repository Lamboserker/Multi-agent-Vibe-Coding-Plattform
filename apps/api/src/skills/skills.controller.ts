import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common'
import { bool, oneOf, str, strList } from '../common/validate.js'
import { AGENT_ROLES, SkillsService } from './skills.service.js'
import type { SkillFrontMatter } from './skill-format.js'
import { AgentResourcesService } from '../agents/agent-resources.service.js'

function meta(body: unknown): SkillFrontMatter {
  return {
    name: str(body, 'name', { max: 64 }),
    description: str(body, 'description', { max: 1024 }),
    triggers: strList(body, 'triggers', 30).map((trigger) => trigger.trim().toLowerCase()).filter(Boolean),
    version: str(body, 'version', { optional: true, max: 40 }) || undefined,
    resources: strList(body, 'resources', 100).map((resource) => {
      // files of the skill folder (exported with it) or web references
      if (/^https?:\/\/\S+$/.test(resource)) return resource
      const relative = resource.trim().replace(/\\/g, '/').replace(/^\.\//, '')
      if (!relative || relative.startsWith('/') || /^[A-Za-z]:/.test(relative) || relative.split('/').includes('..')) throw new BadRequestException(`Resource "${resource}" must be a file inside the skill folder or an http(s) URL.`)
      return relative
    }),
    tools: strList(body, 'tools', 100).map((tool) => {
      if (!/^[\w.*-]{1,128}$/.test(tool)) throw new BadRequestException(`Invalid tool name "${tool}".`)
      return tool
    }),
    allowedActions: strList(body, 'allowedActions', 100),
    testTask: str(body, 'testTask', { optional: true, max: 5000 }),
  }
}

@Controller('skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService, private readonly resources: AgentResourcesService) {}

  @Get()
  list(@Query('projectId') projectId?: string) {
    return this.skills.list(projectId || undefined)
  }

  /** Which skills an agent of a role would get for a goal (transparency for the user). */
  @Get('preview')
  async preview(@Query('projectId') projectId: string | undefined, @Query('goal') goal = '', @Query('role') role = 'coder') {
    if (!(AGENT_ROLES as readonly string[]).includes(role)) throw new BadRequestException('Unknown role.')
    return this.skills.promptContext(role as (typeof AGENT_ROLES)[number], projectId || undefined, goal.slice(0, 2000), { canLoad: true })
  }

  @Post()
  create(@Body() body: unknown) {
    return this.skills.create({
      scope: oneOf(body, 'scope', ['user', 'project'] as const, 'user'),
      projectId: str(body, 'projectId', { optional: true, max: 100 }) || undefined,
      meta: meta(body),
      body: str(body, 'body', { max: 200_000 }),
    })
  }

  @Post('import')
  import(@Body() body: unknown) {
    return this.skills.importFolder(str(body, 'folder', { max: 1000 }))
  }

  @Get(':key')
  get(@Param('key') key: string, @Query('projectId') projectId?: string) {
    return this.skills.get(key, projectId)
  }

  @Put(':key')
  update(@Param('key') key: string, @Body() body: unknown) {
    return this.skills.update(key, { meta: meta(body), body: str(body, 'body', { max: 200_000 }) })
  }

  @Patch(':key')
  state(@Param('key') key: string, @Body() body: unknown) {
    const record = (body ?? {}) as Record<string, unknown>
    return this.skills.updateState(key, {
      enabled: record.enabled === undefined ? undefined : bool(body, 'enabled'),
      agents: record.agents === undefined ? undefined : strList(body, 'agents', 10),
      projectId: str(body, 'projectId', { optional: true, max: 100 }) || undefined,
    })
  }

  /** Checks the skill against its test task (selection, resources, tools, actions); no model call. */
  @Post(':key/test')
  test(@Param('key') key: string, @Body() body: unknown) {
    return this.resources.testSkill(key, str(body, 'projectId', { optional: true, max: 100 }) || undefined)
  }

  @Post(':key/export')
  export(@Param('key') key: string, @Body() body: unknown) {
    return this.skills.exportFolder(key, str(body, 'folder', { max: 1000 }))
  }

  @Delete(':key')
  remove(@Param('key') key: string) {
    return this.skills.remove(key)
  }

  @Get(':key/files')
  file(@Param('key') key: string, @Query('path') file = '') {
    return this.skills.readFile(key, file)
  }

  @Post(':key/approve-scripts')
  approve(@Param('key') key: string, @Body() body: unknown) {
    return this.skills.approveScripts(key, str(body, 'hash', { max: 100 }))
  }

  @Post(':key/revoke-scripts')
  revoke(@Param('key') key: string) {
    return this.skills.revokeScripts(key)
  }
}
