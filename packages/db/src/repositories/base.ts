import type { Prisma } from '../generated/prisma/client.ts';
import type { DbLogger } from '../logger.js';
import { silentDbLogger } from '../logger.js';
import type { Database } from '../client.js';
import { TenantContextError, TenantIsolationError, TenantRecordNotFoundError } from '../errors.js';
import type { TenantContext } from '../tenant.js';
import { assertTenantScope, isDiscordSnowflake } from '../tenant.js';

export interface AuditWriteInput {
  actorType?: 'USER' | 'BOT' | 'SYSTEM';
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  diff?: unknown;
  requestId?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
  confirmationId?: string | null;
}

/**
 * Base class for every guild-scoped repository.
 *
 * Repositories never accept a bare guild ID for individual operations; they read
 * it from the immutable TenantContext. Attempting to act on a row from another
 * guild raises TenantIsolationError before any mutation is returned.
 */
export abstract class TenantRepository {
  protected readonly database: Database;
  protected readonly tenant: TenantContext;
  protected readonly logger: DbLogger;

  protected constructor(
    database: Database,
    tenant: TenantContext,
    logger: DbLogger = silentDbLogger,
  ) {
    if (!isDiscordSnowflake(tenant.guildId)) {
      throw new TenantContextError('A repository requires a valid guild-scoped tenant context.');
    }

    this.database = database;
    this.tenant = tenant;
    this.logger = logger;
  }

  protected get guildId(): string {
    return this.tenant.guildId;
  }

  protected scoped<T extends Record<string, unknown>>(where?: T): T & { guildId: string } {
    return { ...(where ?? ({} as T)), guildId: this.guildId };
  }

  /** Verifies a fetched row belongs to the active tenant and returns it. */
  protected assertRowOwnership<T extends { guildId: string }>(
    row: T | null,
    resource: string,
    id: string,
  ): T {
    if (row === null) {
      throw new TenantRecordNotFoundError(resource, id);
    }

    assertTenantScope(this.tenant, row.guildId, `${resource}.read`);
    return row;
  }

  /** Verifies a fetched guild root row matches the active tenant. */
  protected assertGuildRowOwnership<T extends { id: string }>(
    row: T | null,
    resource: string,
    id: string,
  ): T {
    if (row === null) {
      throw new TenantRecordNotFoundError(resource, id);
    }

    assertTenantScope(this.tenant, row.id, `${resource}.read`);
    return row;
  }

  /** Appends one audit entry inside an existing transaction. */
  protected async appendAudit(
    transaction: Prisma.TransactionClient,
    entry: AuditWriteInput,
  ): Promise<void> {
    await transaction.auditEntry.create({
      data: {
        guildId: this.guildId,
        actorType: entry.actorType ?? 'SYSTEM',
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        before: toJsonInput(entry.before),
        after: toJsonInput(entry.after),
        diff: toJsonInput(entry.diff),
        requestId: entry.requestId ?? this.tenant.requestId ?? null,
        ipHash: entry.ipHash ?? null,
        userAgent: entry.userAgent ?? null,
        confirmationId: entry.confirmationId ?? null,
      },
    });
  }

  protected rejectCrossTenantRow(guildId: string, operation: string): never {
    throw new TenantIsolationError(
      `Tenant isolation violation during ${operation}: context guild ${this.guildId} attempted to access ${guildId}.`,
      { operation, contextGuildId: this.guildId, actualGuildId: guildId },
    );
  }
}

/** Serializes arbitrary data into a Prisma JSON input value. */
export function toJsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export const AUDIT_ACTIONS = {
  guildBootstrap: 'guild.bootstrap',
  guildUpdated: 'guild.updated',
  guildLeft: 'guild.left',
  configUpdated: 'config.updated',
  configReset: 'config.reset',
  whitelistCreated: 'whitelist.created',
  whitelistRevoked: 'whitelist.revoked',
  whitelistUpdated: 'whitelist.updated',
  accessGranted: 'access.granted',
  accessRevoked: 'access.revoked',
  moderationCaseCreated: 'moderation.case.created',
  moderationCaseClosed: 'moderation.case.closed',
  warningCreated: 'moderation.warning.created',
  warningRevoked: 'moderation.warning.revoked',
  incidentOpened: 'incident.opened',
  incidentClosed: 'incident.closed',
  incidentUpdated: 'incident.updated',
  antiNukeRulesSeeded: 'antinuke.rules.seeded',
  antiNukeRuleUpdated: 'antinuke.rule.updated',
  antiRaidConfigUpdated: 'antiraid.config.updated',
  automodConfigUpdated: 'automod.config.updated',
  verificationConfigUpdated: 'verification.config.updated',
  verificationChallengeIssued: 'verification.challenge.issued',
  verificationChallengePassed: 'verification.challenge.passed',
  verificationChallengeFailed: 'verification.challenge.failed',
  verificationChallengeExpired: 'verification.challenge.expired',
  verificationChallengeInvalidated: 'verification.challenge.invalidated',
  beastModeSettingsUpdated: 'beast.settings.updated',
  beastModeActivated: 'beast.activated',
  beastModeDeactivated: 'beast.deactivated',
  quarantineApplied: 'quarantine.applied',
  quarantineReleased: 'quarantine.released',
  enforcementApproved: 'config.enforcement.approved',
  enforcementRevoked: 'config.enforcement.revoked',
  punishmentProposed: 'security.punishment.proposed',
  punishmentSkipped: 'security.punishment.skipped',
  punishmentApplied: 'security.punishment.applied',
  punishmentFailed: 'security.punishment.failed',
  botApproved: 'bot.approval.granted',
  botApprovalRevoked: 'bot.approval.revoked',
  logChannelUpdated: 'logging.channel.updated',
  backupCreated: 'backup.created',
  backupUpdated: 'backup.updated',
  backupDeleted: 'backup.deleted',
  backupRestoreRequested: 'backup.restore.requested',
  backupRestorePreviewed: 'backup.restore.previewed',
  backupRestoreCompleted: 'backup.restore.completed',
  backupRestoreFailed: 'backup.restore.failed',
  backupRestoreCancelled: 'backup.restore.cancelled',
  dashboardActionRequested: 'dashboard.action.requested',
  dashboardActionCompleted: 'dashboard.action.completed',
  dashboardActionFailed: 'dashboard.action.failed',
  dashboardActionCancelled: 'dashboard.action.cancelled',
} as const;
