-- Design phase: per-task design mode and design drafts (see docs/ai/plans/2026-10-21-design-phase.md). Additive only.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "designMode" TEXT NOT NULL DEFAULT 'auto';

-- CreateTable
CREATE TABLE "DesignDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'generating',
    "provider" TEXT,
    "designType" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "spec" JSONB NOT NULL DEFAULT '{}',
    "mockupHtml" TEXT NOT NULL DEFAULT '',
    "feedback" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DesignDraft_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DesignDraft_taskId_createdAt_idx" ON "DesignDraft"("taskId", "createdAt");
