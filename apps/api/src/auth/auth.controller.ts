import { Body, Controller, Get, Headers, Post } from '@nestjs/common'
import { AuthService } from './auth.service.js'

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: Parameters<AuthService['register']>[0]) {
    return this.auth.register(body)
  }

  @Post('login')
  login(@Body() body: Parameters<AuthService['login']>[0]) {
    return this.auth.login(body)
  }

  @Get('me')
  me(@Headers('authorization') authorization?: string) {
    return this.auth.me(this.bearerToken(authorization))
  }

  @Post('logout')
  logout(@Headers('authorization') authorization?: string) {
    return this.auth.logout(this.bearerToken(authorization))
  }

  private bearerToken(value: string | undefined) {
    if (!value?.toLowerCase().startsWith('bearer ')) return undefined
    return value.slice(7).trim()
  }
}
