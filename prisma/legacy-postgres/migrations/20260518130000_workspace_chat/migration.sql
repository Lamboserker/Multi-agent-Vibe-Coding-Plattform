-- Persist chat-first workspace messages and generated plans.
CREATE TYPE "ChatMessageRole" AS ENUM ('user', 'assistant', 'agent', 'system');

CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "taskId" TEXT,
    "projectId" TEXT NOT NULL,
    "role" "ChatMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskPlan" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "classification" JSONB NOT NULL DEFAULT '{}',
    "modelAssignments" JSONB NOT NULL DEFAULT '[]',
    "estimatedCostEuro" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "nextAction" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatMessage_taskId_createdAt_idx" ON "ChatMessage"("taskId", "createdAt");
CREATE INDEX "ChatMessage_projectId_createdAt_idx" ON "ChatMessage"("projectId", "createdAt");
CREATE INDEX "TaskPlan_taskId_createdAt_idx" ON "TaskPlan"("taskId", "createdAt");

ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskPlan" ADD CONSTRAINT "TaskPlan_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
