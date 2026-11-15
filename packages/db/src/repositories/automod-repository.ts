import { z } from 'zod';

import type { AutomodConfig } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, TenantRepository } from './base.ts';

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');

const automodRuleSchema = z.enum([
  'FLOOD',
  'DUPLICATE',
  'MENTION_SPAM',
  'EXCESSIVE_CAPS',
  'INVITE_LINK',
  'BLOCKED_LINK',
  'BLOCKED_WORD',
  'EVERYONE_MENTION',
]);

const snowflakeListSchema = z.array(snowflakeSchema).max(100);
const textListSchema = z.array(z.string().trim().min(1).max(100)).max(100);

/**
 * Dashboard-ready AutoMod configuration. Strict by design: a dashboard field
 * typo fails validation instead of silently persisting a useless setting.
 */
export const automodConfigUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    floodMessages: z.number().int().min(2).max(100).optional(),
    floodWindowSeconds: z.number().int().min(3).max(300).optional(),
    duplicateWindowSeconds: z.number().int().min(10).max(3_600).optional(),
    duplicateThreshold: z.number().int().min(2).max(20).optional(),
    mentionLimit: z.number().int().min(2).max(50).optional(),
    capsPercentage: z.number().int().min(50).max(100).optional(),
    capsMinimumLength: z.number().int().min(5).max(200).optional(),
    inviteLinksBlocked: z.boolean().optional(),
    linkFilterEnabled: z.boolean().optional(),
    bannedWords: textListSchema.optional(),
    blockedDomains: textListSchema.optional(),
    exemptChannelIds: snowflakeListSchema.optional(),
    exemptRoleIds: snowflakeListSchema.optional(),
    exemptUserIds: snowflakeListSchema.optional(),
    ignoreStaff: z.boolean().optional(),
    warnEnabled: z.boolean().optional(),
    timeoutEnabled: z.boolean().optional(),
    timeoutAfterWarnings: z.number().int().min(1).max(10).optional(),
    deleteOffendingMessage: z.boolean().optional(),
    /**
     * Explicit owner opt-in for rules that may act on a single message.
     * Empty by default, which keeps first-message timeouts impossible.
     */
    highConfidenceRules: z.array(automodRuleSchema).max(8).optional(),
    timeoutSeconds: z.number().int().min(60).max(2_419_200).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one AutoMod field must be provided');

export type AutomodConfigUpdateInput = z.input<typeof automodConfigUpdateSchema>;

/**
 * AutoMod policy persistence.
 *
 * The repository never reads Discord messages or applies punishments. It only
 * stores the guild's policy so the pure engine and the bot adapter stay testable
 * and the dashboard has one validated source of truth.
 */
export class AutomodRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async getOrCreate(): Promise<AutomodConfig> {
    return this.database.client.automodConfig.upsert({
      where: { guildId: this.guildId },
      create: { guildId: this.guildId },
      update: {},
    });
  }

  public async update(
    input: AutomodConfigUpdateInput,
    actorId?: string | null,
  ): Promise<AutomodConfig> {
    const parsed = automodConfigUpdateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      await this.getOrCreate();

      const before = this.assertRowOwnership(
        await transaction.automodConfig.findUnique({ where: { guildId: this.guildId } }),
        'AutoMod config',
        this.guildId,
      );

      const config = await transaction.automodConfig.update({
        where: { guildId: this.guildId },
        data: {
          ...parsed,
          updatedBy: actorId ?? this.tenant.actorId ?? null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: actorId ? 'USER' : 'SYSTEM',
        actorId: actorId ?? null,
        action: AUDIT_ACTIONS.automodConfigUpdated,
        targetType: 'AutomodConfig',
        targetId: this.guildId,
        before: automodSnapshot(before),
        after: automodSnapshot(config),
      });

      return config;
    });
  }
}

function automodSnapshot(config: AutomodConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    floodMessages: config.floodMessages,
    floodWindowSeconds: config.floodWindowSeconds,
    duplicateWindowSeconds: config.duplicateWindowSeconds,
    duplicateThreshold: config.duplicateThreshold,
    mentionLimit: config.mentionLimit,
    capsPercentage: config.capsPercentage,
    capsMinimumLength: config.capsMinimumLength,
    inviteLinksBlocked: config.inviteLinksBlocked,
    linkFilterEnabled: config.linkFilterEnabled,
    bannedWordCount: config.bannedWords.length,
    blockedDomainCount: config.blockedDomains.length,
    exemptChannelCount: config.exemptChannelIds.length,
    exemptRoleCount: config.exemptRoleIds.length,
    exemptUserCount: config.exemptUserIds.length,
    ignoreStaff: config.ignoreStaff,
    warnEnabled: config.warnEnabled,
    timeoutEnabled: config.timeoutEnabled,
    timeoutAfterWarnings: config.timeoutAfterWarnings,
    deleteOffendingMessage: config.deleteOffendingMessage,
    highConfidenceRules: config.highConfidenceRules,
    timeoutSeconds: config.timeoutSeconds,
  };
}
