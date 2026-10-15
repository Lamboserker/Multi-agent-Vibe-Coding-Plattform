-- Fast path: deterministic tool of a subtask (see packages/engine/src/fastpath). ADD COLUMN only.

-- AlterTable
ALTER TABLE "Subtask" ADD COLUMN "fastPath" JSONB;
