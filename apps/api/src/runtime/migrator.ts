import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { PrismaClient } from '@prisma/client'

/** Splits a Prisma-generated SQLite migration into single statements. */
export function splitSqlStatements(sql: string): string[] {
  const withoutComments = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
  return withoutComments
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
}

/**
 * Applies pending migrations from prisma/migrations at startup. The installed desktop app ships
 * no Prisma CLI, so migrations are applied here (in order, each in a transaction) and tracked in
 * `_mac_migrations`. Migrations already applied by `prisma migrate deploy` (dev) are recognised.
 */
export async function applyMigrations(
  prisma: PrismaClient,
  migrationsDir: string,
  log: (message: string) => void = () => undefined,
  options: { databaseFile?: string; backupDir?: string } = {},
): Promise<string[]> {
  await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;')
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000;')
  await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "_mac_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "applied_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)')

  const applied = new Set((await prisma.$queryRawUnsafe<Array<{ name: string }>>('SELECT name FROM "_mac_migrations"')).map((row) => row.name))
  const prismaTable = await prisma.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'")
  if (prismaTable.length) {
    const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
    for (const row of rows) applied.add(row.migration_name)
  }

  if (!existsSync(migrationsDir)) throw new Error(`Migrations directory not found: ${migrationsDir}`)
  const entries = (await fs.readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const pending = entries.filter((name) => !applied.has(name) && existsSync(path.join(migrationsDir, name, 'migration.sql')))
  // Existing data is backed up before the first pending migration touches it (fresh databases are skipped).
  if (pending.length && applied.size && options.databaseFile && options.backupDir && existsSync(options.databaseFile)) {
    await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);')
    await fs.mkdir(options.backupDir, { recursive: true })
    const target = path.join(options.backupDir, `${path.basename(options.databaseFile)}.before-${pending[0]}.bak`)
    if (!existsSync(target)) await fs.copyFile(options.databaseFile, target)
    log(`Backed up the database to ${target}.`)
  }

  const newlyApplied: string[] = []
  for (const name of entries) {
    if (applied.has(name)) continue
    const file = path.join(migrationsDir, name, 'migration.sql')
    if (!existsSync(file)) continue
    const statements = splitSqlStatements(await fs.readFile(file, 'utf8'))
    await prisma.$transaction(async (tx) => {
      for (const statement of statements) await tx.$executeRawUnsafe(statement)
      await tx.$executeRawUnsafe('INSERT INTO "_mac_migrations" ("name") VALUES (?)', name)
    })
    newlyApplied.push(name)
    log(`Applied migration ${name} (${statements.length} statements).`)
  }
  return newlyApplied
}
