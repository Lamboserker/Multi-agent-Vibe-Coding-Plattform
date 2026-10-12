-- Add workspace flow fields to Task
ALTER TABLE "Task"
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'balanced',
  ADD COLUMN "premiumAllowed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "currentStep" TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN "lastRunId" TEXT;

-- Persist model assignment rationale on subtasks
ALTER TABLE "Subtask"
  ADD COLUMN "selectedProviderId" TEXT,
  ADD COLUMN "selectedModelName" TEXT,
  ADD COLUMN "modelReason" TEXT,
  ADD COLUMN "skippedModels" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "estimatedCostEuro" DECIMAL(10,6) NOT NULL DEFAULT 0;

-- Persist dry-run execution artifacts on agent runs
ALTER TABLE "AgentRun"
  ADD COLUMN "selectedModelName" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "finishedAt" TIMESTAMP(3),
  ADD COLUMN "logs" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "currentStep" TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN "validationResults" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "patchText" TEXT,
  ADD COLUMN "patchStatus" TEXT NOT NULL DEFAULT 'no_patch_artifact';

-- Store user feedback for follow-up runs
CREATE TABLE "RunFeedback" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "runId" TEXT,
    "userFeedback" TEXT NOT NULL,
    "requestedAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunFeedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RunFeedback_taskId_createdAt_idx" ON "RunFeedback"("taskId", "createdAt");
CREATE INDEX "RunFeedback_runId_idx" ON "RunFeedback"("runId");

ALTER TABLE "RunFeedback" ADD CONSTRAINT "RunFeedback_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
