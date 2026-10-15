import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common'
import { EXTENSION_METHODS, type ExtensionKind, type PluginPermissions } from '@multi-ai-coder/plugin-sdk'
import { bool, str } from '../common/validate.js'
import { PluginsService } from './plugins.service.js'

function record(body: unknown, key: string): Record<string, unknown> {
  const value = (body as Record<string, unknown> | undefined)?.[key]
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException(`"${key}" must be an object.`)
  return value as Record<string, unknown>
}

function grant(body: unknown): PluginPermissions | undefined {
  const value = (body as Record<string, unknown> | undefined)?.grant
  if (value === undefined) return undefined
  const input = record(body, 'grant')
  const list = (key: string) => {
    const entry = input[key]
    if (entry === undefined) return []
    if (!Array.isArray(entry) || entry.some((item) => typeof item !== 'string')) throw new BadRequestException(`"grant.${key}" must be a list.`)
    return entry as string[]
  }
  const fs = input.fs ?? 'none'
  if (!['none', 'project-read', 'project-write'].includes(String(fs))) throw new BadRequestException('"grant.fs" is invalid.')
  if (input.native !== undefined && typeof input.native !== 'boolean') throw new BadRequestException('"grant.native" must be a boolean.')
  return { network: list('network'), processes: list('processes'), secrets: list('secrets'), fs: fs as PluginPermissions['fs'], native: input.native === true }
}

@Controller('plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

  @Get()
  list() {
    return this.plugins.list()
  }

  /** Plugins that can be installed (shipped catalog; a remote marketplace can be added as another source). */
  @Get('catalog')
  catalog() {
    return this.plugins.catalog()
  }

  @Post('install')
  install(@Body() body: unknown) {
    return this.plugins.install({
      folder: str(body, 'folder', { optional: true, max: 1000 }) || undefined,
      gitUrl: str(body, 'gitUrl', { optional: true, max: 1000 }) || undefined,
      allowDowngrade: bool(body, 'allowDowngrade'),
    })
  }

  /** Agent tools of enabled plugins. */
  @Get('tools')
  tools() {
    return this.plugins.toolCatalog()
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.plugins.get(id)
  }

  @Get('extensions/catalog')
  extensions() {
    return this.plugins.extensionCatalog()
  }

  @Post('extensions/:kind/select')
  selectExtension(@Param('kind') kind: string, @Body() body: { selected?: { plugin: string; id: string } | null }) {
    if (!Object.hasOwn(EXTENSION_METHODS, kind)) throw new BadRequestException('Unknown extension kind.')
    const selected = body?.selected ?? null
    if (selected && (typeof selected.plugin !== 'string' || typeof selected.id !== 'string')) throw new BadRequestException('Invalid extension selection.')
    return this.plugins.selectExtension(kind as ExtensionKind, selected)
  }

  @Post(':id/extensions/:kind/:extension/:method')
  extension(@Param('id') id: string, @Param('kind') kind: string, @Param('extension') extension: string, @Param('method') method: string, @Body() body: unknown) {
    if (!Object.hasOwn(EXTENSION_METHODS, kind)) throw new BadRequestException('Unknown extension kind.')
    return this.plugins.invokeExtension(id, kind as ExtensionKind, extension, method, record(body, 'input'))
  }

  @Post(':id/update')
  update(@Param('id') id: string) {
    return this.plugins.update(id)
  }

  @Post(':id/enable')
  enable(@Param('id') id: string, @Body() body: unknown) {
    return this.plugins.enable(id, grant(body))
  }

  @Post(':id/disable')
  disable(@Param('id') id: string) {
    return this.plugins.disable(id)
  }

  @Patch(':id/settings')
  settings(@Param('id') id: string, @Body() body: unknown) {
    return this.plugins.updateSettings(id, record(body, 'values'))
  }

  @Delete(':id')
  uninstall(@Param('id') id: string) {
    return this.plugins.uninstall(id)
  }

  @Post(':id/commands/:command')
  command(@Param('id') id: string, @Param('command') command: string, @Body() body: unknown) {
    return this.plugins.runCommand(id, command, record(body, 'args'))
  }

  @Post(':id/views/:view')
  view(@Param('id') id: string, @Param('view') view: string, @Body() body: unknown) {
    return this.plugins.renderView(id, view, record(body, 'input'))
  }

  @Post(':id/tools/:tool')
  tool(@Param('id') id: string, @Param('tool') tool: string, @Body() body: unknown) {
    return this.plugins.invokeTool(id, tool, record(body, 'args'))
  }
}
