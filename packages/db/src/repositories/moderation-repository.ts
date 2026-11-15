import { z } from 'zod';

import type { ModerationCase, Prisma, Warning } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import { TenantRecordNotFoundError } from '../errors.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, toJsonInput, TenantRepository } from './base.ts';

const snowflake = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');

export const moderationCaseSchema = z
  .object({
    type: z.enum([
      'BAN',
      'KICK',
      'TIMEOUT',
      'UNTIMEOUT',
      'WARN',
      'UNWARN',
      'UNBAN',
      'PURGE',
      'LOCK',
      'UNLOCK',
      'SLOWMODE',
      'SOFTBAN',
    ]),
    targetId: snowflake,
    moderatorId: snowflake,
    reason: z.string().trim().min(3).max(1_000),
    durationSeconds: z.number().int().min(0).max(2_419_200).nullable().optional(),
    source: z.string().trim().min(1).max(32).default('discord'),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const warningCreateSchema = z
  .object({
    targetId: snowflake,
    moderatorId: snowflake,
    reason: z.string().trim().min(3).max(1_000),
    source: z.string().trim().min(1).max(32).default('discord'),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ModerationCaseInput = z.input<typeof moderationCaseSchema>;
export type WarningCreateInput = z.input<typeof warningCreateSchema>;

export interface ModerationCasePage {
  cases: ModerationCase[];
  nextCursor: string | null;
}

export interface WarningSummary {
  total: number;
  active: number;
}

/**
 * Moderation cases use a per-guild, gap-free sequence.
 *
 * The guild row is locked with SELECT ... FOR UPDATE inside the same transaction
 * that increments `caseSequence` and inserts the case, so concurrent moderators
 * cannot receive the same case number.
 */
export class ModerationRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async create(input: ModerationCaseInput): Promise<ModerationCase> {
    const parsed = moderationCaseSchema.parse(input);

    return this.database.transaction((transaction) =>
      this.createInTransaction(transaction, parsed),
    );
  }

  /** Creates a WARN case and its linked active warning atomically. */
  public async warn(
    input: WarningCreateInput,
  ): Promise<{ case: ModerationCase; warning: Warning }> {
    const parsed = warningCreateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const moderationCase = await this.createInTransaction(transaction, {
        type: 'WARN',
        targetId: parsed.targetId,
        moderatorId: parsed.moderatorId,
        reason: parsed.reason,
        durationSeconds: null,
        source: parsed.source,
        metadata: parsed.metadata,
      });

      const warning = await transaction.warning.create({
        data: {
          guildId: this.guildId,
          caseId: moderationCase.id,
          targetId: parsed.targetId,
          moderatorId: parsed.moderatorId,
          reason: parsed.reason,
        },
      });

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId: parsed.moderatorId,
        action: AUDIT_ACTIONS.warningCreated,
        targetType: 'Warning',
        targetId: warning.id,
        after: {
          caseId: moderationCase.id,
          caseNumber: moderationCase.number,
          targetId: warning.targetId,
          reason: warning.reason,
        },
      });

      return { case: moderationCase, warning };
    });
  }

  public async findByNumber(number: number): Promise<ModerationCase | null> {
    return this.database.client.moderationCase.findFirst({
      where: { guildId: this.guildId, number },
    });
  }

  public async getById(id: string): Promise<ModerationCase | null> {
    return this.database.client.moderationCase.findFirst({
      where: { id, guildId: this.guildId },
    });
  }

  public async list(
    options: {
      targetId?: string;
      moderatorId?: string;
      type?: ModerationCase['type'];
      status?: ModerationCase['status'];
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<ModerationCasePage> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    const cases = await this.database.client.moderationCase.findMany({
      where: {
        guildId: this.guildId,
        ...(options.targetId === undefined ? {} : { targetId: options.targetId }),
        ...(options.moderatorId === undefined ? {} : { moderatorId: options.moderatorId }),
        ...(options.type === undefined ? {} : { type: options.type }),
        ...(options.status === undefined ? {} : { status: options.status }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
    });

    const hasMore = cases.length > limit;
    const page = hasMore ? cases.slice(0, limit) : cases;

    return { cases: page, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  public async close(
    caseId: string,
    actorId: string,
    status: 'CLOSED' | 'REVERSED' = 'CLOSED',
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.moderationCase.findFirst({
          where: { id: caseId, guildId: this.guildId },
        }),
        'moderation case',
        caseId,
      );

      const result = await transaction.moderationCase.updateMany({
        where: { id: caseId, guildId: this.guildId, status: 'OPEN' },
        data: { status, closedAt: new Date() },
      });

      if (result.count !== 1) {
        return false;
      }

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId,
        action: AUDIT_ACTIONS.moderationCaseClosed,
        targetType: 'ModerationCase',
        targetId: caseId,
        before: { status: before.status },
        after: { status },
      });

      return true;
    });
  }

  public async listWarnings(
    targetId: string,
    options: { activeOnly?: boolean; limit?: number } = {},
  ): Promise<Warning[]> {
    return this.database.client.warning.findMany({
      where: {
        guildId: this.guildId,
        targetId,
        ...((options.activeOnly ?? true) ? { active: true } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });
  }

  public async warningSummary(targetId: string): Promise<WarningSummary> {
    const [total, active] = await Promise.all([
      this.database.client.warning.count({ where: { guildId: this.guildId, targetId } }),
      this.database.client.warning.count({
        where: { guildId: this.guildId, targetId, active: true },
      }),
    ]);
    return { total, active };
  }

  /** Revokes a warning and records the reversal as a moderation case. */
  public async revokeWarning(
    warningId: string,
    moderatorId: string,
    reason: string,
  ): Promise<{ warning: Warning; case: ModerationCase } | null> {
    return this.database.transaction(async (transaction) => {
      const warning = await transaction.warning.findFirst({
        where: { id: warningId, guildId: this.guildId },
      });
      if (warning === null) {
        return null;
      }
      this.assertRowOwnership(warning, 'warning', warningId);

      if (!warning.active) {
        return null;
      }

      const updated = await transaction.warning.update({
        where: { id: warningId },
        data: { active: false, revokedAt: new Date(), revokedBy: moderatorId },
      });

      const moderationCase = await this.createInTransaction(transaction, {
        type: 'UNWARN',
        targetId: warning.targetId,
        moderatorId,
        reason,
        durationSeconds: null,
        source: 'discord',
        metadata: { warningId, originalCaseId: warning.caseId },
      });

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId: moderatorId,
        action: AUDIT_ACTIONS.warningRevoked,
        targetType: 'Warning',
        targetId: warningId,
        before: { active: true },
        after: { active: false, reason, caseId: moderationCase.id },
      });

      return { warning: updated, case: moderationCase };
    });
  }

  private async createInTransaction(
    transaction: Prisma.TransactionClient,
    parsed: z.output<typeof moderationCaseSchema>,
  ): Promise<ModerationCase> {
    const rows = await transaction.$queryRaw<Array<{ caseSequence: number }>>`
      SELECT "caseSequence" FROM "guilds" WHERE "id" = ${this.guildId} FOR UPDATE
    `;

    const current = rows[0];
    if (current === undefined) {
      throw new TenantRecordNotFoundError('guild', this.guildId);
    }

    const number = current.caseSequence + 1;

    await transaction.guild.update({
      where: { id: this.guildId },
      data: { caseSequence: number },
    });

    const durationSeconds = parsed.durationSeconds ?? null;
    const expiresAt =
      durationSeconds !== null && durationSeconds > 0
        ? new Date(Date.now() + durationSeconds * 1_000)
        : null;

    const moderationCase = await transaction.moderationCase.create({
      data: {
        guildId: this.guildId,
        number,
        type: parsed.type,
        targetId: parsed.targetId,
        moderatorId: parsed.moderatorId,
        reason: parsed.reason,
        durationSeconds,
        expiresAt,
        status: 'OPEN',
        source: parsed.source,
        metadata: toJsonInput(parsed.metadata),
      },
    });

    await this.appendAudit(transaction, {
      actorType: 'USER',
      actorId: parsed.moderatorId,
      action: AUDIT_ACTIONS.moderationCaseCreated,
      targetType: 'ModerationCase',
      targetId: moderationCase.id,
      after: {
        number: moderationCase.number,
        type: moderationCase.type,
        targetId: moderationCase.targetId,
        reason: moderationCase.reason,
        durationSeconds: moderationCase.durationSeconds,
      },
    });

    return moderationCase;
  }
}
