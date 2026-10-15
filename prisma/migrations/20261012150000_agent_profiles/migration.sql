-- Agent manager (Phase 0.3, F). ADD COLUMN / CREATE only.

-- AlterTable
ALTER TABLE "Subtask" ADD COLUMN "agentId" TEXT;

-- CreateTable
CREATE TABLE "AgentProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT 'coder',
    "projectId" TEXT,
    "model" TEXT,
    "categories" JSONB NOT NULL DEFAULT '[]',
    "skills" JSONB NOT NULL DEFAULT '[]',
    "mcpServers" JSONB NOT NULL DEFAULT '["*"]',
    "pluginTools" BOOLEAN NOT NULL DEFAULT true,
    "escalation" TEXT NOT NULL DEFAULT 'premium',
    "maxSteps" INTEGER,
    "maxRepairs" INTEGER,
    "instructions" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "template" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
