import { Controller, Get, Param } from '@nestjs/common'
import { CostsService } from './costs.service.js'

@Controller()
export class CostsController {
  constructor(private readonly costs: CostsService) {}

  @Get('tasks/:id/cost')
  taskCost(@Param('id') id: string) {
    return this.costs.taskCost(id)
  }

  @Get('cost/summary')
  summary() {
    return this.costs.summary()
  }
}
