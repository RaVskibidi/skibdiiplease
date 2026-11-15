-- Phase 9: dashboard-triggered Discord action queue.

CREATE TYPE "DashboardActionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

CREATE TABLE "dashboard_actions" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB,
  "result" JSONB,
  "error" TEXT,
  "status" "DashboardActionStatus" NOT NULL DEFAULT 'PENDING',
  "confirmationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "dashboard_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dashboard_actions_guildId_status_createdAt_idx" ON "dashboard_actions"("guildId", "status", "createdAt");
CREATE INDEX "dashboard_actions_status_createdAt_idx" ON "dashboard_actions"("status", "createdAt");

ALTER TABLE "dashboard_actions"
  ADD CONSTRAINT "dashboard_actions_guildId_fkey"
  FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
