import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common'
import { PrismaService } from '../common/prisma.service.js'
import { str } from '../common/validate.js'
import { McpService, type McpServerInput } from './mcp.service.js'

/** Copies the known fields of a request body (types are checked by McpService.validate). */
function serverInput(body: unknown): Partial<McpServerInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Body must be an object.')
  const record = body as Record<string, unknown>
  const pick = <T>(key: string, check: (value: unknown) => boolean): T | undefined => {
    if (record[key] === undefined) return undefined
    if (!check(record[key])) throw new BadRequestException(`"${key}" has an invalid type.`)
    return record[key] as T
  }
  const isString = (value: unknown) => typeof value === 'string'
  const isStringList = (value: unknown) => Array.isArray(value) && value.every(isString)
  const isStringMap = (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.values(value as object).every(isString)
  return {
    name: pick('name', isString),
    transport: pick('transport', isString),
    command: pick('command', isString),
    args: pick('args', isStringList),
    env: pick('env', isStringMap),
    secretEnv: pick('secretEnv', isStringList),
    cwd: pick('cwd', isString),
    url: pick('url', isString),
    headers: pick('headers', isStringMap),
    oauth: pick('oauth', (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)),
    secretHeaders: pick('secretHeaders', (value) => Array.isArray(value) && value.every((entry) => entry && typeof entry === 'object' && isString((entry as { header?: unknown }).header) && isString((entry as { secret?: unknown }).secret))),
    enabled: pick('enabled', (value) => typeof value === 'boolean'),
    timeoutMs: pick('timeoutMs', (value) => typeof value === 'number' && Number.isFinite(value)),
    toolPolicies: pick('toolPolicies', isStringMap),
    defaultPolicy: pick('defaultPolicy', isString),
    agents: pick('agents', isStringList),
  }
}

@Controller('mcp')
export class McpController {
  constructor(
    private readonly mcp: McpService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('servers')
  list() {
    return this.mcp.list()
  }

  @Post('servers')
  create(@Body() body: unknown) {
    return this.mcp.create(serverInput(body) as McpServerInput)
  }

  @Post('import')
  import(@Body() body: unknown) {
    return this.mcp.importConfig(str(body, 'json', { max: 200_000 }))
  }

  /** MCP configuration files in a project (offered for import, never started automatically). */
  @Get('discover')
  async discover(@Query('projectId') projectId = '') {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new NotFoundException('Project not found.')
    return this.mcp.discover(project.repoPath)
  }

  @Get('servers/:id')
  get(@Param('id') id: string) {
    return this.mcp.get(id)
  }

  @Patch('servers/:id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.mcp.update(id, serverInput(body))
  }

  @Delete('servers/:id')
  remove(@Param('id') id: string) {
    return this.mcp.remove(id)
  }

  /** Connects (if needed), refreshes the tool list and pings. */
  @Post('servers/:id/test')
  async test(@Param('id') id: string) {
    await this.mcp.tools(id, true)
    return { ...(await this.mcp.health(id)), server: await this.mcp.get(id) }
  }

  @Post('servers/:id/disconnect')
  async disconnect(@Param('id') id: string) {
    await this.mcp.disconnect(id)
    return this.mcp.get(id)
  }

  @Post('servers/:id/oauth/login')
  oauthLogin(@Param('id') id: string) { return this.mcp.loginOAuth(id) }

  @Post('servers/:id/oauth/logout')
  oauthLogout(@Param('id') id: string) { return this.mcp.logoutOAuth(id) }

  @Get('servers/:id/tools')
  tools(@Param('id') id: string, @Query('refresh') refresh?: string) {
    return this.mcp.tools(id, refresh === '1')
  }

  /** Manual tool call from the MCP manager (the UI asks for confirmation first). */
  @Post('servers/:id/tools/:tool/call')
  call(@Param('id') id: string, @Param('tool') tool: string, @Body() body: unknown) {
    const args = (body as { args?: unknown } | undefined)?.args ?? {}
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new BadRequestException('"args" must be an object.')
    return this.mcp.callTool(id, tool, args as Record<string, unknown>, { source: 'manual' })
  }
}
