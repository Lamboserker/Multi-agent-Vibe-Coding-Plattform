import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTempRepo, tempDir } from '../test-utils.js'
import { validatePatch } from '../patch/validator.js'
import { WorkspaceFiles } from '../patch/workspace-files.js'
import { applyPatch, cherryPick, commitStaged, currentBranch, diffBetween, git, headCommit, integratedTaskCommits, parsePorcelainZ, squashSince, stageAll, status } from './git.js'

describe('worktree pool', () => {
  it('reuses an idle worktree: base content restored, task branches swapped, leftovers removed', async () => {
    const repo = await createTempRepo({ 'a.txt': 'base\n', '.gitignore': 'dist\n' })
    await fs.mkdir(path.join(repo, 'node_modules', 'dep'), { recursive: true })
    const base = (await headCommit(repo))!
    const manager = new WorktreeManager({ root: tempDir('mac-pool-'), poolSize: 2 })

    const first = await manager.create(repo, { projectKey: 'demo', name: 'run-task-1', branch: 'mac/run/task-1', baseCommit: base })
    await fs.writeFile(path.join(first.path, 'a.txt'), 'changed by task 1\n')
    await fs.writeFile(path.join(first.path, 'untracked.txt'), 'x')
    await fs.mkdir(path.join(first.path, 'dist'), { recursive: true })
    await fs.writeFile(path.join(first.path, 'dist', 'out.js'), 'x')
    await stageAll(first.path)
    await commitStaged(first.path, 'task-1: change')
    await manager.remove(repo, first.path, first.branch)

    const second = await manager.create(repo, { projectKey: 'demo', name: 'run-task-2', branch: 'mac/run/task-2', baseCommit: base })
    expect(second.path).toBe(first.path) // the same directory is reused
    expect((await fs.readFile(path.join(second.path, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('base\n')
    expect(existsSync(path.join(second.path, 'untracked.txt'))).toBe(false)
    expect(existsSync(path.join(second.path, 'dist'))).toBe(false)
    expect(existsSync(path.join(second.path, 'node_modules', 'dep'))).toBe(true) // dependency link kept
    expect(await currentBranch(second.path)).toBe('mac/run/task-2')
    expect((await git(repo, ['branch', '--list', 'mac/run/task-1'])).stdout.trim()).toBe('')

    // pool exhausted → a regular worktree is created
    const third = await manager.create(repo, { projectKey: 'demo', name: 'run-task-3', branch: 'mac/run/task-3', baseCommit: base })
    const fourth = await manager.create(repo, { projectKey: 'demo', name: 'run-task-4', branch: 'mac/run/task-4', baseCommit: base })
    expect(new Set([second.path, third.path, fourth.path]).size).toBe(3)
    expect(path.basename(fourth.path)).toBe('run-task-4')
    for (const handle of [second, third, fourth]) await manager.remove(repo, handle.path, handle.branch)
    // the real node_modules was never touched by cleaning
    expect(existsSync(path.join(repo, 'node_modules', 'dep'))).toBe(true)
  })
})

describe('task commits on the integration branch', () => {
  it('squashes a task commit and a follow-up formatting commit into one commit', async () => {
    const repo = await createTempRepo({ 'a.txt': 'a\n' })
    const base = (await headCommit(repo))!
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n')
    await stageAll(repo)
    await commitStaged(repo, 'task-001: add b')
    await fs.writeFile(path.join(repo, 'b.txt'), 'b formatted\n')
    await stageAll(repo)
    await commitStaged(repo, 'task-001: deterministic formatting')
    const squashed = await squashSince(repo, base, 'task-001: add b')
    const log = (await git(repo, ['log', '--format=%s', `${base}..${squashed}`])).stdout.trim().split('\n')
    expect(log).toEqual(['task-001: add b'])
    // the single commit carries both changes, so cherry-picking it integrates everything
    expect(await diffBetween(repo, base, squashed)).toContain('+b formatted')
  })

  it('recognises integrated tasks by their commit subject (newest commit per task)', async () => {
    const repo = await createTempRepo({ 'a.txt': 'a\n' })
    const base = (await headCommit(repo))!
    for (const [file, subject] of [['x.txt', 'task-1: first'], ['y.txt', 'task-10: other'], ['z.txt', 'task-1: again']] as const) {
      await fs.writeFile(path.join(repo, file), file)
      await stageAll(repo)
      await commitStaged(repo, subject)
    }
    const head = (await headCommit(repo))!
    const found = await integratedTaskCommits(repo, base, ['task-1', 'task-10', 'task-2'])
    expect(found.get('task-1')).toBe(head)
    expect(found.has('task-10')).toBe(true)
    expect(found.has('task-2')).toBe(false)
  })
})
import { overlappingDirtyFiles, WorktreeManager } from './worktrees.js'

describe('parsePorcelainZ', () => {
  it('parses modified, untracked and renamed entries', () => {
    const entries = parsePorcelainZ(' M src/a.ts\0?? new.txt\0R  b.ts\0old-b.ts\0UU conflict.ts\0')
    expect(entries.map((entry) => entry.path)).toEqual(['src/a.ts', 'new.txt', 'b.ts', 'conflict.ts'])
    expect(entries[1]!.untracked).toBe(true)
    expect(entries[2]!.originalPath).toBe('old-b.ts')
    expect(entries[3]!.conflicted).toBe(true)
  })
})

describe('worktrees, patches and integration', () => {
  it('isolates agent changes in a worktree and validates the patch', async () => {
    const repo = await createTempRepo({
      'package.json': '{"name":"demo","scripts":{"test":"echo ok"}}\n',
      'src/index.ts': 'export const answer = 42\n',
      '.env': 'SECRET=1\n',
    })
    await fs.mkdir(path.join(repo, 'node_modules', 'dep'), { recursive: true })
    await fs.writeFile(path.join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    // Uncommitted user change in the main checkout must stay untouched.
    await fs.writeFile(path.join(repo, 'src', 'index.ts'), 'export const answer = 43 // user edit\n')

    const base = (await headCommit(repo))!
    const manager = new WorktreeManager({ root: tempDir('mac-wt-') })
    const worktree = await manager.create(repo, { projectKey: 'demo', name: 'task-1', branch: 'mac/test/task-1', baseCommit: base })

    expect(existsSync(path.join(worktree.path, 'node_modules', 'dep', 'index.js'))).toBe(true)
    // core.autocrlf may convert to CRLF on checkout; compare normalized content.
    expect((await fs.readFile(path.join(worktree.path, 'src', 'index.ts'), 'utf8')).replace(/\r\n/g, '\n')).toBe('export const answer = 42\n')

    const files = new WorkspaceFiles(worktree.path, {
      writablePatterns: ['src/**'],
      deniedPatterns: [],
      maxReadBytes: 10_000,
      maxWriteBytes: 10_000,
      allowDelete: false,
    })
    await files.write('src/greet.ts', 'export function greet(name: string) {\n  return `Hello ${name}`\n}\n')
    await files.edit('src/index.ts', 'export const answer = 42', 'export const answer = 42\nexport { greet } from "./greet"')
    await expect(files.write('.env', 'x')).rejects.toThrow()
    await expect(files.write('README.md', 'x')).rejects.toThrow(/writable scope/)

    await stageAll(worktree.path)
    const commit = await commitStaged(worktree.path, 'agent change')
    const validation = await validatePatch(worktree.path, base, commit)
    expect(validation.ok).toBe(true)
    expect(validation.files.map((file) => file.path).sort()).toEqual(['src/greet.ts', 'src/index.ts'])
    // node_modules link is never part of the patch
    expect(validation.diff).not.toContain('node_modules')

    // user's uncommitted change is intact and on its original branch
    expect(await fs.readFile(path.join(repo, 'src', 'index.ts'), 'utf8')).toContain('user edit')
    expect(await currentBranch(repo)).toBe('main')
    expect(await overlappingDirtyFiles(repo, ['src/index.ts', 'src/greet.ts'])).toEqual(['src/index.ts'])

    await manager.remove(repo, worktree.path, undefined, { deleteBranch: false })
    expect(existsSync(worktree.path)).toBe(false)
    // the real node_modules survived worktree removal
    expect(existsSync(path.join(repo, 'node_modules', 'dep', 'index.js'))).toBe(true)
  })

  it('blocks syntax errors, secrets and sensitive files', async () => {
    const repo = await createTempRepo({ 'src/a.ts': 'export const a = 1\n' })
    const base = (await headCommit(repo))!
    await fs.writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = (\n')
    await fs.writeFile(path.join(repo, 'src', 'key.ts'), 'export const key = "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"\n')
    await fs.writeFile(path.join(repo, '.env.local'), 'X=1\n')
    await stageAll(repo)
    const commit = await commitStaged(repo, 'bad change')
    const validation = await validatePatch(repo, base, commit)
    expect(validation.ok).toBe(false)
    const codes = validation.issues.map((issue) => issue.code)
    expect(codes).toContain('syntax_error')
    expect(codes).toContain('secret_added')
    expect(codes).toContain('sensitive_file')
  })

  it('detects cherry-pick conflicts and leaves the integration tree clean', async () => {
    const repo = await createTempRepo({ 'shared.ts': 'export const value = 1\n' })
    const base = (await headCommit(repo))!
    const manager = new WorktreeManager({ root: tempDir('mac-wt-') })
    const a = await manager.create(repo, { projectKey: 'p', name: 'a', branch: 'mac/a', baseCommit: base })
    const b = await manager.create(repo, { projectKey: 'p', name: 'b', branch: 'mac/b', baseCommit: base })
    await fs.writeFile(path.join(a.path, 'shared.ts'), 'export const value = 2\n')
    await fs.writeFile(path.join(b.path, 'shared.ts'), 'export const value = 3\n')
    await stageAll(a.path)
    const shaA = await commitStaged(a.path, 'a')
    await stageAll(b.path)
    const shaB = await commitStaged(b.path, 'b')

    const integration = await manager.create(repo, { projectKey: 'p', name: 'int', branch: 'mac/int', baseCommit: base })
    expect((await cherryPick(integration.path, shaA)).ok).toBe(true)
    const conflict = await cherryPick(integration.path, shaB)
    expect(conflict.ok).toBe(false)
    expect(conflict.conflicts).toEqual(['shared.ts'])
    expect((await status(integration.path)).filter((entry) => !entry.path.startsWith('node_modules'))).toEqual([])
  })

  it('applies a patch to the working tree and reverts it (undo)', async () => {
    const repo = await createTempRepo({ 'a.txt': 'one\n' })
    const base = (await headCommit(repo))!
    const manager = new WorktreeManager({ root: tempDir('mac-wt-') })
    const wt = await manager.create(repo, { projectKey: 'p', name: 'x', branch: 'mac/x', baseCommit: base })
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'two\n')
    await stageAll(wt.path)
    const sha = await commitStaged(wt.path, 'x')
    const patch = await diffBetween(wt.path, base, sha)

    expect((await applyPatch(repo, patch, { check: true })).ok).toBe(true)
    expect((await applyPatch(repo, patch)).ok).toBe(true)
    expect((await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('two\n')
    expect((await applyPatch(repo, patch, { reverse: true })).ok).toBe(true)
    expect((await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('one\n')
  })
})

