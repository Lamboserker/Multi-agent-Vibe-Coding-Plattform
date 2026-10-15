-- Plugin system (Phase 0.3, D). CREATE only.

-- CreateTable
CREATE TABLE "Plugin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "trust" TEXT NOT NULL DEFAULT 'untrusted',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "granted" JSONB NOT NULL DEFAULT '{}',
    "integrity" JSONB NOT NULL DEFAULT '{}',
    "manifest" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "storage" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'installed',
    "lastError" TEXT,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
