ALTER TABLE "AgentProfile" ADD COLUMN "maxContextTokens" INTEGER;
ALTER TABLE "AgentProfile" ADD COLUMN "permissions" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "AgentProfile" ADD COLUMN "resources" JSONB NOT NULL DEFAULT '{}';
