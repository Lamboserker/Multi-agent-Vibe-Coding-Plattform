import { mkdtempSync, promises as fs, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { git } from './git/git.js'

const created: string[] = []

// Remove every temp directory of a test file once it finishes (worktrees and repos included).
afterAll(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Windows may still hold a handle; the OS temp cleaner removes leftovers.
    }
  }
})

/** Creates a throwaway git repository with the given files committed on "main". Test helper. */
export async function createTempRepo(files: Record<string, string>, prefix = 'mac-repo-'): Promise<string> {
  const dir = tempDir(prefix)
  await git(dir, ['init', '-q', '-b', 'main'])
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(dir, file)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, content, 'utf8')
  }
  await git(dir, ['add', '-A'], { internal: true })
  await git(dir, ['commit', '-q', '-m', 'initial'], { internal: true })
  return dir
}

export function tempDir(prefix = 'mac-tmp-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}
