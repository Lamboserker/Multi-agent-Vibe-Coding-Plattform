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
