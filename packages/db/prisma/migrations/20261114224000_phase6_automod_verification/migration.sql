-- Phase 6: advanced AutoMod rules and verification challenge lifecycle.

-- AlterTable
ALTER TABLE "automod_configs" ADD COLUMN     "deleteOffendingMessage" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "duplicateThreshold" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "exemptUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "highConfidenceRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "ignoreStaff" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "linkFilterEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "timeoutAfterWarnings" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "timeoutEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "warnEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "verification_challenges" ADD COLUMN     "channelId" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "messageId" TEXT;

-- AlterTable
ALTER TABLE "verification_configs" ADD COLUMN     "buttonFallbackEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "captchaNoise" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "releaseQuarantineOnPass" BOOLEAN NOT NULL DEFAULT true;
