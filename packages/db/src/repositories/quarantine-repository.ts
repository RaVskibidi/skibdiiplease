import { z } from 'zod';

import type { QuarantineEntry } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, TenantRepository } from './base.ts';

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');

export const quarantineApplySchema = z
  .object({
    userId: snowflakeSchema,
    roleId: snowflakeSchema,
    reason: z.string().trim().min(1).max(500),
    incidentId: z.string().cuid().nullable().optional(),
    requiresVerification: z.boolean().default(true),
    appliedAt: z.date().optional(),
  })
  .strict();

export type QuarantineApplyInput = z.input<typeof quarantineApplySchema>;

/**
 * Durable record of every quarantine T77 applies.
 *
 * The repository never grants or removes Discord roles itself; it records intent
 * and outcome so the bot adapter can reconcile roles after a restart and so an
 * operator can audit exactly why a member lost access.
 */
export class QuarantineRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  /** Creates or refreshes the active quarantine for a member. */
  public async apply(input: QuarantineApplyInput): Promise<QuarantineEntry> {
    const parsed = quarantineApplySchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const existing = await transaction.quarantineEntry.findFirst({
        where: {
          guildId: this.guildId,
          userId: parsed.userId,
          status: 'ACTIVE',
        },
      });

      const entry =
        existing === null
          ? await transaction.quarantineEntry.create({
              data: {
                guildId: this.guildId,
                userId: parsed.userId,
                roleId: parsed.roleId,
                reason: parsed.reason,
                incidentId: parsed.incidentId ?? null,
                requiresVerification: parsed.requiresVerification,
                appliedAt: parsed.appliedAt ?? new Date(),
              },
            })
          : await transaction.quarantineEntry.update({
              where: { id: existing.id },
              data: {
                roleId: parsed.roleId,
                reason: parsed.reason,
                requiresVerification: parsed.requiresVerification,
                ...(parsed.incidentId === undefined ? {} : { incidentId: parsed.incidentId }),
              },
            });

      await this.appendAudit(transaction, {
        action: AUDIT_ACTIONS.quarantineApplied,
        targetType: 'QuarantineEntry',
        targetId: entry.id,
        before:
          existing === null ? undefined : { status: existing.status, roleId: existing.roleId },
        after: {
          userId: entry.userId,
          roleId: entry.roleId,
          incidentId: entry.incidentId,
          reason: entry.reason,
        },
      });

      return entry;
    });
  }

  /** Marks a quarantine released after the Discord role was removed. */
  public async release(input: {
    readonly entryId: string;
    readonly releasedBy?: string | null;
    readonly reason?: string;
  }): Promise<QuarantineEntry | null> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.quarantineEntry.findFirst({
          where: { id: input.entryId, guildId: this.guildId },
        }),
        'quarantine entry',
        input.entryId,
      );

      if (before.status !== 'ACTIVE') {
        return before;
      }

      const entry = await transaction.quarantineEntry.update({
        where: { id: input.entryId },
        data: {
          status: 'RELEASED',
          releasedAt: new Date(),
          releasedBy: input.releasedBy ?? null,
          releaseReason: input.reason ?? null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: input.releasedBy ? 'USER' : 'SYSTEM',
        actorId: input.releasedBy ?? null,
        action: AUDIT_ACTIONS.quarantineReleased,
        targetType: 'QuarantineEntry',
        targetId: entry.id,
        before: { status: before.status },
        after: { status: entry.status, reason: entry.releaseReason },
      });

      return entry;
    });
  }

  public async findActiveByUser(userId: string): Promise<QuarantineEntry | null> {
    return this.database.client.quarantineEntry.findFirst({
      where: { guildId: this.guildId, userId, status: 'ACTIVE' },
      orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
    });
  }

  public async listActive(limit = 100): Promise<QuarantineEntry[]> {
    return this.database.client.quarantineEntry.findMany({
      where: { guildId: this.guildId, status: 'ACTIVE' },
      orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  /** Counts active quarantines; used by status embeds and dashboards. */
  public async countActive(): Promise<number> {
    return this.database.client.quarantineEntry.count({
      where: { guildId: this.guildId, status: 'ACTIVE' },
    });
  }
}
