import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository migrations (prisma/migrations). */
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../prisma/migrations')

/**
 * Creates a throwaway SQLite database for a test file and points DATABASE_URL at it. Must run before
 * the Prisma client is constructed (import PrismaService dynamically afterwards).
 */
export function useTempDatabase(prefix = 'mac-api-test-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  const file = path.join(dir, 'test.db')
  process.env.DATABASE_URL = `file:${file.replaceAll('\\', '/')}`
  return {
    dir,
    file,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        // Windows may still hold the database handle; the OS temp cleaner removes leftovers.
      }
    },
  }
}

/**
 * Adds activeWithNotice()/designerWithNotice() to an orchestrator stub that only fakes active()/designer()
 * (the services resolve through the *WithNotice variants; the stubs never have a notice).
 */
export function withNotices<T extends object>(stub: T): T {
  const call = (name: string) => async (override?: unknown) => ({ adapter: await (stub as Record<string, ((value?: unknown) => unknown) | undefined>)[name]?.(override) })
  const own = stub as Record<string, unknown>
  return Object.assign(stub, { activeWithNotice: own.activeWithNotice ?? call('active'), designerWithNotice: own.designerWithNotice ?? call('designer') })
}
