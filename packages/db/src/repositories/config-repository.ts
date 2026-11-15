import type { GuildConfig, Prisma } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import {
  GUILD_CONFIG_DEFAULTS,
  enforcementApprovalSchema,
  guildConfigUpdateSchema,
  type GuildConfigUpdate,
  type EnforcementApprovalInput,
} from '../config/schema.ts';
import { ConfigVersionConflictError, OwnerApprovalRequiredError } from '../errors.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { TenantRepository, AUDIT_ACTIONS } from './base.ts';

const CONFIG_KEYS = [
  'locale',
  'timezone',
  'automationMode',
  'antiNukeEnabled',
  'antiRaidEnabled',
  'beastModeEnabled',
  'automodEnabled',
  'verificationEnabled',
  'botProtectionEnabled',
  'loggingEnabled',
  'backupsEnabled',
  'backupIntervalHours',
  'backupRetentionDays',
  'lastScheduledBackupAt',
] as const;

/**
 * Versioned guild configuration persistence.
 *
 * Every write validates its payload, increments `version`, and appends an audit
 * entry in the same database transaction. A stale `expectedVersion` is rejected
 * instead of silently overwriting another administrator's change.
 */
export class GuildConfigRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async getOrCreate(actorId?: string | null): Promise<GuildConfig> {
    const existing = await this.database.client.guildConfig.findUnique({
      where: { guildId: this.guildId },
    });
    if (existing) {
      return this.assertRowOwnership(existing, 'guild configuration', this.guildId);
    }

    return this.database.transaction(async (transaction) => {
      const guild = this.assertGuildRowOwnership(
        await transaction.guild.findUnique({ where: { id: this.guildId } }),
        'guild',
        this.guildId,
      );

      const config = await transaction.guildConfig.create({
        data: {
          guildId: guild.id,
          ...GUILD_CONFIG_DEFAULTS,
          updatedBy: actorId ?? this.tenant.actorId ?? null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: actorId ? 'USER' : 'SYSTEM',
        actorId: actorId ?? null,
        action: AUDIT_ACTIONS.configUpdated,
        targetType: 'GuildConfig',
        targetId: guild.id,
        after: GUILD_CONFIG_DEFAULTS,
      });

      return config;
    });
  }

  public async update(input: GuildConfigUpdate, actorId?: string | null): Promise<GuildConfig> {
    const parsed = guildConfigUpdateSchema.parse(input);
    const { expectedVersion, ...changes } = parsed;
    const actor = actorId ?? this.tenant.actorId ?? null;

    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.guildConfig.findUnique({ where: { guildId: this.guildId } }),
        'guild configuration',
        this.guildId,
      );

      if (expectedVersion !== undefined && expectedVersion !== before.version) {
        throw new ConfigVersionConflictError(expectedVersion, before.version);
      }

      const result = await transaction.guildConfig.updateMany({
        where: { guildId: this.guildId, version: before.version },
        data: {
          ...toConfigUpdateData(changes),
          version: { increment: 1 },
          updatedBy: actor,
        },
      });

      if (result.count !== 1) {
        const current = await transaction.guildConfig.findUnique({
          where: { guildId: this.guildId },
        });
        throw new ConfigVersionConflictError(
          expectedVersion ?? before.version,
          current?.version ?? -1,
        );
      }

      const after = this.assertRowOwnership(
        await transaction.guildConfig.findUnique({ where: { guildId: this.guildId } }),
        'guild configuration',
        this.guildId,
      );

      const diff = buildConfigDiff(before, after);

      await this.appendAudit(transaction, {
        actorType: actor ? 'USER' : 'SYSTEM',
        actorId: actor,
        action: AUDIT_ACTIONS.configUpdated,
        targetType: 'GuildConfig',
        targetId: this.guildId,
        before: pickConfig(before),
        after: pickConfig(after),
        diff,
      });

      return after;
    });
  }

  public async reset(actorId?: string | null, expectedVersion?: number): Promise<GuildConfig> {
    const actor = actorId ?? this.tenant.actorId ?? null;

    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.guildConfig.findUnique({ where: { guildId: this.guildId } }),
        'guild configuration',
        this.guildId,
      );

      if (expectedVersion !== undefined && expectedVersion !== before.version) {
        throw new ConfigVersionConflictError(expectedVersion, before.version);
      }

      const after = await transaction.guildConfig.update({
        where: { guildId: this.guildId },
        data: {
          ...GUILD_CONFIG_DEFAULTS,
          version: { increment: 1 },
          updatedBy: actor,
        },
      });

      await this.appendAudit(transaction, {
        actorType: actor ? 'USER' : 'SYSTEM',
        actorId: actor,
        action: AUDIT_ACTIONS.configReset,
        targetType: 'GuildConfig',
        targetId: this.guildId,
        before: pickConfig(before),
        after: pickConfig(after),
        diff: buildConfigDiff(before, after),
      });

      return after;
    });
  }

  /**
   * Records explicit owner consent before T77 may perform automatic containment.
   * This is deliberately separate from ordinary config updates: a staff member
   * can tune thresholds, but only the Discord owner can approve enforcement.
   */
  public async approveEnforcement(input: EnforcementApprovalInput): Promise<GuildConfig> {
    const parsed = enforcementApprovalSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const guild = this.assertGuildRowOwnership(
        await transaction.guild.findUnique({ where: { id: this.guildId } }),
        'guild',
        this.guildId,
      );

      if (guild.ownerId !== parsed.approvedBy) {
        throw new OwnerApprovalRequiredError(
          `Enforcement approval for guild ${this.guildId} must be confirmed by its owner.`,
        );
      }

      const before = this.assertRowOwnership(
        await transaction.guildConfig.findUnique({ where: { guildId: this.guildId } }),
        'guild configuration',
        this.guildId,
      );

      const after = await transaction.guildConfig.update({
        where: { guildId: this.guildId },
        data: {
          automationMode: parsed.mode,
          enforcementApprovedAt: new Date(),
          enforcementApprovedBy: parsed.approvedBy,
          enforcementPolicyVersion: parsed.policyVersion,
          version: { increment: 1 },
          updatedBy: parsed.approvedBy,
        },
      });

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId: parsed.approvedBy,
        action: AUDIT_ACTIONS.enforcementApproved,
        targetType: 'GuildConfig',
        targetId: this.guildId,
        before: {
          automationMode: before.automationMode,
          enforcementApprovedAt: before.enforcementApprovedAt?.toISOString() ?? null,
          enforcementPolicyVersion: before.enforcementPolicyVersion,
        },
        after: {
          automationMode: after.automationMode,
          enforcementApprovedAt: after.enforcementApprovedAt?.toISOString() ?? null,
          enforcementApprovedBy: after.enforcementApprovedBy,
          enforcementPolicyVersion: after.enforcementPolicyVersion,
        },
      });

      return after;
    });
  }

  /**
   * Records when a scheduled backup was requested. This is deliberately not a
   * versioned config change: it is scheduler bookkeeping, not administrator
   * intent, so it never invalidates a concurrent config edit.
   */
  public async markScheduledBackup(at: Date): Promise<boolean> {
    const result = await this.database.client.guildConfig.updateMany({
      where: { guildId: this.guildId },
      data: { lastScheduledBackupAt: at },
    });
    return result.count === 1;
  }

  /** Returns to observation mode and clears the recorded approval. */
  public async revokeEnforcement(actorId: string, reason?: string): Promise<GuildConfig> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.guildConfig.findUnique({ where: { guildId: this.guildId } }),
        'guild configuration',
        this.guildId,
      );

      const after = await transaction.guildConfig.update({
        where: { guildId: this.guildId },
        data: {
          automationMode: 'OBSERVE',
          enforcementApprovedAt: null,
          enforcementApprovedBy: null,
          enforcementPolicyVersion: null,
          version: { increment: 1 },
          updatedBy: actorId,
        },
      });

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId,
        action: AUDIT_ACTIONS.enforcementRevoked,
        targetType: 'GuildConfig',
        targetId: this.guildId,
        before: {
          automationMode: before.automationMode,
          enforcementApprovedBy: before.enforcementApprovedBy,
          enforcementPolicyVersion: before.enforcementPolicyVersion,
        },
        after: {
          automationMode: after.automationMode,
          reason: reason ?? null,
        },
      });

      return after;
    });
  }
}

function toConfigUpdateData(
  changes: Partial<Omit<GuildConfigUpdate, 'expectedVersion'>>,
): Prisma.GuildConfigUpdateManyMutationInput {
  return { ...changes };
}

export function pickConfig(config: GuildConfig): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    picked[key] = config[key];
  }
  return picked;
}

export function buildConfigDiff(
  before: GuildConfig,
  after: GuildConfig,
): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of CONFIG_KEYS) {
    if (before[key] !== after[key]) {
      diff[key] = { before: before[key], after: after[key] };
    }
  }
  return diff;
}

export interface DueBackupSettings {
  readonly guildId: string;
  readonly intervalHours: number;
  readonly retentionDays: number;
  readonly lastScheduledBackupAt: Date | null;
}

/**
 * System-level scheduler query.
 *
 * The worker has no tenant context, so it reads the enabled schedule rows
 * directly. The interval comparison happens in JavaScript because PostgreSQL
 * has no portable way to compare a stored integer interval inside Prisma's
 * typed query API.
 */
export async function listGuildsDueForBackup(
  database: Database,
  now: Date = new Date(),
): Promise<DueBackupSettings[]> {
  const rows = await database.client.guildConfig.findMany({
    where: { backupsEnabled: true, guild: { botLeftAt: null } },
    select: {
      guildId: true,
      backupIntervalHours: true,
      backupRetentionDays: true,
      lastScheduledBackupAt: true,
    },
    orderBy: { guildId: 'asc' },
  });

  return rows
    .filter((row) => {
      if (row.lastScheduledBackupAt === null) {
        return true;
      }
      const intervalMs = row.backupIntervalHours * 3_600_000;
      return now.getTime() - row.lastScheduledBackupAt.getTime() >= intervalMs;
    })
    .map((row) => ({
      guildId: row.guildId,
      intervalHours: row.backupIntervalHours,
      retentionDays: row.backupRetentionDays,
      lastScheduledBackupAt: row.lastScheduledBackupAt,
    }));
}

/** Records a scheduled-backup request without requiring a tenant repository. */
export async function markScheduledBackupAt(
  database: Database,
  guildId: string,
  at: Date,
): Promise<boolean> {
  const result = await database.client.guildConfig.updateMany({
    where: { guildId },
    data: { lastScheduledBackupAt: at },
  });
  return result.count === 1;
}
