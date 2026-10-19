import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureRepository } from './workspace-fs.service.js'

const dirs: string[] = []
const tempProject = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mac-ensure-repo-'))
  dirs.push(dir)
  return dir
}
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ensureRepository', () => {
  it('turns a plain folder into a repository with a first commit, without dependencies or secrets', async () => {
    const dir = tempProject()
    writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>\n')
    writeFileSync(path.join(dir, '.env'), 'TOKEN=secret\n')
    mkdirSync(path.join(dir, 'node_modules', 'lib'), { recursive: true })
    writeFileSync(path.join(dir, 'node_modules', 'lib', 'index.js'), 'module.exports = 1\n')
    expect(await ensureRepository(dir)).toEqual({ initialized: true, committed: true, hasCommit: true })
    expect(git(dir, 'log', '--format=%s')).toBe('Initial commit')
    expect(git(dir, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'index.html'])
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('node_modules/')
  })

  it('commits a repository without commits and keeps an existing .gitignore', async () => {
    const dir = tempProject()
    git(dir, 'init', '-q')
    writeFileSync(path.join(dir, '.gitignore'), 'secret.txt\n')
    writeFileSync(path.join(dir, 'secret.txt'), 'x\n')
    writeFileSync(path.join(dir, 'app.ts'), 'export {}\n')
    expect(await ensureRepository(dir)).toMatchObject({ initialized: false, committed: true, hasCommit: true })
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('secret.txt\n')
    expect(git(dir, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'app.ts'])
  })

  it('keeps secrets and dependencies out of the first commit even with an incomplete .gitignore', async () => {
    const dir = tempProject()
    writeFileSync(path.join(dir, '.gitignore'), 'dist/\n')
    const files: Record<string, string> = {
      'src/app.ts': 'export {}\n',
      '.env': 'TOKEN=secret\n',
      '.env.local': 'TOKEN=local\n',
      '.env.example': 'TOKEN=\n',
      'id_rsa': 'PRIVATE KEY\n',
      'config/credentials.json': '{"key":"x"}\n',
      'certs/server.pem': 'CERT\n',
      'node_modules/lib/index.js': 'module.exports = 1\n',
      'packages/web/node_modules/dep/index.js': 'module.exports = 2\n',
      'packages/web/index.ts': 'export {}\n',
      '.venv/lib/site.py': 'x = 1\n',
    }
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      writeFileSync(path.join(dir, file), content)
    }
    const result = await ensureRepository(dir)
    expect(result).toMatchObject({ initialized: true, committed: true, hasCommit: true })
    expect(git(dir, 'ls-files').split('\n').sort()).toEqual(['.env.example', '.gitignore', 'packages/web/index.ts', 'src/app.ts'])
    // reported so the user can extend the .gitignore; the user's .gitignore itself is not changed
    expect(result.excluded?.sort()).toEqual(['.env', '.env.local', '.venv/', 'certs/server.pem', 'config/credentials.json', 'id_rsa', 'node_modules/'])
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('dist/\n')
  })

  it('also takes a secret out that was already staged in a repository without commits', async () => {
    const dir = tempProject()
    git(dir, 'init', '-q')
    writeFileSync(path.join(dir, '.env'), 'TOKEN=secret\n')
    writeFileSync(path.join(dir, 'app.ts'), 'export {}\n')
    git(dir, 'add', '.env', 'app.ts')
    const result = await ensureRepository(dir)
    expect(result.hasCommit).toBe(true)
    expect(git(dir, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'app.ts'])
    expect(readFileSync(path.join(dir, '.env'), 'utf8')).toBe('TOKEN=secret\n')
  })

  it('never touches a repository that already has history, and an empty folder gets an empty first commit', async () => {
    const dir = tempProject()
    git(dir, 'init', '-q')
    writeFileSync(path.join(dir, 'a.txt'), 'a\n')
    git(dir, 'add', '.')
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'mine')
    writeFileSync(path.join(dir, 'b.txt'), 'uncommitted\n')
    const head = git(dir, 'rev-parse', 'HEAD')
    expect(await ensureRepository(dir)).toEqual({ initialized: false, committed: false, hasCommit: true })
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(dir, 'status', '--porcelain')).toBe('?? b.txt')

    const empty = tempProject()
    expect(await ensureRepository(empty)).toMatchObject({ initialized: true, hasCommit: true })
  })

  it('does not turn the home folder into a repository on its own', async () => {
    expect(await ensureRepository(os.homedir())).toMatchObject({ hasCommit: false, skipped: expect.stringContaining('home folder') })
  })
})
