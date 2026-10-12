-- Sessions (persistent orchestrator conversations) and project-scoped settings.
-- Only ADD COLUMN / CREATE statements: rebuilding a table would run DROP TABLE, whose implicit
-- DELETE fires ON DELETE CASCADE on dependent tables while foreign keys are enabled.
-- DateTime values are stored as integer milliseconds (Prisma's SQLite format).

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "settings" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Neue Sitzung',
    "status" TEXT NOT NULL DEFAULT 'active',
    "provider" TEXT,
    "externalSessionId" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" DATETIME,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeTaskId" TEXT,
    "recovery" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ChatSession_projectId_lastActivityAt_idx" ON "ChatSession"("projectId", "lastActivityAt");

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "sessionId" TEXT REFERENCES "ChatSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN "sessionId" TEXT REFERENCES "ChatSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN "clientId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_clientId_key" ON "ChatMessage"("clientId");

-- CreateIndex
CREATE INDEX "ChatMessage_sessionId_createdAt_idx" ON "ChatMessage"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_sessionId_idx" ON "Task"("sessionId");

-- Backfill: every existing task becomes one session with its messages.
INSERT INTO "ChatSession" ("id", "projectId", "title", "status", "lastActivityAt", "activeTaskId", "recovery", "createdAt", "updatedAt")
SELECT 'ses_' || "id", "projectId", substr(replace(replace("userPrompt", char(13), ' '), char(10), ' '), 1, 80), 'idle', "updatedAt", "id", '{}', "createdAt", "updatedAt" FROM "Task";

-- Backfill
UPDATE "Task" SET "sessionId" = 'ses_' || "id" WHERE "sessionId" IS NULL;

-- Backfill
UPDATE "ChatMessage" SET "sessionId" = 'ses_' || "taskId" WHERE "taskId" IS NOT NULL AND "sessionId" IS NULL;

-- Backfill: questions asked without a task were stored but never shown again; they get a session per project.
INSERT INTO "ChatSession" ("id", "projectId", "title", "status", "lastActivityAt", "activeTaskId", "recovery", "createdAt", "updatedAt")
SELECT 'sesq_' || p."id", p."id", 'Fragen (übernommen)', 'idle',
  COALESCE((SELECT max(m."createdAt") FROM "ChatMessage" m WHERE m."projectId" = p."id" AND m."taskId" IS NULL), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  NULL, '{}', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM "Project" p WHERE EXISTS (SELECT 1 FROM "ChatMessage" m WHERE m."projectId" = p."id" AND m."taskId" IS NULL);

-- Backfill
UPDATE "ChatMessage" SET "sessionId" = 'sesq_' || "projectId" WHERE "taskId" IS NULL AND "sessionId" IS NULL;
