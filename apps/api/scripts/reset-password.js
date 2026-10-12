#!/usr/bin/env node
import { PrismaClient } from '@prisma/client'
import { scryptSync, randomBytes } from 'node:crypto'

const prisma = new PrismaClient()

const [, , email, password] = process.argv
if (!email || !password) {
  console.log('Usage: node scripts/reset-password.js email newPassword')
  process.exit(1)
}

const salt = randomBytes(16).toString('base64url')
const derived = scryptSync(password, salt, 64).toString('base64url')
const hash = `scrypt:${salt}:${derived}`

try {
  await prisma.authUser.update({ where: { email }, data: { passwordHash: hash } })
  console.log('Password updated for', email)
} catch (e) {
  console.error('Failed to update password:', e?.message ?? e)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
