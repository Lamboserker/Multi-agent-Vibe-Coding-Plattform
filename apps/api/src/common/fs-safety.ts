import path from 'node:path'

export const SECRET_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  'id_rsa',
  'id_ed25519',
])

export const DEFAULT_IGNORES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '.cache',
  'tmp',
])

export function isSecretLikePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/')
  const baseName = path.basename(normalized)
  return (
    SECRET_FILE_NAMES.has(baseName) ||
    normalized.includes('/.env.') ||
    normalized.includes('/secrets/') ||
    normalized.endsWith('.pem') ||
    normalized.endsWith('.key')
  )
}

export function toRelativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).replaceAll('\\', '/')
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[REDACTED]')
}
