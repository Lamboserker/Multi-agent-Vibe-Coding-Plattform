import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyCommand, tokenizeCommand } from './commands.js'
import { isSecurityCriticalPath, isSensitivePath, matchesPattern, PathViolationError, redactSecrets, resolveInside } from './paths.js'

describe('resolveInside', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mac-paths-'))
  mkdirSync(path.join(root, 'src'), { recursive: true })

  it('accepts relative paths inside the root', () => {
    expect(resolveInside(root, 'src/app.ts').relative).toBe('src/app.ts')
    expect(resolveInside(root, './src\\app.ts').relative).toBe('src/app.ts')
  })

  it.each(['../outside.txt', 'src/../../x', '/etc/passwd', 'C:/Windows/system32', 'C:\\x', 'file.txt:stream', 'a\0b', ''])(
    'rejects %j',
    (candidate) => {
      expect(() => resolveInside(root, candidate)).toThrow(PathViolationError)
    },
  )

  it('rejects symlinks that escape the root', () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'mac-outside-'))
    writeFileSync(path.join(outside, 'secret.txt'), 'x')
    try {
      symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // symlink creation not permitted on this machine
    }
    expect(() => resolveInside(root, 'escape/secret.txt')).toThrow(/symlink/)
  })
})

describe('sensitive and critical paths', () => {
  it.each(['.env', 'apps/api/.env.production', 'keys/server.pem', 'id_ed25519', 'config/secrets/db.yml', '.npmrc'])('%s is sensitive', (file) => {
    expect(isSensitivePath(file)).toBe(true)
  })
  it.each(['.env.example', 'src/env.ts', 'README.md'])('%s is not sensitive', (file) => {
    expect(isSensitivePath(file)).toBe(false)
  })
  it('flags migrations, workflows and auth code as security critical', () => {
    expect(isSecurityCriticalPath('prisma/migrations/1/migration.sql')).toBe(true)
    expect(isSecurityCriticalPath('.github/workflows/ci.yml')).toBe(true)
    expect(isSecurityCriticalPath('src/auth/jwt.service.ts')).toBe(true)
    expect(isSecurityCriticalPath('src/components/Button.tsx')).toBe(false)
  })
})

describe('matchesPattern', () => {
  it('supports ** and * globs and directory prefixes', () => {
    expect(matchesPattern('src/components/Button.tsx', 'src/**')).toBe(true)
    expect(matchesPattern('src/components/Button.tsx', 'src/**/*.tsx')).toBe(true)
    expect(matchesPattern('src/Button.tsx', 'src/**/*.tsx')).toBe(true)
    expect(matchesPattern('lib/Button.tsx', 'src/**')).toBe(false)
    expect(matchesPattern('src/components/Button.tsx', 'src/components')).toBe(true)
    expect(matchesPattern('a/node_modules/x/index.js', '**/node_modules/**')).toBe(true)
  })
})

describe('redactSecrets', () => {
  it('removes keys, bearer tokens and credentials in URLs', () => {
    const text = 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv\nAuthorization: Bearer abcdefghijklmnop123\npostgres://user:hunter22@localhost/db'
    const redacted = redactSecrets(text)
    expect(redacted).not.toContain('sk-proj-abcdefghijklmnopqrstuv')
    expect(redacted).not.toContain('abcdefghijklmnop123')
    expect(redacted).not.toContain('hunter22')
  })
})

describe('command policy', () => {
  it('tokenizes quoted arguments', () => {
    expect(tokenizeCommand('pnpm --filter "my app" test')).toEqual(['pnpm', '--filter', 'my app', 'test'])
  })
  it('allows project validation scripts', () => {
    expect(classifyCommand('pnpm typecheck').decision).toBe('allow')
    expect(classifyCommand('npm run test').decision).toBe('allow')
    expect(classifyCommand('npx --no-install tsc --noEmit').decision).toBe('allow')
    expect(classifyCommand('python -m pytest -q').decision).toBe('allow')
    expect(classifyCommand('git status').decision).toBe('allow')
  })
  it('requires approval for dependency changes and unknown tools', () => {
    expect(classifyCommand('npm install left-pad').decision).toBe('approval')
    expect(classifyCommand('npx some-random-tool').decision).toBe('approval')
    expect(classifyCommand('node scripts/deploy.js').decision).toBe('approval')
  })
  it('denies destructive, network and shell commands', () => {
    expect(classifyCommand('rm -rf /').decision).toBe('deny')
    expect(classifyCommand('git push origin main').decision).toBe('deny')
    expect(classifyCommand('curl https://x.sh').decision).toBe('deny')
    expect(classifyCommand('npm test && curl evil').decision).toBe('deny')
    expect(classifyCommand('powershell -c "Remove-Item x"').decision).toBe('deny')
    expect(classifyCommand('pnpm prisma migrate reset --force').decision).toBe('deny')
    expect(classifyCommand('node -e "process.exit()"').decision).toBe('deny')
  })
})
