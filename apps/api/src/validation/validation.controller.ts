import { Body, Controller, Param, Post } from '@nestjs/common'
import { ValidationService } from './validation.service.js'

@Controller('tasks/:id')
export class ValidationController {
  constructor(private readonly validation: ValidationService) {}

  @Post('validate')
  validate(@Param('id') id: string, @Body() body: { execute?: boolean }) {
    return this.validation.validateTask(id, body?.execute ?? false)
  }
}
