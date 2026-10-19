import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { git, headCommit } from '../git/git.js'
import { createTempRepo, tempDir } from '../test-utils.js'
import { applyChangeSet, applyRenames, catchUpIntegration, parseConflicts, resolveConflictText, type ConflictHunk } from './integrator.js'

const PAGE = '<html>\n<body>\n  <h1>Titel</h1>\n  <p>Text</p>\n</body>\n</html>\n'

/** A repository plus an integration worktree whose branch changed the same line as a newer commit on main. */
async function conflictingSetup() {
  const repo = await createTempRepo({ 'index.html': PAGE, 'README.md': '# Demo\n' })
  const base = (await headCommit(repo))!
  const worktree = path.join(tempDir('mac-integration-'), 'wt')
  await git(repo, ['worktree', 'add', '-q', '-b', 'mac/run/integration', worktree, base])
  await fs.writeFile(path.join(worktree, 'index.html'), PAGE.replace('<h1>Titel</h1>', '<h1>Titel</h1>\n  <nav>Menü</nav>'))
  await git(worktree, ['commit', '-q', '-am', 'agent: nav'], { internal: true })
  // meanwhile the user changes the same place on main
  await fs.writeFile(path.join(repo, 'index.html'), PAGE.replace('<h1>Titel</h1>', '<h1>Neuer Titel</h1>'))
  await git(repo, ['commit', '-q', '-am', 'user: title'], { internal: true })
  return { repo, worktree, base }
}

describe('conflict regions', () => {
  it('parses diff3 markers and keeps the text around them', () => {
    const text = 'a\n<<<<<<< ours\nA\n||||||| base\nB\n=======\nC\n>>>>>>> theirs\nz\n'
    expect(parseConflicts(text)).toEqual(['a\n', { agent: 'A\n', base: 'B\n', current: 'C\n' }, 'z\n'])
    expect(parseConflicts('<<<<<<< ours\nA\n=======\n')).toBeUndefined()
  })

  it('takes the changed side when the other one only differs in whitespace, asks the resolver otherwise', async () => {
    const text = '<<<<<<< ours\nx  = 1\n||||||| base\nx = 1\n=======\nx = 2\n>>>>>>> theirs\n'
    expect(await resolveConflictText('a.js', text)).toBe('x = 2\n')
    const asked: ConflictHunk[] = []
    const both = '<<<<<<< ours\nA\n||||||| base\nB\n=======\nC\n>>>>>>> theirs\n'
    expect(await resolveConflictText('a.js', both, async (hunk) => (asked.push(hunk), 'A\nC'))).toBe('A\nC\n')
    expect(asked[0]).toMatchObject({ path: 'a.js', agent: 'A\n', base: 'B\n', current: 'C\n' })
    // a resolver answer that still contains markers is not accepted
    expect(await resolveConflictText('a.js', both, async () => '<<<<<<< x\nA\n')).toBeUndefined()
  })
})

describe('catchUpIntegration', () => {
  it('merges a newer main into the result in the integration worktree, after which the result lands on main', async () => {
    const { repo, worktree, base } = await conflictingSetup()
    const input = { repoPath: repo, integrationWorktree: worktree, integrationBranch: 'mac/run/integration', mode: 'commit' as const, commitMessage: 'Multi-AI Coder: nav' }
    const refused = await applyChangeSet({ ...input, baseCommit: base })
    expect(refused).toMatchObject({ ok: false, reason: 'conflict' })
    const userHead = (await headCommit(repo))!

    const caughtUp = await catchUpIntegration({ integrationWorktree: worktree, target: userHead, message: 'merge main', resolve: async (hunk) => `${hunk.current}${hunk.agent.replace('<h1>Titel</h1>\n', '')}` })
    expect(caughtUp).toMatchObject({ ok: true, resolved: ['index.html'], unresolved: [] })
    // the user's checkout was not touched by the merge
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).toContain('Neuer Titel')
    expect(await fs.readFile(path.join(repo, 'index.html'), 'utf8')).not.toContain('Menü')

    const applied = await applyChangeSet({ ...input, baseCommit: userHead })
    expect(applied.ok).toBe(true)
    const page = await fs.readFile(path.join(repo, 'index.html'), 'utf8')
    expect(page).toContain('<h1>Neuer Titel</h1>')
    expect(page).toContain('<nav>Menü</nav>')
    expect(page).not.toMatch(/<{7}|>{7}/)
    expect((await git(repo, ['status', '--porcelain'])).stdout.trim()).toBe('')
  })

  it('leaves the integration branch exactly as it was when a conflict cannot be merged', async () => {
    const { repo, worktree } = await conflictingSetup()
    const before = await headCommit(worktree)
    const outcome = await catchUpIntegration({ integrationWorktree: worktree, target: (await headCommit(repo))!, message: 'merge main', resolve: async () => undefined })
    expect(outcome).toMatchObject({ ok: false, unresolved: ['index.html'] })
    expect(await headCommit(worktree)).toBe(before)
    expect((await git(worktree, ['status', '--porcelain'])).stdout.trim()).toBe('')
  })

  it('does nothing when the result already contains the current state', async () => {
    const { worktree, base } = await conflictingSetup()
    const before = await headCommit(worktree)
    expect(await catchUpIntegration({ integrationWorktree: worktree, target: base, message: 'merge' })).toMatchObject({ ok: true, head: before })
  })
})

describe('catchUpIntegration with deleted files', () => {
  it('does not bring back a file the user deleted while the agent changed it', async () => {
    const { repo, worktree } = await conflictingSetup()
    await git(repo, ['rm', '-q', 'index.html'])
    await git(repo, ['commit', '-q', '-m', 'user: remove page'], { internal: true })
    const before = await headCommit(worktree)
    const outcome = await catchUpIntegration({ integrationWorktree: worktree, target: (await headCommit(repo))!, message: 'merge main', resolve: async (hunk) => hunk.agent })
    expect(outcome).toMatchObject({ ok: false, unresolved: ['index.html'] })
    expect(await headCommit(worktree)).toBe(before)
  })
})

describe('applyRenames', () => {
  it('carries an identifier rename of the agent over to lines the user added', () => {
    expect(applyRenames({ base: '      <Badge label="beta" />\n', agent: '      <Tag label="beta" />\n', current: '      <Badge label="beta" />\n      <Badge label="neu" />\n' })).toBe('      <Tag label="beta" />\n      <Tag label="neu" />\n')
  })

  it('does not apply to changes that are more than renames', () => {
    expect(applyRenames({ base: 'a(1)\n', agent: 'a(1, 2)\n', current: 'a(3)\n' })).toBeUndefined()
    expect(applyRenames({ base: 'a + a\n', agent: 'b + c\n', current: 'a\n' })).toBeUndefined()
    expect(applyRenames({ base: 'x\n', agent: 'x\n', current: 'y\n' })).toBeUndefined()
  })
})
