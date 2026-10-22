import { BadRequestException, Body, Controller, Delete, Get, Param, Post } from '@nestjs/common'
import { IntegrationsService, type SetupInput } from './integrations.service.js'

function input(body: unknown): SetupInput {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Ungültige Einrichtung.')
  const value = body as Record<string, unknown>
  for (const key of Object.keys(value)) if (!['values', 'install', 'installServer', 'installAddon', 'reuseServerId'].includes(key)) throw new BadRequestException('Unbekanntes Einrichtungsfeld.')
  if (value.values !== undefined && (!value.values || typeof value.values !== 'object' || Array.isArray(value.values) || Object.values(value.values).some((entry) => typeof entry !== 'string'))) throw new BadRequestException('Ungültige Parameter.')
  if (value.install !== undefined && (!Array.isArray(value.install) || value.install.some((entry) => typeof entry !== 'string'))) throw new BadRequestException('Ungültige Installationsauswahl.')
  for (const key of ['installServer', 'installAddon']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new BadRequestException('Ungültige Installationsauswahl.')
  if (value.reuseServerId !== undefined && (typeof value.reuseServerId !== 'string' || value.reuseServerId.length > 100)) throw new BadRequestException('Ungültige Serverauswahl.')
  return value as SetupInput
}

@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}
  @Get('catalog') catalog() { return this.integrations.catalog() }
  @Post('presets/:id/check') check(@Param('id') id: string) { return this.integrations.check(id) }
  @Post('presets/:id/setup') setup(@Param('id') id: string, @Body() body: unknown) { return this.integrations.start(id, input(body)) }
  @Get('jobs/:id') job(@Param('id') id: string) { return this.integrations.job(id) }
  @Post('jobs/:id/resume') resume(@Param('id') id: string, @Body() body: unknown) { return this.integrations.resume(id, input(body)) }
  @Post('jobs/:id/login') login(@Param('id') id: string) { return this.integrations.login(id) }
  @Post('jobs/:id/cancel') cancel(@Param('id') id: string) { return this.integrations.cancel(id) }
  @Post('jobs/:id/approve') approve(@Param('id') id: string, @Body() body: { roles?: unknown; allow?: unknown }) {
    if (!body || !Array.isArray(body.roles) || !Array.isArray(body.allow) || body.roles.some((entry) => typeof entry !== 'string') || body.allow.some((entry) => typeof entry !== 'string')) throw new BadRequestException('Rollen und konkrete Werkzeugfreigaben erforderlich.')
    return this.integrations.approve(id, body.roles, body.allow)
  }
  @Post('skills/:id/activation') skill(@Param('id') id: string, @Body() body: { enabled?: unknown }) {
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('Aktivierungszustand erforderlich.')
    return this.integrations.activateSkill(id, body.enabled)
  }
  @Post('bundles/:id/activate') activate(@Param('id') id: string, @Body() body: { optional?: unknown }) {
    if (body?.optional !== undefined && (!Array.isArray(body.optional) || body.optional.some((entry) => typeof entry !== 'string'))) throw new BadRequestException('Ungültige optionale Integrationen.')
    return this.integrations.activateBundle(id, (body?.optional ?? []) as string[])
  }
  @Delete('bundles/:id') detach(@Param('id') id: string) { return this.integrations.detachBundle(id) }
}
