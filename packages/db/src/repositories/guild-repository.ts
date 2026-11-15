import type { Guild, GuildConfig, Prisma } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import { isUniqueConstraintError } from '../client.ts';
import { GUILD_CONFIG_DEFAULTS } from '../config/schema.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import { createTenantContext, type TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, TenantRepository } from './base.ts';

export interface GuildBootstrapInput {
  id: string;
  name: string;
  ownerId: string;
  iconUrl?: string | null;
  memberCount?: number;
  actorId?: string | null;
}

export interface GuildBootstrapResult {
  guild: Guild;
  config: GuildConfig;
  created: boolean;
}

/**
 * Creates the tenant row plus its default configuration records.
 *
 * This operation is intentionally outside a single guild context: it is the
 * system-level join path that establishes the tenant. It is idempotent so a
 * duplicated gateway event cannot create a second guild or reset settings.
 */
export async function bootstrapGuild(
  database: Database,
  input: GuildBootstrapInput,
  logger: DbLogger = silentDbLogger,
): Promise<GuildBootstrapResult> {
  validateBootstrapInput(input);

  try {
    return await database.transaction(async (transaction) => {
      const existing = await transaction.guild.findUnique({ where: { id: input.id } });

      if (existing) {
        const guild = await transaction.guild.update({
          where: { id: input.id },
          data: {
            name: input.name,
            ownerId: input.ownerId,
            iconUrl: input.iconUrl ?? null,
            memberCount: input.memberCount ?? existing.memberCount,
            botLeftAt: null,
          },
        });

        const config = await ensureDefaultRecords(transaction, guild.id, input.actorId ?? null);
        logger.debug({ guildId: guild.id }, 'T77 guild bootstrap refreshed existing tenant');
        return { guild, config, created: false };
      }

      const guild = await transaction.guild.create({
        data: {
          id: input.id,
          name: input.name,
          ownerId: input.ownerId,
          iconUrl: input.iconUrl ?? null,
          memberCount: input.memberCount ?? 0,
        },
      });

      const config = await ensureDefaultRecords(transaction, guild.id, input.actorId ?? null);

      await transaction.auditEntry.create({
        data: {
          guildId: guild.id,
          actorType: input.actorId ? 'USER' : 'BOT',
          actorId: input.actorId ?? null,
          action: AUDIT_ACTIONS.guildBootstrap,
          targetType: 'Guild',
          targetId: guild.id,
          after: {
            name: guild.name,
            ownerId: guild.ownerId,
            automationMode: GUILD_CONFIG_DEFAULTS.automationMode,
          },
        },
      });

      logger.info({ guildId: guild.id, guildName: guild.name }, 'T77 guild tenant bootstrapped');

      return { guild, config, created: true };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // A concurrent bootstrap won the race. Re-read the committed tenant.
      const guild = await database.client.guild.findUnique({ where: { id: input.id } });
      const config = await database.client.guildConfig.findUnique({ where: { guildId: input.id } });
      if (guild && config) {
        return { guild, config, created: false };
      }
    }

    throw error;
  }
}

async function ensureDefaultRecords(
  transaction: Prisma.TransactionClient,
  guildId: string,
  actorId: string | null,
): Promise<GuildConfig> {
  const config = await transaction.guildConfig.upsert({
    where: { guildId },
    create: {
      guildId,
      ...GUILD_CONFIG_DEFAULTS,
      updatedBy: actorId,
    },
    update: {},
  });

  await transaction.antiRaidConfig.upsert({
    where: { guildId },
    create: { guildId, updatedBy: actorId },
    update: {},
  });

  await transaction.beastModeState.upsert({
    where: { guildId },
    create: { guildId },
    update: {},
  });

  await transaction.automodConfig.upsert({
    where: { guildId },
    create: { guildId, updatedBy: actorId },
    update: {},
  });

  await transaction.verificationConfig.upsert({
    where: { guildId },
    create: { guildId, updatedBy: actorId },
    update: {},
  });

  return config;
}

function validateBootstrapInput(input: GuildBootstrapInput): void {
  const context = createTenantContext({ guildId: input.id, actorId: input.actorId });
  if (context.guildId !== input.id) {
    throw new Error('Guild bootstrap tenant validation failed.');
  }

  if (input.name.trim().length === 0 || input.name.length > 100) {
    throw new Error('Guild bootstrap requires a valid guild name.');
  }

  if (!/^\d{17,20}$/u.test(input.ownerId)) {
    throw new Error('Guild bootstrap requires a valid Discord owner ID.');
  }
}

/**
 * Returns every guild where T77 is still present. System-level operations such
 * as the worker scheduler use this instead of a tenant-scoped repository.
 */
export async function listActiveGuildIds(database: Database): Promise<string[]> {
  const rows = await database.client.guild.findMany({
    where: { botLeftAt: null },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => row.id);
}

/** Tenant-scoped read and lifecycle operations on the guild row itself. */
export class GuildRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async get(): Promise<Guild> {
    const guild = await this.database.client.guild.findUnique({ where: { id: this.guildId } });
    return this.assertGuildRowOwnership(guild, 'guild', this.guildId);
  }

  public async updateMetadata(input: {
    name?: string;
    iconUrl?: string | null;
    memberCount?: number;
    actorId?: string | null;
  }): Promise<Guild> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertGuildRowOwnership(
        await transaction.guild.findUnique({ where: { id: this.guildId } }),
        'guild',
        this.guildId,
      );

      const guild = await transaction.guild.update({
        where: { id: this.guildId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.iconUrl === undefined ? {} : { iconUrl: input.iconUrl }),
          ...(input.memberCount === undefined ? {} : { memberCount: input.memberCount }),
        },
      });

      await this.appendAudit(transaction, {
        actorType: input.actorId ? 'USER' : 'BOT',
        actorId: input.actorId ?? null,
        action: AUDIT_ACTIONS.guildUpdated,
        targetType: 'Guild',
        targetId: this.guildId,
        before: { name: before.name, iconUrl: before.iconUrl, memberCount: before.memberCount },
        after: { name: guild.name, iconUrl: guild.iconUrl, memberCount: guild.memberCount },
      });

      return guild;
    });
  }

  public async markLeft(): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const before = this.assertGuildRowOwnership(
        await transaction.guild.findUnique({ where: { id: this.guildId } }),
        'guild',
        this.guildId,
      );

      await transaction.guild.update({
        where: { id: this.guildId },
        data: { botLeftAt: new Date() },
      });

      await this.appendAudit(transaction, {
        action: AUDIT_ACTIONS.guildLeft,
        targetType: 'Guild',
        targetId: this.guildId,
        before: { botLeftAt: before.botLeftAt },
        after: { botLeftAt: new Date().toISOString() },
      });
    });
  }
}
