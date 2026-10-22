CREATE TABLE "IntegrationInstallation" (
  "presetId" TEXT NOT NULL PRIMARY KEY,
  "catalogVersion" TEXT NOT NULL,
  "packageVersion" TEXT,
  "serverId" TEXT NOT NULL,
  "owned" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "IntegrationInstallation_serverId_key" ON "IntegrationInstallation"("serverId");

CREATE TABLE "IntegrationSetupJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "presetId" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "serverId" TEXT,
  "message" TEXT NOT NULL DEFAULT '',
  "error" TEXT,
  "config" JSONB NOT NULL DEFAULT '{}',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "IntegrationSetupJob_presetId_createdAt_idx" ON "IntegrationSetupJob"("presetId", "createdAt");

CREATE TABLE "IntegrationBundle" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "version" TEXT NOT NULL,
  "optional" JSONB NOT NULL DEFAULT '[]',
  "members" JSONB NOT NULL DEFAULT '[]',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
