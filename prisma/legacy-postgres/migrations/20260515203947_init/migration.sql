-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('created', 'analyzed', 'planned', 'running', 'completed', 'failed', 'needs_review');

-- CreateEnum
CREATE TYPE "SubtaskStatus" AS ENUM ('planned', 'running', 'completed', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "ModelClass" AS ENUM ('no_llm', 'local_llm', 'free_llm', 'cheap_api_llm', 'premium_llm');

-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('ollama', 'openai_compatible', 'gemini_cli', 'manual');

-- CreateEnum
CREATE TYPE "Complexity" AS ENUM ('trivial', 'small', 'medium', 'complex', 'critical');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('frontend', 'backend', 'database', 'fullstack', 'devops', 'test', 'refactor', 'documentation', 'unknown');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "ContextNeed" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "CostTier" AS ENUM ('free', 'low', 'medium', 'premium');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'simulated', 'completed', 'failed', 'blocked');

-- CreateEnum
CREATE TYPE "ValidationStatus" AS ENUM ('not_run', 'passed', 'failed', 'unavailable');

-- CreateEnum
CREATE TYPE "ReviewVerdict" AS ENUM ('approved', 'needs_changes', 'escalate', 'blocked');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoPath" TEXT NOT NULL,
    "defaultBranch" TEXT DEFAULT 'main',
    "techStack" JSONB NOT NULL DEFAULT '{}',
    "packageManager" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userPrompt" TEXT NOT NULL,
    "normalizedGoal" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'created',
    "complexity" "Complexity",
    "taskType" "TaskType",
    "riskLevel" "RiskLevel",
    "contextNeed" "ContextNeed",
    "securitySensitive" BOOLEAN NOT NULL DEFAULT false,
    "estimatedCostTier" "CostTier",
    "maxCostEuro" DECIMAL(10,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subtask" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" "SubtaskStatus" NOT NULL DEFAULT 'planned',
    "assignedAgentType" TEXT NOT NULL,
    "selectedModelClass" "ModelClass" NOT NULL,
    "allowedFiles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deniedFiles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expectedChange" TEXT NOT NULL,
    "validationCommands" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "budgetLimitEuro" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subtask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerType" "ProviderType" NOT NULL,
    "modelClass" "ModelClass" NOT NULL,
    "baseUrl" TEXT,
    "apiKeyEnvName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "supportsStreaming" BOOLEAN NOT NULL DEFAULT false,
    "supportsToolUse" BOOLEAN NOT NULL DEFAULT false,
    "supportsStructuredOutput" BOOLEAN NOT NULL DEFAULT false,
    "contextWindow" INTEGER,
    "costInputPerMillion" DECIMAL(12,6),
    "costOutputPerMillion" DECIMAL(12,6),
    "freeQuotaDaily" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "subtaskId" TEXT,
    "agentName" TEXT NOT NULL,
    "selectedModelClass" "ModelClass" NOT NULL,
    "providerId" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "promptSummary" TEXT NOT NULL,
    "inputTokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "outputTokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostEuro" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "actualCostEuro" DECIMAL(10,6),
    "diffSummary" TEXT,
    "validationStatus" "ValidationStatus" NOT NULL DEFAULT 'not_run',
    "score" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "verdict" "ReviewVerdict" NOT NULL,
    "score" INTEGER NOT NULL,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "requiresHumanApproval" BOOLEAN NOT NULL DEFAULT false,
    "recommendedAction" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContextSnapshot" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "relevantFiles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "creditBalance" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "appleOriginalTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT,
    "amount" DECIMAL(12,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "provider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_repoPath_idx" ON "Project"("repoPath");

-- CreateIndex
CREATE INDEX "Task_projectId_createdAt_idx" ON "Task"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Subtask_taskId_idx" ON "Subtask"("taskId");

-- CreateIndex
CREATE INDEX "ModelProvider_modelClass_enabled_idx" ON "ModelProvider"("modelClass", "enabled");

-- CreateIndex
CREATE INDEX "ContextSnapshot_projectId_createdAt_idx" ON "ContextSnapshot"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAccount_userId_key" ON "PaymentAccount"("userId");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_createdAt_idx" ON "CreditLedger"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subtask" ADD CONSTRAINT "Subtask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_subtaskId_fkey" FOREIGN KEY ("subtaskId") REFERENCES "Subtask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ModelProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextSnapshot" ADD CONSTRAINT "ContextSnapshot_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextSnapshot" ADD CONSTRAINT "ContextSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PaymentAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
