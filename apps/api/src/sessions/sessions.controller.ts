import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common'
import { bool, num, oneOf, str } from '../common/validate.js'
import { ORCHESTRATOR_OVERRIDES } from '../orchestration/orchestrator-choice.js'
import { SessionsService } from './sessions.service.js'

@Controller()
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get('projects/:id/sessions')
  list(@Param('id') projectId: string, @Query('archived') archived?: string, @Query('q') query?: string) {
    return this.sessions.list(projectId, { includeArchived: archived === '1', query: query?.slice(0, 200) || undefined })
  }

  @Post('projects/:id/sessions')
  create(@Param('id') projectId: string, @Body() body: unknown) {
    return this.sessions.create(projectId, str(body, 'title', { optional: true, max: 200 }) || undefined)
  }

  /** Full-text search over all messages of a project. */
  @Get('projects/:id/session-search')
  search(@Param('id') projectId: string, @Query('q') query = '') {
    return this.sessions.search(projectId, query.slice(0, 200))
  }

  @Get('sessions/:id')
  get(@Param('id') id: string, @Query('limit') limit?: string, @Query('before') before?: string) {
    return this.sessions.get(id, { limit: limit ? Number(limit) : undefined, before: before || undefined })
  }

  @Patch('sessions/:id')
  update(@Param('id') id: string, @Body() body: unknown) {
    const record = (body ?? {}) as Record<string, unknown>
    return this.sessions.update(id, {
      title: record.title === undefined ? undefined : str(body, 'title', { max: 200 }),
      pinned: record.pinned === undefined ? undefined : bool(body, 'pinned'),
      archived: record.archived === undefined ? undefined : bool(body, 'archived'),
    })
  }

  @Delete('sessions/:id')
  remove(@Param('id') id: string) {
    return this.sessions.remove(id)
  }

  @Post('sessions/:id/messages')
  send(@Param('id') id: string, @Body() body: unknown) {
    return this.sessions.send(id, {
      content: str(body, 'content', { max: 50_000 }),
      mode: oneOf(body, 'mode', ['task', 'ask'] as const, 'task'),
      autoRun: bool(body, 'autoRun'),
      clientId: str(body, 'clientId', { optional: true, max: 80 }) || undefined,
      designMode: (body as { designMode?: unknown } | undefined)?.designMode === undefined ? undefined : oneOf(body, 'designMode', ['auto', 'force', 'skip'] as const),
      orchestrator: (body as { orchestrator?: unknown } | undefined)?.orchestrator == null ? undefined : oneOf(body, 'orchestrator', ORCHESTRATOR_OVERRIDES),
    })
  }

  @Post('sessions/:id/retry-plan')
  retryPlan(@Param('id') id: string, @Body() body: unknown) {
    return this.sessions.retryPlan(id, str(body, 'taskId', { optional: true, max: 64 }) || undefined)
  }

  @Get('sessions/:id/export')
  export(@Param('id') id: string, @Query('format') format?: string) {
    return this.sessions.export(id, format === 'json' ? 'json' : 'md')
  }

  /** Work running in the runtime right now, across projects (status bar / job indicator). */
  @Get('activity')
  activity() {
    return this.sessions.activity()
  }

  @Get('sessions/:id/messages')
  messages(@Param('id') id: string, @Query('before') before?: string, @Query('limit') limit?: string) {
    return this.sessions.get(id, { before: before || undefined, limit: limit ? num({ limit: Number(limit) }, 'limit', { min: 1, max: 500 }) : 100 })
  }
}
