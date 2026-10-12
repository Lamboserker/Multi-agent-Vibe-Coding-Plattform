-- NOTE: Json defaults were quoted manually; prisma migrate diff emits unquoted {} / [] for SQLite.
-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "repoPath" TEXT NOT NULL,
    "defaultBranch" TEXT DEFAULT 'main',
    "techStack" JSONB NOT NULL DEFAULT '{}',
    "packageManager" TEXT,
    "lastOpenedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuthUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "lastActiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "userPrompt" TEXT NOT NULL,
    "normalizedGoal" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "complexity" TEXT,
    "taskType" TEXT,
    "riskLevel" TEXT,
    "contextNeed" TEXT,
    "securitySensitive" BOOLEAN NOT NULL DEFAULT false,
    "estimatedCostTier" TEXT,
    "maxCostEuro" DECIMAL,
    "mode" TEXT NOT NULL DEFAULT 'balanced',
    "premiumAllowed" BOOLEAN NOT NULL DEFAULT false,
    "currentStep" TEXT NOT NULL DEFAULT 'draft',
    "lastRunId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Subtask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "assignedAgentType" TEXT NOT NULL,
    "selectedModelClass" TEXT NOT NULL,
    "selectedProviderId" TEXT,
    "selectedModelName" TEXT,
    "modelReason" TEXT,
    "skippedModels" JSONB NOT NULL DEFAULT '[]',
    "estimatedCostEuro" DECIMAL NOT NULL DEFAULT 0,
    "allowedFiles" JSONB NOT NULL DEFAULT '[]',
    "newFiles" JSONB NOT NULL DEFAULT '[]',
    "suggestedExecutor" TEXT NOT NULL DEFAULT 'local',
    "deniedFiles" JSONB NOT NULL DEFAULT '[]',
    "expectedChange" TEXT NOT NULL,
    "validationCommands" JSONB NOT NULL DEFAULT '[]',
    "budgetLimitEuro" DECIMAL NOT NULL DEFAULT 0,
    "dependsOn" JSONB NOT NULL DEFAULT '[]',
    "category" TEXT NOT NULL DEFAULT 'general',
    "complexityScore" INTEGER NOT NULL DEFAULT 2,
    "riskScore" INTEGER NOT NULL DEFAULT 1,
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "acceptanceCriteria" JSONB NOT NULL DEFAULT '[]',
    "testStrategy" TEXT,
    "expectedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "manualModel" TEXT,
    "worktreePath" TEXT,
    "branchName" TEXT,
    "commitSha" TEXT,
    "patchText" TEXT,
    "patchStats" JSONB NOT NULL DEFAULT '{}',
    "validation" JSONB NOT NULL DEFAULT '{}',
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Subtask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "modelClass" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKeyEnvName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "supportsStreaming" BOOLEAN NOT NULL DEFAULT false,
    "supportsToolUse" BOOLEAN NOT NULL DEFAULT false,
    "supportsStructuredOutput" BOOLEAN NOT NULL DEFAULT false,
    "contextWindow" INTEGER,
    "costInputPerMillion" DECIMAL,
    "costOutputPerMillion" DECIMAL,
    "freeQuotaDaily" INTEGER,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "subtaskId" TEXT,
    "executionId" TEXT,
    "agentName" TEXT NOT NULL,
    "selectedModelClass" TEXT NOT NULL,
    "providerId" TEXT,
    "selectedModelName" TEXT,
    "runtime" TEXT,
    "category" TEXT,
    "repairRound" INTEGER NOT NULL DEFAULT 0,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "durationMs" INTEGER,
    "logs" JSONB NOT NULL DEFAULT '[]',
    "currentStep" TEXT NOT NULL DEFAULT 'queued',
    "promptSummary" TEXT NOT NULL,
    "inputTokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "outputTokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "tokensMeasured" BOOLEAN NOT NULL DEFAULT false,
    "estimatedCostEuro" DECIMAL NOT NULL DEFAULT 0,
    "actualCostEuro" DECIMAL,
    "diffSummary" TEXT,
    "validationStatus" TEXT NOT NULL DEFAULT 'not_run',
    "validationResults" JSONB NOT NULL DEFAULT '[]',
    "patchText" TEXT,
    "patchStatus" TEXT NOT NULL DEFAULT 'no_patch_artifact',
    "score" INTEGER,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_subtaskId_fkey" FOREIGN KEY ("subtaskId") REFERENCES "Subtask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ExecutionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ModelProvider" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentRunId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "requiresHumanApproval" BOOLEAN NOT NULL DEFAULT false,
    "recommendedAction" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL DEFAULT 'deterministic',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Review_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "projectId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "classification" JSONB NOT NULL DEFAULT '{}',
    "modelAssignments" JSONB NOT NULL DEFAULT '[]',
    "estimatedCostEuro" DECIMAL NOT NULL DEFAULT 0,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "nextAction" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'deterministic',
    "dag" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TaskPlan_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContextSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "relevantFiles" JSONB NOT NULL DEFAULT '[]',
    "tokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContextSnapshot_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContextSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunFeedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "runId" TEXT,
    "userFeedback" TEXT NOT NULL,
    "requestedAction" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunFeedback_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "creditBalance" DECIMAL NOT NULL DEFAULT 0,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "appleOriginalTransactionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "taskId" TEXT,
    "amount" DECIMAL NOT NULL,
    "reason" TEXT NOT NULL,
    "provider" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PaymentAccount" ("userId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CreditLedger_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExecutionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "orchestrator" TEXT,
    "costMode" TEXT NOT NULL DEFAULT 'balanced',
    "approvalMode" TEXT NOT NULL DEFAULT 'manual',
    "premiumAllowed" BOOLEAN NOT NULL DEFAULT true,
    "baseCommit" TEXT,
    "baseBranch" TEXT,
    "integrationBranch" TEXT,
    "integrationWorktree" TEXT,
    "integrationCommit" TEXT,
    "finalDiff" TEXT,
    "finalValidation" JSONB NOT NULL DEFAULT '{}',
    "review" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExecutionRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExecutionRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL,
    "subtaskId" TEXT,
    "level" TEXT NOT NULL DEFAULT 'info',
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunEvent_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ExecutionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT,
    "subtaskId" TEXT,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "errorClass" TEXT,
    "sessionId" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "tokensMeasured" BOOLEAN NOT NULL DEFAULT false,
    "actualApiCostUsd" DECIMAL,
    "apiEquivalentUsd" DECIMAL,
    "billing" TEXT NOT NULL DEFAULT 'subscription',
    "peakMemoryMb" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelCall_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ExecutionRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApplyRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "patch" TEXT NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "targetBranch" TEXT,
    "beforeHead" TEXT,
    "afterHead" TEXT,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revertedAt" DATETIME,
    CONSTRAINT "ApplyRecord_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ExecutionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAfter" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Project_repoPath_idx" ON "Project"("repoPath");

-- CreateIndex
CREATE UNIQUE INDEX "AuthUser_email_key" ON "AuthUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_expiresAt_idx" ON "AuthSession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthSession_lastActiveAt_idx" ON "AuthSession"("lastActiveAt");

-- CreateIndex
CREATE INDEX "Task_projectId_createdAt_idx" ON "Task"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Subtask_taskId_idx" ON "Subtask"("taskId");

-- CreateIndex
CREATE INDEX "ModelProvider_modelClass_enabled_idx" ON "ModelProvider"("modelClass", "enabled");

-- CreateIndex
CREATE INDEX "AgentRun_executionId_idx" ON "AgentRun"("executionId");

-- CreateIndex
CREATE INDEX "AgentRun_selectedModelName_category_idx" ON "AgentRun"("selectedModelName", "category");

-- CreateIndex
CREATE INDEX "ChatMessage_taskId_createdAt_idx" ON "ChatMessage"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_projectId_createdAt_idx" ON "ChatMessage"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskPlan_taskId_createdAt_idx" ON "TaskPlan"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "ContextSnapshot_projectId_createdAt_idx" ON "ContextSnapshot"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "RunFeedback_taskId_createdAt_idx" ON "RunFeedback"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "RunFeedback_runId_idx" ON "RunFeedback"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAccount_userId_key" ON "PaymentAccount"("userId");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_createdAt_idx" ON "CreditLedger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionRun_taskId_createdAt_idx" ON "ExecutionRun"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionRun_status_idx" ON "ExecutionRun"("status");

-- CreateIndex
CREATE INDEX "RunEvent_executionId_createdAt_idx" ON "RunEvent"("executionId", "createdAt");

-- CreateIndex
CREATE INDEX "ModelCall_executionId_idx" ON "ModelCall"("executionId");

-- CreateIndex
CREATE INDEX "ModelCall_kind_createdAt_idx" ON "ModelCall"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_runAfter_idx" ON "Job"("status", "runAfter");

