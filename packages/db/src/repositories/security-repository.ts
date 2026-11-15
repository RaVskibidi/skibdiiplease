import { z } from 'zod';

import type {
  AntiNukeRule,
  BotApproval,
  LogChannel,
  Punishment,
} from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import { isUniqueConstraintError } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, TenantRepository } from './base.ts';

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');

export const antiNukeActionSchema = z.enum([
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
]);

const punishmentTypeSchema = z.enum([
  'ALERT',
  'QUARANTINE',
  'ROLE_REMOVAL',
  'TIMEOUT',
  'KICK',
  'BAN',
]);

const punishmentStatusSchema = z.enum(['PROPOSED', 'SKIPPED', 'APPLIED', 'FAILED', 'REVERSED']);

const logCategorySchema = z.enum([
  'SECURITY',
  'ANTI_NUKE',
  'ANTI_RAID',
  'MODERATION',
  'MEMBER',
  'ROLE',
  'CHANNEL',
  'VERIFICATION',
  'BOT',
  'BACKUP',
]);

export const antiNukeRuleSeedSchema = z
  .object({
    action: antiNukeActionSchema,
    enabled: z.boolean().default(true),
    threshold: z.number().int().min(1).max(10_000),
    windowSeconds: z.number().int().min(1).max(86_400),
    containment: punishmentTypeSchema.default('ALERT'),
    requiresDestructiveApproval: z.boolean().default(true),
    cooldownSeconds: z.number().int().min(0).max(86_400).default(300),
  })
  .strict();

export const antiNukeRuleUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    threshold: z.number().int().min(1).max(10_000).optional(),
    windowSeconds: z.number().int().min(1).max(86_400).optional(),
    containment: punishmentTypeSchema.optional(),
    requiresDestructiveApproval: z.boolean().optional(),
    cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one rule field must be provided');

export const punishmentCreateSchema = z
  .object({
    incidentId: z.string().cuid().nullable().optional(),
    actorId: snowflakeSchema,
    type: punishmentTypeSchema,
    status: punishmentStatusSchema.default('PROPOSED'),
    idempotencyKey: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(3).max(1_000),
  })
  .strict();

export const punishmentUpdateSchema = z
  .object({
    status: punishmentStatusSchema,
    reason: z.string().trim().min(3).max(1_000).optional(),
    failedReason: z.string().trim().max(1_000).nullable().optional(),
    reversedBy: snowflakeSchema.nullable().optional(),
  })
  .strict();

export const botApprovalCreateSchema = z
  .object({
    botId: snowflakeSchema,
    approvedBy: snowflakeSchema,
    reason: z.string().trim().min(3).max(500),
    expiresAt: z.date().nullable().optional(),
  })
  .strict();

export const logChannelSetSchema = z
  .object({
    category: logCategorySchema,
    channelId: snowflakeSchema,
    enabled: z.boolean().default(true),
    updatedBy: snowflakeSchema.nullable().optional(),
  })
  .strict();

export type AntiNukeRuleSeedInput = z.input<typeof antiNukeRuleSeedSchema>;
export type AntiNukeRuleUpdateInput = z.input<typeof antiNukeRuleUpdateSchema>;
export type PunishmentCreateInput = z.input<typeof punishmentCreateSchema>;
export type PunishmentUpdateInput = z.input<typeof punishmentUpdateSchema>;
export type BotApprovalCreateInput = z.input<typeof botApprovalCreateSchema>;
export type LogChannelSetInput = z.input<typeof logChannelSetSchema>;

/**
 * Security policy and response persistence.
 *
 * Security events and incidents have their own repository; this repository owns
 * the editable rules, bot approvals, log routing, and the punishment ledger.
 */
export class SecurityRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async listRules(): Promise<AntiNukeRule[]> {
    return this.database.client.antiNukeRule.findMany({
      where: { guildId: this.guildId },
      orderBy: { action: 'asc' },
    });
  }

  /** Seeds missing rules without overwriting an owner's existing policy. */
  public async ensureRules(seeds: readonly AntiNukeRuleSeedInput[]): Promise<AntiNukeRule[]> {
    const parsed = seeds.map((seed) => antiNukeRuleSeedSchema.parse(seed));

    if (parsed.length === 0) {
      return this.listRules();
    }

    const result = await this.database.client.antiNukeRule.createMany({
      data: parsed.map((seed) => ({
        guildId: this.guildId,
        action: seed.action,
        enabled: seed.enabled,
        threshold: seed.threshold,
        windowSeconds: seed.windowSeconds,
        containment: seed.containment,
        requiresDestructiveApproval: seed.requiresDestructiveApproval,
        cooldownSeconds: seed.cooldownSeconds,
      })),
      skipDuplicates: true,
    });

    if (result.count > 0) {
      await this.database.transaction(async (transaction) => {
        await this.appendAudit(transaction, {
          action: AUDIT_ACTIONS.antiNukeRulesSeeded,
          targetType: 'AntiNukeRule',
          targetId: this.guildId,
          after: { seeded: result.count, actions: parsed.map((seed) => seed.action) },
        });
      });
    }

    return this.listRules();
  }

  public async updateRule(
    action: z.infer<typeof antiNukeActionSchema>,
    input: AntiNukeRuleUpdateInput,
    actorId?: string | null,
  ): Promise<AntiNukeRule> {
    const parsed = antiNukeRuleUpdateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.antiNukeRule.findUnique({
          where: { guildId_action: { guildId: this.guildId, action } },
        }),
        'Anti-Nuke rule',
        action,
      );

      const rule = await transaction.antiNukeRule.update({
        where: { guildId_action: { guildId: this.guildId, action } },
        data: {
          ...parsed,
          updatedBy: actorId ?? this.tenant.actorId ?? null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: actorId || this.tenant.actorId ? 'USER' : 'SYSTEM',
        actorId: actorId ?? this.tenant.actorId ?? null,
        action: AUDIT_ACTIONS.antiNukeRuleUpdated,
        targetType: 'AntiNukeRule',
        targetId: rule.id,
        before: ruleSnapshot(before),
        after: ruleSnapshot(rule),
      });

      return rule;
    });
  }

  /** Creates the punishment once per idempotency key, or returns the existing row. */
  public async createPunishment(
    input: PunishmentCreateInput,
  ): Promise<{ punishment: Punishment; created: boolean }> {
    const parsed = punishmentCreateSchema.parse(input);

    try {
      const punishment = await this.database.transaction(async (transaction) => {
        const created = await transaction.punishment.create({
          data: {
            guildId: this.guildId,
            incidentId: parsed.incidentId ?? null,
            actorId: parsed.actorId,
            type: parsed.type,
            status: parsed.status,
            idempotencyKey: parsed.idempotencyKey,
            reason: parsed.reason,
          },
        });

        await this.appendAudit(transaction, {
          action:
            parsed.status === 'SKIPPED'
              ? AUDIT_ACTIONS.punishmentSkipped
              : AUDIT_ACTIONS.punishmentProposed,
          targetType: 'Punishment',
          targetId: created.id,
          after: {
            incidentId: created.incidentId,
            actorId: created.actorId,
            type: created.type,
            status: created.status,
            idempotencyKey: created.idempotencyKey,
            reason: created.reason,
          },
        });

        return created;
      });

      return { punishment, created: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await this.database.client.punishment.findUnique({
        where: {
          guildId_idempotencyKey: {
            guildId: this.guildId,
            idempotencyKey: parsed.idempotencyKey,
          },
        },
      });

      if (existing === null) {
        throw error;
      }

      return { punishment: existing, created: false };
    }
  }

  public async updatePunishment(
    punishmentId: string,
    input: PunishmentUpdateInput,
    actorId?: string | null,
  ): Promise<Punishment | null> {
    const parsed = punishmentUpdateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.punishment.findFirst({
          where: { id: punishmentId, guildId: this.guildId },
        }),
        'punishment',
        punishmentId,
      );

      const punishment = await transaction.punishment.update({
        where: { id: punishmentId },
        data: {
          status: parsed.status,
          ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
          ...(parsed.failedReason === undefined ? {} : { failedReason: parsed.failedReason }),
          ...(parsed.reversedBy === undefined ? {} : { reversedBy: parsed.reversedBy }),
          appliedAt: parsed.status === 'APPLIED' ? new Date() : before.appliedAt,
          reversedAt: parsed.status === 'REVERSED' ? new Date() : before.reversedAt,
        },
      });

      await this.appendAudit(transaction, {
        actorType: actorId ? 'USER' : 'SYSTEM',
        actorId: actorId ?? null,
        action:
          parsed.status === 'APPLIED'
            ? AUDIT_ACTIONS.punishmentApplied
            : parsed.status === 'FAILED'
              ? AUDIT_ACTIONS.punishmentFailed
              : AUDIT_ACTIONS.punishmentProposed,
        targetType: 'Punishment',
        targetId: punishmentId,
        before: { status: before.status, failedReason: before.failedReason },
        after: {
          status: punishment.status,
          failedReason: punishment.failedReason,
          reversedBy: punishment.reversedBy,
        },
      });

      return punishment;
    });
  }

  public async listPunishments(
    options: {
      status?: 'PROPOSED' | 'SKIPPED' | 'APPLIED' | 'FAILED' | 'REVERSED';
      limit?: number;
    } = {},
  ): Promise<Punishment[]> {
    return this.database.client.punishment.findMany({
      where: {
        guildId: this.guildId,
        ...(options.status === undefined ? {} : { status: options.status }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });
  }

  public async approveBot(input: BotApprovalCreateInput): Promise<BotApproval> {
    const parsed = botApprovalCreateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const before = await transaction.botApproval.findUnique({
        where: { guildId_botId: { guildId: this.guildId, botId: parsed.botId } },
      });

      const approval = await transaction.botApproval.upsert({
        where: { guildId_botId: { guildId: this.guildId, botId: parsed.botId } },
        create: {
          guildId: this.guildId,
          botId: parsed.botId,
          approvedBy: parsed.approvedBy,
          reason: parsed.reason,
          expiresAt: parsed.expiresAt ?? null,
        },
        update: {
          approvedBy: parsed.approvedBy,
          reason: parsed.reason,
          expiresAt: parsed.expiresAt ?? null,
          revokedAt: null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId: parsed.approvedBy,
        action: AUDIT_ACTIONS.botApproved,
        targetType: 'BotApproval',
        targetId: approval.id,
        before: before === null ? null : { reason: before.reason, revokedAt: before.revokedAt },
        after: {
          botId: approval.botId,
          reason: approval.reason,
          expiresAt: approval.expiresAt?.toISOString() ?? null,
        },
      });

      return approval;
    });
  }

  public async revokeBot(botId: string, actorId: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.botApproval.findUnique({
          where: { guildId_botId: { guildId: this.guildId, botId } },
        }),
        'bot approval',
        botId,
      );

      if (before.revokedAt !== null) {
        return false;
      }

      const result = await transaction.botApproval.updateMany({
        where: { guildId: this.guildId, botId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      if (result.count !== 1) {
        return false;
      }

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId,
        action: AUDIT_ACTIONS.botApprovalRevoked,
        targetType: 'BotApproval',
        targetId: before.id,
        after: { botId, revokedAt: new Date().toISOString() },
      });

      return true;
    });
  }

  public async listBotApprovals(options: { activeOnly?: boolean } = {}): Promise<BotApproval[]> {
    const activeOnly = options.activeOnly ?? true;
    return this.database.client.botApproval.findMany({
      where: {
        guildId: this.guildId,
        ...(activeOnly
          ? {
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  public async isBotApproved(botId: string): Promise<boolean> {
    const approval = await this.database.client.botApproval.findFirst({
      where: {
        guildId: this.guildId,
        botId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });

    return approval !== null;
  }

  public async setLogChannel(input: LogChannelSetInput): Promise<LogChannel> {
    const parsed = logChannelSetSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const before = await transaction.logChannel.findUnique({
        where: { guildId_category: { guildId: this.guildId, category: parsed.category } },
      });

      const channel = await transaction.logChannel.upsert({
        where: { guildId_category: { guildId: this.guildId, category: parsed.category } },
        create: {
          guildId: this.guildId,
          category: parsed.category,
          channelId: parsed.channelId,
          enabled: parsed.enabled,
        },
        update: {
          channelId: parsed.channelId,
          enabled: parsed.enabled,
        },
      });

      await this.appendAudit(transaction, {
        actorType: parsed.updatedBy ? 'USER' : 'SYSTEM',
        actorId: parsed.updatedBy ?? null,
        action: AUDIT_ACTIONS.logChannelUpdated,
        targetType: 'LogChannel',
        targetId: channel.id,
        before: before === null ? null : { channelId: before.channelId, enabled: before.enabled },
        after: {
          category: channel.category,
          channelId: channel.channelId,
          enabled: channel.enabled,
        },
      });

      return channel;
    });
  }

  public async getLogChannel(
    category: z.infer<typeof logCategorySchema>,
  ): Promise<LogChannel | null> {
    return this.database.client.logChannel.findFirst({
      where: { guildId: this.guildId, category, enabled: true },
    });
  }

  public async listLogChannels(): Promise<LogChannel[]> {
    return this.database.client.logChannel.findMany({
      where: { guildId: this.guildId },
      orderBy: { category: 'asc' },
    });
  }
}

function ruleSnapshot(rule: AntiNukeRule): Record<string, unknown> {
  return {
    enabled: rule.enabled,
    threshold: rule.threshold,
    windowSeconds: rule.windowSeconds,
    containment: rule.containment,
    requiresDestructiveApproval: rule.requiresDestructiveApproval,
    cooldownSeconds: rule.cooldownSeconds,
  };
}
