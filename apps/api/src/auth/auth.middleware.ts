import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common'
import { timingSafeEqual } from 'node:crypto'
import { runtimeConfig } from '../runtime/runtime-config.js'
import { AuthService } from './auth.service.js'

type RequestLike = {
  headers: {
    authorization?: string | string[]
  }
  query?: Record<string, unknown>
  originalUrl?: string
}

/**
 * Desktop mode: every request must carry the per-launch token that the Electron shell generated
 * (only the shell knows it; the runtime listens on 127.0.0.1 only).
 * Web mode: the existing user sessions apply.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService) {}

  async use(request: RequestLike, _response: unknown, next: () => void) {
    const token = this.bearerToken(request.headers.authorization) ?? this.queryToken(request)
    const config = runtimeConfig()
    if (config.desktop) {
      if (!token || !config.desktopToken || !safeEqual(token, config.desktopToken)) throw new UnauthorizedException('Invalid desktop session token.')
      return next()
    }
    const valid = await this.auth.validateSession(token)
    if (!valid) throw new UnauthorizedException('Session is invalid or expired.')
    next()
  }

  private bearerToken(value: string | string[] | undefined) {
    const header = Array.isArray(value) ? value[0] : value
    if (!header?.toLowerCase().startsWith('bearer ')) return undefined
    return header.slice(7).trim()
  }

  /** EventSource cannot send headers; the SSE endpoint accepts ?token=. */
  private queryToken(request: RequestLike) {
    if (!request.originalUrl?.startsWith('/events')) return undefined
    const value = request.query?.token
    return typeof value === 'string' ? value : undefined
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
