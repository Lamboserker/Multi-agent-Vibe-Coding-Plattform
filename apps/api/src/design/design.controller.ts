import { Body, Controller, Get, Param, Post } from '@nestjs/common'
import { str } from '../common/validate.js'
import { ExecutionService } from '../execution/execution.service.js'
import { DESIGN_APPROVED_TEXT, DESIGN_REGENERATE_TEXT, DESIGN_REVISION_TEXT, DESIGN_SKIPPED_TEXT, DesignService } from './design.service.js'

/**
 * Design phase of a task: preview, approve, revise, skip. Planning is started through ExecutionService.
 * Every decision gets the same chat note as the answer in the chat, so the conversation shows what happened.
 */
@Controller('tasks/:id/design')
export class DesignController {
  constructor(
    private readonly design: DesignService,
    private readonly executions: ExecutionService,
  ) {}

  /** Latest draft with spec and mockup (null when the task has none). */
  @Get()
  async latest(@Param('id') id: string) {
    return (await this.design.latest(id)) ?? null
  }

  /** All versions (without mockups). */
  @Get('versions')
  list(@Param('id') id: string) {
    return this.design.list(id)
  }

  @Post('approve')
  async approve(@Param('id') id: string) {
    const draft = await this.design.approve(id)
    const plan = await this.executions.requestPlan(id)
    await this.design.note(id, DESIGN_APPROVED_TEXT, plan.design ? 'design_requested' : 'planning')
    return { draft, ...plan }
  }

  @Post('reject')
  async reject(@Param('id') id: string, @Body() body: unknown) {
    const started = await this.design.reject(id, str(body, 'feedback', { max: 10_000 }))
    await this.design.note(id, DESIGN_REVISION_TEXT, 'design_requested')
    return started
  }

  @Post('skip')
  async skip(@Param('id') id: string) {
    await this.design.skip(id)
    const plan = await this.executions.requestPlan(id)
    await this.design.note(id, DESIGN_SKIPPED_TEXT, 'planning')
    return plan
  }

  /** A new draft without feedback (e.g. after a failed or interrupted design call). */
  @Post('regenerate')
  async regenerate(@Param('id') id: string) {
    const started = await this.design.regenerate(id)
    await this.design.note(id, DESIGN_REGENERATE_TEXT, 'design_requested')
    return started
  }
}
