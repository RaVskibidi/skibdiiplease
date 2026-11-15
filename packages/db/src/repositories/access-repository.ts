import { z } from 'zod';

import type { AccessGrant } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, TenantRepository } from './base.ts';

export const accessGrantSchema = z
  .object({
    subjectType: z.enum(['USER', 'ROLE']),
    subjectId: z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake'),
    permissionKeys: z.array(z.string().trim().min(1).max(64)).min(1).max(64),
    grantedBy: z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake'),
    expiresAt: z.date().nullable().optional(),
  })
  .strict();

export type AccessGrantInput = z.input<typeof accessGrantSchema>;

/** T77 staff grants. Discord hierarchy is still enforced by the bot later. */
export class AccessGrantRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async grant(input: AccessGrantInput): Promise<AccessGrant> {
    const parsed = accessGrantSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const existing = await transaction.accessGrant.findUnique({
        where: {
          guildId_subjectType_subjectId: {
            guildId: this.guildId,
            subjectType: parsed.subjectType,
            subjectId: parsed.subjectId,
          },
        },
      });

      const grant = await transaction.accessGrant.upsert({
        where: {
          guildId_subjectType_subjectId: {
            guildId: this.guildId,
            subjectType: parsed.subjectType,
            subjectId: parsed.subjectId,
          },
        },
        create: {
          guildId: this.guildId,
          subjectType: parsed.subjectType,
          subjectId: parsed.subjectId,
          permissionKeys: parsed.permissionKeys,
          grantedBy: parsed.grantedBy,
          expiresAt: parsed.expiresAt ?? null,
        },
        update: {
          permissionKeys: parsed.permissionKeys,
          grantedBy: parsed.grantedBy,
          expiresAt: parsed.expiresAt ?? null,
          revokedAt: null,
          revokedBy: null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId: parsed.grantedBy,
        action: AUDIT_ACTIONS.accessGranted,
        targetType: 'AccessGrant',
        targetId: grant.id,
        before:
          existing === null
            ? null
            : {
                permissionKeys: existing.permissionKeys,
                expiresAt: existing.expiresAt?.toISOString() ?? null,
              },
        after: {
          subjectType: grant.subjectType,
          subjectId: grant.subjectId,
          permissionKeys: grant.permissionKeys,
          expiresAt: grant.expiresAt?.toISOString() ?? null,
        },
      });

      return grant;
    });
  }

  public async revoke(grantId: string, actorId: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.accessGrant.findFirst({ where: { id: grantId, guildId: this.guildId } }),
        'access grant',
        grantId,
      );

      if (before.revokedAt !== null) {
        return false;
      }

      const result = await transaction.accessGrant.updateMany({
        where: { id: grantId, guildId: this.guildId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: actorId },
      });

      if (result.count !== 1) {
        return false;
      }

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId,
        action: AUDIT_ACTIONS.accessRevoked,
        targetType: 'AccessGrant',
        targetId: grantId,
        before: {
          permissionKeys: before.permissionKeys,
          subjectId: before.subjectId,
        },
      });

      return true;
    });
  }

  public async listActive(): Promise<AccessGrant[]> {
    return this.database.client.accessGrant.findMany({
      where: {
        guildId: this.guildId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  public async findForSubject(
    subjectType: 'USER' | 'ROLE',
    subjectId: string,
  ): Promise<AccessGrant | null> {
    return this.database.client.accessGrant.findFirst({
      where: {
        guildId: this.guildId,
        subjectType,
        subjectId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
  }
}
