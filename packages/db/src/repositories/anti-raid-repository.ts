import { z } from 'zod';

import type { AntiRaidConfig } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, TenantRepository } from './base.ts';

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');
const weightSchema = z.number().int().min(0).max(100);

export const antiRaidConfigUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    joinWindowSeconds: z.number().int().min(10).max(3_600).optional(),
    aggregateThreshold: z.number().int().min(2).max(10_000).optional(),
    minimumSignals: z.number().int().min(1).max(5).optional(),
    minimumAccountAgeDays: z.number().int().min(0).max(365).optional(),
    riskThreshold: z.number().int().min(1).max(100).optional(),
    quarantineRoleId: snowflakeSchema.nullable().optional(),
    quarantineEnabled: z.boolean().optional(),
    lockdownEnabled: z.boolean().optional(),
    autoBanEnabled: z.boolean().optional(),
    verificationRequired: z.boolean().optional(),
    bypassBadges: z.array(z.string().trim().min(1).max(64)).max(25).optional(),
    velocityWeight: weightSchema.optional(),
    accountAgeWeight: weightSchema.optional(),
    avatarWeight: weightSchema.optional(),
    similarAgeWeight: weightSchema.optional(),
    suspiciousNameWeight: weightSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'at least one Anti-Raid field must be provided',
  );

export type AntiRaidConfigUpdateInput = z.input<typeof antiRaidConfigUpdateSchema>;

/**
 * Raid policy persistence. New guilds start alert-only; quarantine and lockdown
 * remain dormant until the guild's automation mode and owner approval allow them.
 */
export class AntiRaidRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async getOrCreate(): Promise<AntiRaidConfig> {
    return this.database.client.antiRaidConfig.upsert({
      where: { guildId: this.guildId },
      create: { guildId: this.guildId },
      update: {},
    });
  }

  public async update(
    input: AntiRaidConfigUpdateInput,
    actorId?: string | null,
  ): Promise<AntiRaidConfig> {
    const parsed = antiRaidConfigUpdateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      await this.getOrCreate();

      const before = this.assertRowOwnership(
        await transaction.antiRaidConfig.findUnique({ where: { guildId: this.guildId } }),
        'Anti-Raid config',
        this.guildId,
      );

      const config = await transaction.antiRaidConfig.update({
        where: { guildId: this.guildId },
        data: {
          ...parsed,
          updatedBy: actorId ?? this.tenant.actorId ?? null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: actorId ? 'USER' : 'SYSTEM',
        actorId: actorId ?? null,
        action: AUDIT_ACTIONS.antiRaidConfigUpdated,
        targetType: 'AntiRaidConfig',
        targetId: this.guildId,
        before: antiRaidSnapshot(before),
        after: antiRaidSnapshot(config),
      });

      return config;
    });
  }
}

function antiRaidSnapshot(config: AntiRaidConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    joinWindowSeconds: config.joinWindowSeconds,
    aggregateThreshold: config.aggregateThreshold,
    minimumSignals: config.minimumSignals,
    minimumAccountAgeDays: config.minimumAccountAgeDays,
    riskThreshold: config.riskThreshold,
    quarantineRoleId: config.quarantineRoleId,
    quarantineEnabled: config.quarantineEnabled,
    lockdownEnabled: config.lockdownEnabled,
    autoBanEnabled: config.autoBanEnabled,
    verificationRequired: config.verificationRequired,
  };
}
