import { realpathSync } from 'node:fs'
import path from 'node:path'

export class PathViolationError extends Error {
  constructor(
    message: string,
    readonly requestedPath: string,
  ) {
    super(message)
    this.name = 'PathViolationError'
  }
}

/** Directories that are never read or written by agents and never shown in indexes. */
export const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.idea',
  '.vscode-test',
])

const SECRET_BASENAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials',
  'credentials.json',
  'secrets.json',
  'auth.json',
  'service-account.json',
])

const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.kdbx', '.asc', '.gpg']

/** Normalizes to a forward-slash relative path without leading "./". */
export function normalizeRelative(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+/g, '/')
}

/** Secret-like files (credentials, keys, .env variants) are never sent to models and never written by agents. */
export function isSensitivePath(relativePath: string): boolean {
  const normalized = normalizeRelative(relativePath).toLowerCase()
  const base = path.posix.basename(normalized)
  if (SECRET_BASENAMES.has(base)) return true
  if (base.startsWith('.env.') && base !== '.env.example' && base !== '.env.sample' && base !== '.env.template') return true
  if (SECRET_EXTENSIONS.some((extension) => base.endsWith(extension))) return true
  if (/(^|\/)(secrets?|\.ssh|\.aws|\.gnupg|\.docker)\//.test(normalized)) return true
  return false
}

/** Files whose modification needs elevated review (CI, infra, migrations, auth, lockfiles, git hooks). */
export function isSecurityCriticalPath(relativePath: string): boolean {
  const normalized = normalizeRelative(relativePath).toLowerCase()
  return (
    /(^|\/)\.github\/workflows\//.test(normalized) ||
    /(^|\/)\.husky\//.test(normalized) ||
    /(^|\/)(dockerfile|docker-compose[^/]*\.ya?ml)$/.test(normalized) ||
    /(^|\/)(infra|terraform|k8s|helm|deploy|deployment)\//.test(normalized) ||
    /(^|\/)prisma\/migrations\//.test(normalized) ||
    /(^|\/)migrations?\//.test(normalized) ||
    /(^|\/)(auth|security|crypto|payment|billing)[^/]*\//.test(normalized) ||
    /(auth|session|password|token|crypto|permission)[^/]*\.(ts|tsx|js|jsx|py|go|rs|java|cs)$/.test(normalized) ||
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(normalized)
  )
}

export function isIgnoredPath(relativePath: string): boolean {
  return normalizeRelative(relativePath)
    .split('/')
    .some((segment) => IGNORED_DIRECTORIES.has(segment))
}

/**
 * Resolves a model- or user-supplied relative path inside `root`. Rejects absolute paths, drive
 * letters, traversal, NUL bytes, alternate data streams and symlinks that escape the root.
 */
export function resolveInside(root: string, requested: string): { absolute: string; relative: string } {
  if (typeof requested !== 'string' || !requested.trim()) throw new PathViolationError('Empty path.', String(requested))
  if (requested.includes('\0')) throw new PathViolationError('Path contains a NUL byte.', requested)
  const normalized = normalizeRelative(requested.trim())
  if (path.isAbsolute(requested) || path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new PathViolationError('Absolute paths are not allowed; use a path relative to the workspace.', requested)
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new PathViolationError('Path traversal ("..") is not allowed.', requested)
  }
  if (/:/.test(normalized)) throw new PathViolationError('Alternate data streams / colons are not allowed in paths.', requested)

  const rootResolved = path.resolve(root)
  const absolute = path.resolve(rootResolved, normalized)
  const relative = path.relative(rootResolved, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PathViolationError('Path resolves outside the workspace.', requested)
  }

  // Symlink escape check on the deepest existing ancestor.
  const realRoot = safeRealpath(rootResolved) ?? rootResolved
  let probe = absolute
  while (probe.length >= rootResolved.length) {
    const real = safeRealpath(probe)
    if (real) {
      const realRelative = path.relative(realRoot, real)
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new PathViolationError('Path resolves through a symlink outside the workspace.', requested)
      }
      break
    }
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }

  return { absolute, relative: relative.replaceAll('\\', '/') }
}

function safeRealpath(target: string): string | undefined {
  try {
    return realpathSync.native(target)
  } catch {
    return undefined
  }
}

/** Glob-lite matcher supporting "**", "*" and "?" for allow/deny scopes. */
export function matchesPattern(relativePath: string, pattern: string): boolean {
  const target = normalizeRelative(relativePath)
  const normalizedPattern = normalizeRelative(pattern)
  if (!/[*?]/.test(normalizedPattern)) {
    return target === normalizedPattern || target.startsWith(normalizedPattern.replace(/\/$/, '') + '/')
  }
  let regex = ''
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index]!
    if (char === '*') {
      if (normalizedPattern[index + 1] === '*') {
        const followedBySlash = normalizedPattern[index + 2] === '/'
        regex += followedBySlash ? '(?:.*/)?' : '.*'
        index += followedBySlash ? 2 : 1
      } else {
        regex += '[^/]*'
      }
    } else if (char === '?') {
      regex += '[^/]'
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${regex}$`).test(target)
}

export function matchesAny(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(relativePath, pattern))
}

const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})/g, '[REDACTED_KEY]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\b(xox[abpr]-[A-Za-z0-9-]{10,})/g, '[REDACTED_SLACK_TOKEN]'],
  [/\b(AKIA[0-9A-Z]{16})\b/g, '[REDACTED_AWS_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED_GOOGLE_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]'],
  [/((?:api[_-]?key|secret|password|passwd|token|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^"'\s,;]{6,})/gi, '$1[REDACTED]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)([^@/\s]{3,})(@)/gi, '$1[REDACTED]$3'],
]

/** Removes credential-looking values before text is sent to any model or written to logs. */
export function redactSecrets(value: string): string {
  let result = value
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) result = result.replace(pattern, replacement)
  return result
}
