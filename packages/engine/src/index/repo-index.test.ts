import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTempRepo } from '../test-utils.js'
import { buildRepoIndex, refreshRepoIndex, type RepoIndex } from './repo-index.js'

const summary = (index: RepoIndex) => index.files.map((file) => `${file.path}#${file.hash}#${file.dependsOn.join(',')}`).sort()

describe('refreshRepoIndex', () => {
  it('produces the same index as a full rebuild for watcher-reported changes', async () => {
    const repo = await createTempRepo({
      '.gitignore': 'generated/\n',
      'package.json': '{"name":"demo","dependencies":{"react":"19"}}\n',
      'src/a.ts': "import { b } from './b'\nexport const a = b\n",
      'src/b.ts': 'export const b = 1\n',
      'src/old.ts': 'export const old = 1\n',
    })
    const initial = await buildRepoIndex(repo)

    await fs.writeFile(path.join(repo, 'src', 'b.ts'), 'export const b = 2\nexport function more() {}\n')
    await fs.rm(path.join(repo, 'src', 'old.ts'))
    await fs.mkdir(path.join(repo, 'src', 'feature'), { recursive: true })
    await fs.writeFile(path.join(repo, 'src', 'feature', 'c.ts'), "import { a } from '../a'\nexport const c = a\n")
    await fs.mkdir(path.join(repo, 'generated'), { recursive: true })
    await fs.writeFile(path.join(repo, 'generated', 'out.ts'), 'export const x = 1\n')

    // what a recursive watcher reports on Windows: files and (parent) directories
    const refreshed = await refreshRepoIndex(repo, initial, ['src', 'src/b.ts', 'src/old.ts', 'src/feature', 'generated', 'generated/out.ts'])
    const rebuilt = await buildRepoIndex(repo)
    expect(summary(refreshed)).toEqual(summary(rebuilt))
    expect(refreshed.files.some((file) => file.path.startsWith('generated/'))).toBe(false)
    expect(refreshed.files.find((file) => file.path === 'src/b.ts')?.symbols.map((symbol) => symbol.name)).toContain('more')
    expect(refreshed.frameworks).toContain('React')
  })

  it('returns the same object when nothing relevant changed', async () => {
    const repo = await createTempRepo({ 'src/a.ts': 'export const a = 1\n' })
    const initial = await buildRepoIndex(repo)
    expect(await refreshRepoIndex(repo, initial, ['src', 'src/a.ts', '.git/index'])).toBe(initial)
  })
})
