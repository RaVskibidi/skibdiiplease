-- Phase 8: backup scheduling and retention settings on guild configuration.

ALTER TABLE "guild_configs"
  ADD COLUMN "backupIntervalHours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN "backupRetentionDays" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "lastScheduledBackupAt" TIMESTAMP(3);
