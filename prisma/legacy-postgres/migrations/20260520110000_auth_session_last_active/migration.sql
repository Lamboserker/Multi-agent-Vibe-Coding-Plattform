ALTER TABLE "AuthSession" ADD COLUMN "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "AuthSession_lastActiveAt_idx" ON "AuthSession"("lastActiveAt");
