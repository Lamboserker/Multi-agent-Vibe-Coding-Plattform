import { existsSync, mkdirSync, promises as fs, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, useTempDatabase } from '../test-db.js'

const db = useTempDatabase('mac-migrate-')
const { PrismaClient } = await import('@prisma/client')
const { applyMigrations } = await import('./migrator.js')
const prisma = new PrismaClient()

afterAll(async () => {
  await prisma.$disconnect()
  db.cleanup()
})

describe('migration 20261010090000_sessions_and_state on a database with existing data', () => {
  it('keeps every row and turns tasks and orphan questions into sessions', async () => {
    // 1. A database in the state of the previous release (only the initial migration applied).
    const initialOnly = path.join(db.dir, 'migrations-initial')
    mkdirSync(path.join(initialOnly, '20261009120000_desktop_sqlite_init'), { recursive: true })
    await fs.copyFile(path.join(MIGRATIONS_DIR, '20261009120000_desktop_sqlite_init', 'migration.sql'), path.join(initialOnly, '20261009120000_desktop_sqlite_init', 'migration.sql'))
    expect(await applyMigrations(prisma, initialOnly)).toEqual(['20261009120000_desktop_sqlite_init'])

    const now = Date.now()
    await prisma.$executeRawUnsafe(`INSERT INTO "Project" ("id","name","repoPath","updatedAt") VALUES ('p1','demo','C:/demo',${now})`)
    await prisma.$executeRawUnsafe(`INSERT INTO "Task" ("id","projectId","userPrompt","status","currentStep","createdAt","updatedAt") VALUES ('t1','p1','Add a greeting component\nwith tests','planned','awaiting_plan_approval',${now},${now})`)
    await prisma.$executeRawUnsafe(`INSERT INTO "Subtask" ("id","taskId","title","goal","assignedAgentType","selectedModelClass","expectedChange","updatedAt") VALUES ('s1','t1','x','y','LocalCoderAgent','local_llm','z',${now})`)
    await prisma.$executeRawUnsafe(`INSERT INTO "ChatMessage" ("id","taskId","projectId","role","content","createdAt") VALUES ('m1','t1','p1','user','task message',${now})`)
    await prisma.$executeRawUnsafe(`INSERT INTO "ChatMessage" ("id","taskId","projectId","role","content","createdAt") VALUES ('m2',NULL,'p1','user','question without task',${now})`)
    await prisma.$executeRawUnsafe(`INSERT INTO "ChatMessage" ("id","taskId","projectId","role","content","createdAt") VALUES ('m3',NULL,'p1','assistant','answer without task',${now + 1})`)

    // 2. Upgrade with backup.
    const applied = await applyMigrations(prisma, MIGRATIONS_DIR, () => undefined, { databaseFile: db.file, backupDir: path.join(db.dir, 'backups') })
    expect(applied).toContain('20261010090000_sessions_and_state')
    expect(readdirSync(path.join(db.dir, 'backups')).some((name) => name.includes('before-20261010090000'))).toBe(true)

    // 3. Nothing was lost (a table rebuild would have cascade-deleted subtasks and messages).
    expect(await prisma.task.count()).toBe(1)
    expect(await prisma.subtask.count()).toBe(1)
    expect(await prisma.chatMessage.count()).toBe(3)

    const sessions = await prisma.chatSession.findMany({ orderBy: { id: 'asc' } })
    expect(sessions.map((session) => session.id)).toEqual(['ses_t1', 'sesq_p1'])
    expect(sessions[0]!.title).toBe('Add a greeting component with tests')
    expect(sessions[0]!.activeTaskId).toBe('t1')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: 't1' } })).sessionId).toBe('ses_t1')
    expect((await prisma.chatMessage.findUniqueOrThrow({ where: { id: 'm1' } })).sessionId).toBe('ses_t1')
    expect((await prisma.chatMessage.findMany({ where: { sessionId: 'sesq_p1' } })).map((message) => message.id).sort()).toEqual(['m2', 'm3'])
    // Prisma can read the backfilled timestamps (integer milliseconds).
    expect(sessions[1]!.createdAt).toBeInstanceOf(Date)
    expect(Number.isNaN(sessions[1]!.lastActivityAt.getTime())).toBe(false)

    // 4. Idempotent: a second start applies nothing.
    expect(await applyMigrations(prisma, MIGRATIONS_DIR)).toEqual([])
    expect(existsSync(db.file)).toBe(true)
  })
})
