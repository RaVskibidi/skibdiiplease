-- CreateEnum
CREATE TYPE "AutomationMode" AS ENUM ('OBSERVE', 'ENFORCE_REVERSIBLE', 'ENFORCE_DESTRUCTIVE');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('CHANNEL', 'CATEGORY', 'ROLE', 'EMOJI', 'STICKER');

-- CreateEnum
CREATE TYPE "AntiNukeAction" AS ENUM ('MEMBER_BAN', 'MEMBER_KICK', 'MEMBER_PRUNE', 'MEMBER_ROLE_UPDATE', 'CHANNEL_CREATE', 'CHANNEL_DELETE', 'CHANNEL_UPDATE', 'CHANNEL_PERMISSION_UPDATE', 'ROLE_CREATE', 'ROLE_DELETE', 'ROLE_UPDATE', 'ROLE_PERMISSION_UPDATE', 'ADMINISTRATOR_GRANT', 'DANGEROUS_ROLE_ASSIGN', 'MASS_ROLE_ASSIGN', 'BOT_ADD', 'WEBHOOK_CREATE', 'WEBHOOK_UPDATE', 'GUILD_UPDATE', 'VANITY_URL_UPDATE', 'INVITE_DELETE', 'EMOJI_UPDATE', 'STICKER_UPDATE', 'INTEGRATION_CREATE', 'INTEGRATION_UPDATE', 'INTEGRATION_DELETE');

-- CreateEnum
CREATE TYPE "PunishmentType" AS ENUM ('ALERT', 'QUARANTINE', 'ROLE_REMOVAL', 'TIMEOUT', 'KICK', 'BAN');

-- CreateEnum
CREATE TYPE "PunishmentStatus" AS ENUM ('PROPOSED', 'SKIPPED', 'APPLIED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "WhitelistTargetType" AS ENUM ('USER', 'ROLE', 'CHANNEL');

-- CreateEnum
CREATE TYPE "WhitelistScope" AS ENUM ('GLOBAL', 'ACTION');

-- CreateEnum
CREATE TYPE "GrantSubjectType" AS ENUM ('USER', 'ROLE');

-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('NUKING', 'MASS_JOIN', 'RAID', 'BEAST_MODE', 'SPAM', 'AUTOMOD', 'VERIFICATION_ABUSE', 'SUSPICIOUS_BOT', 'DANGEROUS_PERMISSION', 'MANUAL');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'MONITORING', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "SecurityEventSource" AS ENUM ('AUDIT_LOG', 'GATEWAY', 'MESSAGE', 'COMMAND', 'DASHBOARD', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ModerationCaseType" AS ENUM ('BAN', 'KICK', 'TIMEOUT', 'UNTIMEOUT', 'WARN', 'UNWARN', 'UNBAN', 'PURGE', 'LOCK', 'UNLOCK', 'SLOWMODE', 'SOFTBAN');

-- CreateEnum
CREATE TYPE "ModerationCaseStatus" AS ENUM ('OPEN', 'CLOSED', 'REVERSED');

-- CreateEnum
CREATE TYPE "VerificationMode" AS ENUM ('BUTTON', 'CAPTCHA');

-- CreateEnum
CREATE TYPE "VerificationChallengeStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'EXPIRED', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "LogCategory" AS ENUM ('SECURITY', 'ANTI_NUKE', 'ANTI_RAID', 'MODERATION', 'MEMBER', 'ROLE', 'CHANNEL', 'VERIFICATION', 'BOT', 'BACKUP');

-- CreateEnum
CREATE TYPE "BackupType" AS ENUM ('MANUAL', 'SCHEDULED', 'PRE_RESTORE');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('PENDING', 'CAPTURING', 'READY', 'FAILED', 'DELETED');

-- CreateEnum
CREATE TYPE "RestoreStatus" AS ENUM ('PENDING', 'PREVIEWED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'BOT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "CriticalApprovalStatus" AS ENUM ('PENDING', 'CONSUMED', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "guilds" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "iconUrl" TEXT,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "caseSequence" INTEGER NOT NULL DEFAULT 0,
    "botJoinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "botLeftAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guilds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guild_configs" (
    "guildId" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "automationMode" "AutomationMode" NOT NULL DEFAULT 'OBSERVE',
    "enforcementApprovedAt" TIMESTAMP(3),
    "enforcementApprovedBy" TEXT,
    "enforcementPolicyVersion" TEXT,
    "antiNukeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "antiRaidEnabled" BOOLEAN NOT NULL DEFAULT true,
    "beastModeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "automodEnabled" BOOLEAN NOT NULL DEFAULT false,
    "verificationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "botProtectionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "loggingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "backupsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_configs_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "guild_resources" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "type" "ResourceType" NOT NULL,
    "discordId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "parentId" TEXT,
    "metadata" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guild_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anti_nuke_rules" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "action" "AntiNukeAction" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "threshold" INTEGER NOT NULL DEFAULT 5,
    "windowSeconds" INTEGER NOT NULL DEFAULT 600,
    "containment" "PunishmentType" NOT NULL DEFAULT 'ALERT',
    "requiresDestructiveApproval" BOOLEAN NOT NULL DEFAULT true,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 300,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anti_nuke_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anti_raid_configs" (
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "joinWindowSeconds" INTEGER NOT NULL DEFAULT 60,
    "aggregateThreshold" INTEGER NOT NULL DEFAULT 10,
    "minimumSignals" INTEGER NOT NULL DEFAULT 2,
    "minimumAccountAgeDays" INTEGER NOT NULL DEFAULT 7,
    "quarantineRoleId" TEXT,
    "lockdownEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoBanEnabled" BOOLEAN NOT NULL DEFAULT false,
    "verificationRequired" BOOLEAN NOT NULL DEFAULT true,
    "bypassBadges" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anti_raid_configs_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "beast_mode_states" (
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "score" INTEGER NOT NULL DEFAULT 0,
    "threshold" INTEGER NOT NULL DEFAULT 100,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "incidentId" TEXT,
    "overrideBy" TEXT,
    "overrideReason" TEXT,
    "overriddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "beast_mode_states_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "automod_configs" (
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "floodMessages" INTEGER NOT NULL DEFAULT 8,
    "floodWindowSeconds" INTEGER NOT NULL DEFAULT 10,
    "duplicateWindowSeconds" INTEGER NOT NULL DEFAULT 60,
    "mentionLimit" INTEGER NOT NULL DEFAULT 6,
    "capsPercentage" INTEGER NOT NULL DEFAULT 70,
    "capsMinimumLength" INTEGER NOT NULL DEFAULT 20,
    "inviteLinksBlocked" BOOLEAN NOT NULL DEFAULT true,
    "bannedWords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blockedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exemptChannelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exemptRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 600,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automod_configs_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "verification_configs" (
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" "VerificationMode" NOT NULL DEFAULT 'BUTTON',
    "unverifiedRoleId" TEXT,
    "verifiedRoleId" TEXT,
    "channelId" TEXT,
    "challengeLength" INTEGER NOT NULL DEFAULT 6,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 300,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_configs_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "log_channels" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "category" "LogCategory" NOT NULL,
    "channelId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "log_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whitelist_entries" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "targetType" "WhitelistTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "scope" "WhitelistScope" NOT NULL DEFAULT 'GLOBAL',
    "action" "AntiNukeAction",
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whitelist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_grants" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "subjectType" "GrantSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "permissionKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grantedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_approvals" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_incidents" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "type" "IncidentType" NOT NULL,
    "severity" "IncidentSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "score" INTEGER NOT NULL DEFAULT 0,
    "actorId" TEXT,
    "actorSummary" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "overrideBy" TEXT,
    "overrideReason" TEXT,
    "metadata" JSONB,

    CONSTRAINT "security_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "source" "SecurityEventSource" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "targetId" TEXT,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "incidentId" TEXT,
    "payload" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "punishments" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "incidentId" TEXT,
    "caseId" TEXT,
    "actorId" TEXT NOT NULL,
    "type" "PunishmentType" NOT NULL,
    "status" "PunishmentStatus" NOT NULL DEFAULT 'PROPOSED',
    "idempotencyKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "failedReason" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "punishments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_cases" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "type" "ModerationCaseType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "durationSeconds" INTEGER,
    "status" "ModerationCaseStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'discord',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "moderation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warnings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "caseId" TEXT,
    "targetId" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_entries" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "diff" JSONB,
    "requestId" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "confirmationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "critical_approvals" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "status" "CriticalApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedBy" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "critical_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_challenges" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "VerificationMode" NOT NULL,
    "answerHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "status" "VerificationChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "verification_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backups" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "type" "BackupType" NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'PENDING',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "checksum" TEXT,
    "objectKey" TEXT,
    "sizeBytes" BIGINT,
    "createdBy" TEXT NOT NULL,
    "retentionUntil" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restore_jobs" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "backupId" TEXT NOT NULL,
    "status" "RestoreStatus" NOT NULL DEFAULT 'PENDING',
    "selection" JSONB,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "confirmationId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restore_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_identities" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "globalName" TEXT,
    "avatarHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_credentials" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "accessTokenCiphertext" TEXT NOT NULL,
    "refreshTokenCiphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_sessions" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "csrfHash" TEXT NOT NULL,
    "guildIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "dashboard_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guilds_botLeftAt_idx" ON "guilds"("botLeftAt");

-- CreateIndex
CREATE INDEX "guild_resources_guildId_type_position_idx" ON "guild_resources"("guildId", "type", "position");

-- CreateIndex
CREATE UNIQUE INDEX "guild_resources_guildId_type_discordId_key" ON "guild_resources"("guildId", "type", "discordId");

-- CreateIndex
CREATE INDEX "anti_nuke_rules_guildId_enabled_idx" ON "anti_nuke_rules"("guildId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "anti_nuke_rules_guildId_action_key" ON "anti_nuke_rules"("guildId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "log_channels_guildId_category_key" ON "log_channels"("guildId", "category");

-- CreateIndex
CREATE INDEX "whitelist_entries_guildId_targetType_targetId_idx" ON "whitelist_entries"("guildId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "whitelist_entries_guildId_scope_action_idx" ON "whitelist_entries"("guildId", "scope", "action");

-- CreateIndex
CREATE INDEX "whitelist_entries_guildId_expiresAt_idx" ON "whitelist_entries"("guildId", "expiresAt");

-- CreateIndex
CREATE INDEX "access_grants_guildId_revokedAt_idx" ON "access_grants"("guildId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "access_grants_guildId_subjectType_subjectId_key" ON "access_grants"("guildId", "subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "bot_approvals_guildId_botId_key" ON "bot_approvals"("guildId", "botId");

-- CreateIndex
CREATE INDEX "security_incidents_guildId_status_openedAt_idx" ON "security_incidents"("guildId", "status", "openedAt");

-- CreateIndex
CREATE INDEX "security_incidents_guildId_type_openedAt_idx" ON "security_incidents"("guildId", "type", "openedAt");

-- CreateIndex
CREATE INDEX "security_events_guildId_occurredAt_idx" ON "security_events"("guildId", "occurredAt");

-- CreateIndex
CREATE INDEX "security_events_guildId_actorId_occurredAt_idx" ON "security_events"("guildId", "actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "security_events_guildId_incidentId_idx" ON "security_events"("guildId", "incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "security_events_guildId_source_externalEventId_key" ON "security_events"("guildId", "source", "externalEventId");

-- CreateIndex
CREATE INDEX "punishments_guildId_status_createdAt_idx" ON "punishments"("guildId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "punishments_guildId_incidentId_idx" ON "punishments"("guildId", "incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "punishments_guildId_idempotencyKey_key" ON "punishments"("guildId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "moderation_cases_guildId_targetId_createdAt_idx" ON "moderation_cases"("guildId", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "moderation_cases_guildId_moderatorId_createdAt_idx" ON "moderation_cases"("guildId", "moderatorId", "createdAt");

-- CreateIndex
CREATE INDEX "moderation_cases_guildId_status_idx" ON "moderation_cases"("guildId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "moderation_cases_guildId_number_key" ON "moderation_cases"("guildId", "number");

-- CreateIndex
CREATE INDEX "warnings_guildId_targetId_active_idx" ON "warnings"("guildId", "targetId", "active");

-- CreateIndex
CREATE INDEX "warnings_guildId_createdAt_idx" ON "warnings"("guildId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_entries_guildId_createdAt_idx" ON "audit_entries"("guildId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_entries_guildId_action_createdAt_idx" ON "audit_entries"("guildId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_entries_guildId_actorId_createdAt_idx" ON "audit_entries"("guildId", "actorId", "createdAt");

-- CreateIndex
CREATE INDEX "critical_approvals_guildId_status_expiresAt_idx" ON "critical_approvals"("guildId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "critical_approvals_guildId_action_idx" ON "critical_approvals"("guildId", "action");

-- CreateIndex
CREATE INDEX "verification_challenges_guildId_userId_status_idx" ON "verification_challenges"("guildId", "userId", "status");

-- CreateIndex
CREATE INDEX "verification_challenges_guildId_expiresAt_status_idx" ON "verification_challenges"("guildId", "expiresAt", "status");

-- CreateIndex
CREATE INDEX "backups_guildId_createdAt_idx" ON "backups"("guildId", "createdAt");

-- CreateIndex
CREATE INDEX "backups_guildId_status_idx" ON "backups"("guildId", "status");

-- CreateIndex
CREATE INDEX "restore_jobs_guildId_createdAt_idx" ON "restore_jobs"("guildId", "createdAt");

-- CreateIndex
CREATE INDEX "restore_jobs_guildId_status_idx" ON "restore_jobs"("guildId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_identities_discordUserId_key" ON "oauth_identities"("discordUserId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_credentials_identityId_key" ON "oauth_credentials"("identityId");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_sessions_sessionHash_key" ON "dashboard_sessions"("sessionHash");

-- CreateIndex
CREATE INDEX "dashboard_sessions_identityId_idx" ON "dashboard_sessions"("identityId");

-- CreateIndex
CREATE INDEX "dashboard_sessions_expiresAt_idx" ON "dashboard_sessions"("expiresAt");

-- AddForeignKey
ALTER TABLE "guild_configs" ADD CONSTRAINT "guild_configs_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_resources" ADD CONSTRAINT "guild_resources_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anti_nuke_rules" ADD CONSTRAINT "anti_nuke_rules_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anti_raid_configs" ADD CONSTRAINT "anti_raid_configs_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beast_mode_states" ADD CONSTRAINT "beast_mode_states_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automod_configs" ADD CONSTRAINT "automod_configs_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_configs" ADD CONSTRAINT "verification_configs_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "log_channels" ADD CONSTRAINT "log_channels_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whitelist_entries" ADD CONSTRAINT "whitelist_entries_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_approvals" ADD CONSTRAINT "bot_approvals_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "security_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punishments" ADD CONSTRAINT "punishments_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punishments" ADD CONSTRAINT "punishments_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "security_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warnings" ADD CONSTRAINT "warnings_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warnings" ADD CONSTRAINT "warnings_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "moderation_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "critical_approvals" ADD CONSTRAINT "critical_approvals_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_challenges" ADD CONSTRAINT "verification_challenges_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backups" ADD CONSTRAINT "backups_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "backups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "oauth_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_sessions" ADD CONSTRAINT "dashboard_sessions_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "oauth_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
