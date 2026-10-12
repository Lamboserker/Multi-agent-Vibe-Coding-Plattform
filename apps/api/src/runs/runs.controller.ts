import { Controller, Get, Param } from '@nestjs/common'
import { RunsService } from './runs.service.js'

@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.runs.findOne(id)
  }

  @Get(':id/logs')
  logs(@Param('id') id: string) {
    return this.runs.logs(id)
  }

  @Get(':id/diff')
  diff(@Param('id') id: string) {
    return this.runs.diff(id)
  }

  @Get(':id/validation')
  validation(@Param('id') id: string) {
    return this.runs.validation(id)
  }
}
