import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common'
import { bool, str } from '../common/validate.js'
import { LocalModelsService } from './local-models.service.js'

@Controller('local-models')
export class LocalModelsController {
  constructor(private readonly models: LocalModelsService) {}

  @Get('hardware')
  hardware(@Query('refresh') refresh?: string) {
    return this.models.hardware(refresh === '1')
  }

  @Get('ollama')
  ollama() {
    return this.models.ollamaStatus()
  }

  @Post('ollama/start')
  start() {
    return this.models.startOllama()
  }

  /** Installs Ollama via winget/brew. Requires {"consent": true}. */
  @Post('ollama/install')
  install(@Body() body: unknown) {
    return this.models.requestInstall(bool(body, 'consent'))
  }

  @Get('installed')
  installed() {
    return this.models.installed()
  }

  @Get('running')
  running() {
    return this.models.running()
  }

  @Get('recommendations')
  recommendations(@Query('refresh') refresh?: string) {
    return this.models.recommendations(refresh === '1')
  }

  /** Starts a download. Requires {"model": "...", "consent": true}; disk space is checked first. */
  @Post('pull')
  pull(@Body() body: unknown) {
    return this.models.requestPull(str(body, 'model', { max: 140 }), bool(body, 'consent'))
  }

  @Delete(':model')
  remove(@Param('model') model: string) {
    return this.models.deleteModel(decodeURIComponent(model))
  }

  @Post(':model/load')
  load(@Param('model') model: string) {
    return this.models.load(decodeURIComponent(model))
  }

  @Post(':model/unload')
  unload(@Param('model') model: string) {
    return this.models.unload(decodeURIComponent(model))
  }

  @Post(':model/self-test')
  selfTest(@Param('model') model: string) {
    return this.models.selfTest(decodeURIComponent(model))
  }

  @Put('roles')
  roles(@Body() body: Record<string, string | null>) {
    return this.models.assignRoles({ fast: body?.fast, balanced: body?.balanced, advanced: body?.advanced })
  }

  @Get('slots')
  async slots() {
    return { localSlots: await this.models.localSlots() }
  }
}
