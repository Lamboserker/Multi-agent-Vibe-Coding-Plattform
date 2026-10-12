import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { PrismaService } from '../common/prisma.service.js'

interface AuthInput {
  email: string
  password: string
  name?: string
  keepSession?: boolean
}

const idleTimeoutMs = 30 * 60 * 1000
const defaultSessionMaxAgeMs = 8 * 60 * 60 * 1000
const extendedSessionMaxAgeMs = 30 * 24 * 60 * 60 * 1000

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async register(input: AuthInput) {
    const email = this.normalizeEmail(input.email)
    const password = input.password?.trim()
    const name = input.name?.trim() || email.split('@')[0] || 'Operator'

    if (!email || !email.includes('@')) throw new BadRequestException('A valid email is required.')
    if (!password || password.length < 8) throw new BadRequestException('Password must be at least 8 characters.')

    const existing = await this.prisma.authUser.findUnique({ where: { email } })
    if (existing) throw new ConflictException('An account with this email already exists.')

    const user = await this.prisma.authUser.create({
      data: {
        email,
        name,
        passwordHash: this.hashPassword(password),
      },
    })

    return this.createAuthResponse(user, Boolean(input.keepSession))
  }

  async login(input: AuthInput) {
    const email = this.normalizeEmail(input.email)
    const user = await this.prisma.authUser.findUnique({ where: { email } })
    if (!user || !this.verifyPassword(input.password ?? '', user.passwordHash)) {
      throw new UnauthorizedException('Invalid email or password.')
    }

    return this.createAuthResponse(user, Boolean(input.keepSession))
  }

  async me(token: string | undefined) {
    const session = await this.findSession(token)
    if (!session) throw new UnauthorizedException('Session is invalid or expired.')
    return { user: this.publicUser(session.user), expiresAt: session.expiresAt }
  }

  async validateSession(token: string | undefined) {
    return Boolean(await this.findSession(token))
  }

  async logout(token: string | undefined) {
    if (!token) return { ok: true }
    await this.prisma.authSession.deleteMany({ where: { tokenHash: this.hashToken(token) } })
    return { ok: true }
  }

  private async createAuthResponse(user: { id: string; email: string; name: string; createdAt: Date }, keepSession: boolean) {
    const token = randomBytes(32).toString('base64url')
    const now = new Date()
    const expiresAt = new Date(now.getTime() + (keepSession ? extendedSessionMaxAgeMs : defaultSessionMaxAgeMs))
    await this.prisma.authSession.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(token),
        expiresAt,
        lastActiveAt: now,
      },
    })

    return { token, user: this.publicUser(user), expiresAt }
  }

  private async findSession(token: string | undefined) {
    if (!token) return null
    const tokenHash = this.hashToken(token)
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash },
      include: { user: true },
    })
    const now = Date.now()
    const idleExpired = session ? now - session.lastActiveAt.getTime() >= idleTimeoutMs : false
    const maxExpired = session ? session.expiresAt.getTime() <= now : false

    if (!session) return null
    if (idleExpired || maxExpired) {
      await this.prisma.authSession.deleteMany({ where: { tokenHash } })
      return null
    }

    return this.prisma.authSession.update({
      where: { id: session.id },
      data: { lastActiveAt: new Date(now) },
      include: { user: true },
    })
  }

  private hashPassword(password: string) {
    const salt = randomBytes(16).toString('base64url')
    const derived = scryptSync(password, salt, 64).toString('base64url')
    return `scrypt:${salt}:${derived}`
  }

  private verifyPassword(password: string, stored: string) {
    const [, salt, hash] = stored.split(':')
    if (!salt || !hash) return false
    const derived = scryptSync(password, salt, 64)
    const expected = Buffer.from(hash, 'base64url')
    return expected.length === derived.length && timingSafeEqual(expected, derived)
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex')
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase()
  }

  private publicUser(user: { id: string; email: string; name: string; createdAt: Date }) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    }
  }
}
