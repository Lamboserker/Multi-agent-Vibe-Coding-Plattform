import { Body, Controller, Post } from '@nestjs/common'
import { ProvidersService } from './providers.service.js'

@Controller('providers')
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Post('ollama/test')
  testOllama(@Body() body: { baseUrl?: string }) {
    return this.providers.testOllama(body)
  }

  @Post('openai-compatible/test')
  testOpenAICompatible(@Body() body: { baseUrl?: string; apiKeyEnvName?: string }) {
    return this.providers.testOpenAICompatible(body)
  }

  @Post('gemini-cli/test')
  testGeminiCli() {
    return this.providers.testGeminiCli()
  }
}
