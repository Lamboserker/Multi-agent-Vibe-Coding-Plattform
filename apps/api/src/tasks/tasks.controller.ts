import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { TasksService } from './tasks.service.js'

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  create(@Body() body: Parameters<TasksService['create']>[0]) {
    return this.tasks.create(body)
  }

  @Get()
  findAll(@Query('projectId') projectId?: string) {
    return this.tasks.findAll(projectId)
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.tasks.findOne(id)
  }

  @Post(':id/analyze')
  analyze(@Param('id') id: string, @Body() body: Parameters<TasksService['analyze']>[1]) {
    return this.tasks.analyze(id, body ?? {})
  }

  @Post(':id/plan')
  plan(@Param('id') id: string, @Body() body: Parameters<TasksService['plan']>[1]) {
    return this.tasks.plan(id, body ?? {})
  }

  @Post(':id/assign-models')
  assignModels(@Param('id') id: string, @Body() body: Parameters<TasksService['assignModels']>[1]) {
    return this.tasks.assignModels(id, body ?? {})
  }

  @Post(':id/run')
  run(@Param('id') id: string) {
    return this.tasks.run(id)
  }

  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return this.tasks.stop(id)
  }

  @Post(':id/retry')
  retry(@Param('id') id: string) {
    return this.tasks.retry(id)
  }

  @Post(':id/review')
  review(@Param('id') id: string) {
    return this.tasks.review(id)
  }

  @Post(':id/apply')
  apply(@Param('id') id: string, @Body() body: { mode?: 'working_tree' | 'branch' | 'fast_forward' }) {
    return this.tasks.apply(id, body?.mode)
  }

  @Post(':id/discard')
  discard(@Param('id') id: string) {
    return this.tasks.discard(id)
  }

  @Post(':id/feedback')
  feedback(@Param('id') id: string, @Body() body: Parameters<TasksService['feedback']>[1]) {
    return this.tasks.feedback(id, body)
  }

  @Get(':id/runs')
  runs(@Param('id') id: string) {
    return this.tasks.runs(id)
  }

  @Get(':id/subtasks')
  subtasks(@Param('id') id: string) {
    return this.tasks.subtasks(id)
  }
}
