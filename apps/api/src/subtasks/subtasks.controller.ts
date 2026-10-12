import { Body, Controller, Param, Patch, Post } from '@nestjs/common'
import { SubtasksService } from './subtasks.service.js'

@Controller('subtasks')
export class SubtasksController {
  constructor(private readonly subtasks: SubtasksService) {}

  @Post(':id/run')
  run(@Param('id') id: string) {
    return this.subtasks.run(id)
  }

  @Post(':id/retry')
  retry(@Param('id') id: string) {
    return this.subtasks.retry(id)
  }

  @Post(':id/escalate')
  escalate(@Param('id') id: string) {
    return this.subtasks.escalate(id)
  }

  @Patch(':id/model')
  changeModel(@Param('id') id: string, @Body() body: Parameters<SubtasksService['changeModel']>[1]) {
    return this.subtasks.changeModel(id, body)
  }
}
