import { z } from 'zod';

import type { AntiNukeAction, WhitelistEntry } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import { TenantRecordNotFoundError } from '../errors.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, TenantRepository } from './base.ts';

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');

export const whitelistCreateSchema = z
  .object({
    targetType: z.enum(['USER', 'ROLE', 'CHANNEL']),
    targetId: snowflakeSchema,
    scope: z.enum(['GLOBAL', 'ACTION']).default('GLOBAL'),
    action: z
      .enum([
        'MEMBER_BAN',
        'MEMBER_KICK',
        'MEMBER_PRUNE',
        'MEMBER_ROLE_UPDATE',
        'CHANNEL_CREATE',
        'CHANNEL_DELETE',
        'CHANNEL_UPDATE',
        'CHANNEL_PERMISSION_UPDATE',
        'ROLE_CREATE',
        'ROLE_DELETE',
        'ROLE_UPDATE',
        'ROLE_PERMISSION_UPDATE',
        'ADMINISTRATOR_GRANT',
        'DANGEROUS_ROLE_ASSIGN',
        'MASS_ROLE_ASSIGN',
        'BOT_ADD',
        'WEBHOOK_CREATE',
        'WEBHOOK_UPDATE',
        'WEBHOOK_DELETE',
        'GUILD_UPDATE',
        'VANITY_URL_UPDATE',
        'INVITE_DELETE',
        'EMOJI_UPDATE',
        'STICKER_UPDATE',
        'INTEGRATION_CREATE',
        'INTEGRATION_UPDATE',
        'INTEGRATION_DELETE',
      ])
      .nullable()
      .optional(),
    reason: z.string().trim().min(3).max(500),
    createdBy: snowflakeSchema,
    expiresAt: z.date().nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.scope === 'GLOBAL' || (value.action !== null && value.action !== undefined),
    {
      message: 'action is required for ACTION-scoped whitelist entries',
    },
  )
  .refine(
    (value) => value.scope !== 'GLOBAL' || value.action === null || value.action === undefined,
    {
      message: 'global whitelist entries cannot target a specific action',
    },
  );

export type WhitelistCreateInput = z.input<typeof whitelistCreateSchema>;

/** Dashboard edits limited to mutable fields; targets are immutable. */
export const whitelistUpdateSchema = z
  .object({
    scope: z.enum(['GLOBAL', 'ACTION']).optional(),
    action: whitelistCreateSchema.shape.action,
    reason: z.string().trim().min(3).max(500).optional(),
    expiresAt: z.date().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export type WhitelistUpdateInput = z.input<typeof whitelistUpdateSchema>;

/** Tenant-scoped whitelist persistence with append-only revocation history. */
export class WhitelistRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async add(input: WhitelistCreateInput): Promise<WhitelistEntry> {
    const parsed = whitelistCreateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const entry = await transaction.whitelistEntry.create({
        data: {
          guildId: this.guildId,
          targetType: parsed.targetType,
          targetId: parsed.targetId,
          scope: parsed.scope,
          action: parsed.action ?? null,
          reason: parsed.reason,
          createdBy: parsed.createdBy,
          expiresAt: parsed.expiresAt ?? null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId: parsed.createdBy,
        action: AUDIT_ACTIONS.whitelistCreated,
        targetType: 'WhitelistEntry',
        targetId: entry.id,
        after: {
          targetType: entry.targetType,
          targetId: entry.targetId,
          scope: entry.scope,
          action: entry.action,
          expiresAt: entry.expiresAt?.toISOString() ?? null,
          reason: entry.reason,
        },
      });

      return entry;
    });
  }

  public async list(
    options: { activeOnly?: boolean; limit?: number } = {},
  ): Promise<WhitelistEntry[]> {
    const activeOnly = options.activeOnly ?? true;
    const now = new Date();

    return this.database.client.whitelistEntry.findMany({
      where: {
        guildId: this.guildId,
        ...(activeOnly
          ? {
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(options.limit ?? 100, 1), 500),
    });
  }

  public async findActive(
    targetType: 'USER' | 'ROLE' | 'CHANNEL',
    targetId: string,
    action?: string,
  ): Promise<WhitelistEntry[]> {
    const now = new Date();

    return this.database.client.whitelistEntry.findMany({
      where: {
        guildId: this.guildId,
        targetType,
        targetId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        AND: [
          {
            OR: [
              { scope: 'GLOBAL' as const },
              ...(action === undefined
                ? []
                : [{ scope: 'ACTION' as const, action: action as AntiNukeAction }]),
            ],
          },
        ],
      },
      orderBy: [{ scope: 'asc' }, { createdAt: 'desc' }],
    });
  }

  public async update(
    id: string,
    input: WhitelistUpdateInput,
    actorId: string,
  ): Promise<WhitelistEntry> {
    const parsed = whitelistUpdateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.whitelistEntry.findFirst({ where: { id, guildId: this.guildId } }),
        'whitelist entry',
        id,
      );
      if (before.revokedAt !== null) {
        throw new TenantRecordNotFoundError('active whitelist entry', id);
      }

      const next = {
        targetType: before.targetType,
        targetId: before.targetId,
        scope: parsed.scope ?? before.scope,
        action: parsed.action === undefined ? before.action : parsed.action,
        reason: parsed.reason ?? before.reason,
        createdBy: before.createdBy,
        expiresAt: parsed.expiresAt === undefined ? before.expiresAt : parsed.expiresAt,
      };
      whitelistCreateSchema.parse(next);

      const entry = await transaction.whitelistEntry.update({
        where: { id },
        data: {
          scope: next.scope,
          action: next.action,
          reason: next.reason,
          expiresAt: next.expiresAt,
        },
      });

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId,
        action: AUDIT_ACTIONS.whitelistUpdated,
        targetType: 'WhitelistEntry',
        targetId: id,
        before: {
          scope: before.scope,
          action: before.action,
          reason: before.reason,
          expiresAt: before.expiresAt?.toISOString() ?? null,
        },
        after: {
          scope: entry.scope,
          action: entry.action,
          reason: entry.reason,
          expiresAt: entry.expiresAt?.toISOString() ?? null,
        },
      });

      return entry;
    });
  }

  public async revoke(id: string, actorId: string, reason?: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.whitelistEntry.findFirst({ where: { id, guildId: this.guildId } }),
        'whitelist entry',
        id,
      );

      if (before.revokedAt !== null) {
        return false;
      }

      const result = await transaction.whitelistEntry.updateMany({
        where: { id, guildId: this.guildId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: actorId },
      });

      if (result.count !== 1) {
        return false;
      }

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId,
        action: AUDIT_ACTIONS.whitelistRevoked,
        targetType: 'WhitelistEntry',
        targetId: id,
        before: { revokedAt: null, targetId: before.targetId, scope: before.scope },
        after: { revokedAt: new Date().toISOString(), reason: reason ?? null },
      });

      return true;
    });
  }
}
