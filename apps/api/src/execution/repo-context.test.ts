import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

process.env.MAC_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'mac-repoctx-data-'))
const { EventBusService } = await import('../runtime/event-bus.service.js')
const { RepoContextService } = await import('./repo-context.service.js')

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mac-repoctx-'))
  mkdirSync(path.join(dir, 'src'))
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return { dir, git }
}

describe('RepoContextService', () => {
  it('reuses the index without I/O, applies watcher changes incrementally and rescans on a branch switch', async () => {
    const { dir, git } = repo()
    const events = new EventBusService()
    let watching = true
    const service = new RepoContextService(events, { isWatching: () => watching } as never)
    service.onModuleInit()

    await service.index('p1', dir)
    expect(service.counters.lastMode).toBe('full')
    await service.index('p1', dir)
    expect(service.counters.lastMode).toBe('hit')

    writeFileSync(path.join(dir, 'src', 'b.ts'), 'export function added() {}\n')
    events.publish('project', 'files_changed', { projectId: 'p1', files: ['src', 'src/b.ts'] })
    const incremental = await service.index('p1', dir)
    expect(service.counters.lastMode).toBe('incremental')
    expect(incremental.files.map((file) => file.path)).toContain('src/b.ts')

    git('add', '-A')
    git('commit', '-q', '-m', 'second') // HEAD moved (e.g. branch switch / commit outside the app)
    await service.index('p1', dir)
    expect(service.counters.lastMode).toBe('full')

    events.publish('project', 'files_changed', { projectId: 'p1', files: [], truncated: true })
    await service.index('p1', dir)
    expect(service.counters.lastMode).toBe('full')

    watching = false // no watcher → never trust the cached state
    await service.index('p1', dir)
    expect(service.counters.lastMode).toBe('full')
    service.onModuleDestroy()
  })
})
