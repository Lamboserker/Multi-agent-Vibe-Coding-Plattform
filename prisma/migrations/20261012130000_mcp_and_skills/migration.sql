-- MCP servers and skill state (Phase 0.3, E). CREATE only.

-- CreateTable
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "command" TEXT,
    "args" JSONB NOT NULL DEFAULT '[]',
    "env" JSONB NOT NULL DEFAULT '{}',
    "secretEnv" JSONB NOT NULL DEFAULT '[]',
    "cwd" TEXT,
    "url" TEXT,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "secretHeaders" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "timeoutMs" INTEGER NOT NULL DEFAULT 60000,
    "toolPolicies" JSONB NOT NULL DEFAULT '{}',
    "defaultPolicy" TEXT NOT NULL DEFAULT 'confirm',
    "agents" JSONB NOT NULL DEFAULT '["*"]',
    "tools" JSONB,
    "toolsAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "McpServer_name_key" ON "McpServer"("name");

-- CreateTable
CREATE TABLE "SkillState" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scriptsApprovedHash" TEXT,
    "agents" JSONB NOT NULL DEFAULT '["*"]',
    "updatedAt" DATETIME NOT NULL
);
