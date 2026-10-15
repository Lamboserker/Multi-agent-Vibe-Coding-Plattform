import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { oneOf, str } from '../common/validate.js'
import { ExecutionService } from './execution.service.js'

@Controller()
export class ExecutionController {
  constructor(private readonly executions: ExecutionService) {}

  @Post('tasks/:id/plan-with-orchestrator')
  plan(@Param('id') id: string, @Body() body: unknown) {
    return this.executions.requestPlan(id, str(body, 'feedback', { optional: true, max: 10_000 }) || undefined)
  }

  @Get('tasks/:id/routing')
  routing(@Param('id') id: string) {
    return this.executions.previewRouting(id)
  }

  @Post('tasks/:id/execute')
  execute(@Param('id') id: string) {
    return this.executions.start(id)
  }

  @Post('subtasks/:id/model')
  setModel(@Param('id') id: string, @Body() body: unknown) {
    const model = (body as { model?: unknown })?.model
    return this.executions.setManualModel(id, model === null ? null : str(body, 'model', { max: 140 }))
  }

  @Post('subtasks/:id/retry')
  retry(@Param('id') id: string) {
    return this.executions.retryTask(id)
  }

  @Post('subtasks/:id/cancel')
  cancelTask(@Param('id') id: string) {
    return this.executions.cancelTask(id)
  }

  @Get('projects/:id/executions')
  list(@Param('id') id: string) {
    return this.executions.listForProject(id)
  }

  @Get('executions/:id')
  detail(@Param('id') id: string) {
    return this.executions.detail(id)
  }

  @Get('executions/:id/events')
  events(@Param('id') id: string, @Query('after') after?: string, @Query('afterId') afterId?: string, @Query('limit') limit?: string) {
    return this.executions.events_(id, after || undefined, limit ? Number(limit) || 500 : 500, afterId || undefined)
  }

  @Post('executions/:id/pause')
  pause(@Param('id') id: string) {
    return this.executions.pause(id)
  }

  @Post('executions/:id/resume')
  resume(@Param('id') id: string) {
    return this.executions.resumePaused(id)
  }

  /** Continue an interrupted/failed run with its completed tasks kept. */
  @Post('executions/:id/continue')
  continueRun(@Param('id') id: string) {
    return this.executions.resume(id)
  }

  @Post('executions/:id/cancel')
  cancel(@Param('id') id: string) {
    return this.executions.cancel(id)
  }

  @Post('executions/:id/approve')
  approve(@Param('id') id: string, @Body() body: unknown) {
    return this.executions.approve(id, oneOf(body, 'mode', ['branch', 'working_tree', 'fast_forward'] as const))
  }

  @Post('executions/:id/discard')
  discard(@Param('id') id: string) {
    return this.executions.discard(id)
  }

  @Post('apply-records/:id/undo')
  undo(@Param('id') id: string) {
    return this.executions.undo(id)
  }

  @Get('stats/models')
  stats() {
    return this.executions.suitability()
  }

  @Get('usage')
  usage(@Query('executionId') executionId?: string, @Query('days') days?: string) {
    const since = days ? new Date(Date.now() - Number(days) * 86_400_000) : undefined
    return this.executions.usage({ executionId, since })
  }
}
