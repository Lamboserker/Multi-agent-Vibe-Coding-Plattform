import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common'
import { ModelsService } from './models.service.js'

@Controller('models')
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get()
  findAll() {
    return this.models.findAll()
  }

  @Get('availability')
  availability() {
    return this.models.availability()
  }

  @Post()
  create(@Body() body: Parameters<ModelsService['create']>[0]) {
    return this.models.create(body)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Parameters<ModelsService['update']>[1]) {
    return this.models.update(id, body)
  }

  @Post('test-connection')
  testConnection(@Body() body: Parameters<ModelsService['testConnection']>[0]) {
    return this.models.testConnection(body)
  }

  @Post('test')
  test(@Body() body: Parameters<ModelsService['testConnection']>[0]) {
    return this.models.testConnection(body)
  }
}
