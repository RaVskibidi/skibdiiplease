-- CreateEnum
CREATE TYPE "QuarantineStatus" AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED');

-- AlterTable
ALTER TABLE "anti_raid_configs" ADD COLUMN     "accountAgeWeight" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN     "avatarWeight" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "quarantineEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "riskThreshold" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "similarAgeWeight" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "suspiciousNameWeight" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "velocityWeight" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "beast_mode_states" ADD COLUMN     "activatedBy" TEXT,
ADD COLUMN     "activationReason" TEXT,
ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "emergencyLockdown" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "quarantine_entries" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "incidentId" TEXT,
    "roleId" TEXT NOT NULL,
    "status" "QuarantineStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "requiresVerification" BOOLEAN NOT NULL DEFAULT true,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quarantine_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quarantine_entries_guildId_status_appliedAt_idx" ON "quarantine_entries"("guildId", "status", "appliedAt");

-- CreateIndex
CREATE INDEX "quarantine_entries_guildId_userId_status_idx" ON "quarantine_entries"("guildId", "userId", "status");

-- AddForeignKey
ALTER TABLE "quarantine_entries" ADD CONSTRAINT "quarantine_entries_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quarantine_entries" ADD CONSTRAINT "quarantine_entries_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "security_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
