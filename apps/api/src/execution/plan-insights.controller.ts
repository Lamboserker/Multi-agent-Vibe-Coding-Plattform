import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { str } from '../common/validate.js'
import { ResourceMonitorService } from '../local-models/resource-monitor.service.js'
import { PlanInsightsService } from './plan-insights.service.js'

@Controller()
export class PlanInsightsController {
  constructor(
    private readonly insights: PlanInsightsService,
    private readonly resources: ResourceMonitorService,
  ) {}

  /** Execution forecast of the plan: waves, waiting reasons, VRAM fit, critical path. */
  @Get('tasks/:id/forecast')
  forecast(@Param('id') id: string) {
    return this.insights.forecast(id)
  }

  @Post('subtasks/:id/hint')
  hint(@Param('id') id: string, @Body() body: unknown) {
    return this.insights.addHint(id, str(body, 'text', { max: 1000 }))
  }

  @Post('subtasks/:id/hint/remove')
  removeHint(@Param('id') id: string, @Body() body: unknown) {
    return this.insights.removeHint(id, str(body, 'text', { max: 1100 }))
  }

  @Get('executions/:id/file')
  file(@Param('id') id: string, @Query('path') file?: string) {
    return this.insights.executionFile(id, file ?? '')
  }

  /** Live load (CPU, RAM, GPU, VRAM, loaded models, slots); sampled on request. */
  @Get('system/resources')
  snapshot() {
    return this.resources.snapshot()
  }

  /** Live power draw, energy per day and costs from the configured electricity tariff. */
  @Get('system/energy')
  energy(@Query('days') days?: string) {
    return this.resources.energy(Number(days) || 30)
  }
}
