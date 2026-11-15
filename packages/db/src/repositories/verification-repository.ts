import { z } from 'zod';

import type { VerificationChallenge, VerificationConfig } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import { TenantRecordNotFoundError } from '../errors.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, TenantRepository } from './base.ts';

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');
const verificationModeSchema = z.enum(['BUTTON', 'CAPTCHA']);

/** Dashboard-ready verification configuration with strict validation. */
export const verificationConfigUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: verificationModeSchema.optional(),
    buttonFallbackEnabled: z.boolean().optional(),
    unverifiedRoleId: snowflakeSchema.nullable().optional(),
    verifiedRoleId: snowflakeSchema.nullable().optional(),
    channelId: snowflakeSchema.nullable().optional(),
    challengeLength: z.number().int().min(4).max(10).optional(),
    timeoutSeconds: z.number().int().min(60).max(3_600).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    captchaNoise: z.number().int().min(0).max(12).optional(),
    releaseQuarantineOnPass: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'at least one verification field must be provided',
  );

export type VerificationConfigUpdateInput = z.input<typeof verificationConfigUpdateSchema>;

export const verificationChallengeCreateSchema = z
  .object({
    userId: snowflakeSchema,
    mode: verificationModeSchema,
    /** Salted scrypt hash; plaintext answers are never accepted here. */
    answerHash: z.string().trim().min(1).max(200),
    maxAttempts: z.number().int().min(1).max(10),
    expiresAt: z.date(),
    channelId: snowflakeSchema.nullable().optional(),
    messageId: snowflakeSchema.nullable().optional(),
  })
  .strict();

export type VerificationChallengeCreateInput = z.input<typeof verificationChallengeCreateSchema>;

export interface VerificationAttemptUpdate {
  readonly challengeId: string;
  readonly attempts: number;
  readonly status: 'PENDING' | 'FAILED';
  readonly failureReason: string | null;
  readonly attemptedAt: Date;
}

/**
 * Verification configuration and challenge lifecycle persistence.
 *
 * Only a salted hash of a CAPTCHA answer is ever stored. Every terminal state is
 * recorded with a timestamp and an audit entry so verification incidents can be
 * reconstructed without retaining message content.
 */
export class VerificationRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async getOrCreate(): Promise<VerificationConfig> {
    return this.database.client.verificationConfig.upsert({
      where: { guildId: this.guildId },
      create: { guildId: this.guildId },
      update: {},
    });
  }

  public async update(
    input: VerificationConfigUpdateInput,
    actorId?: string | null,
  ): Promise<VerificationConfig> {
    const parsed = verificationConfigUpdateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      await this.getOrCreate();

      const before = this.assertRowOwnership(
        await transaction.verificationConfig.findUnique({ where: { guildId: this.guildId } }),
        'verification config',
        this.guildId,
      );

      const config = await transaction.verificationConfig.update({
        where: { guildId: this.guildId },
        data: {
          ...parsed,
          updatedBy: actorId ?? this.tenant.actorId ?? null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: actorId ? 'USER' : 'SYSTEM',
        actorId: actorId ?? null,
        action: AUDIT_ACTIONS.verificationConfigUpdated,
        targetType: 'VerificationConfig',
        targetId: this.guildId,
        before: verificationSnapshot(before),
        after: verificationSnapshot(config),
      });

      return config;
    });
  }

  /**
   * Issues a fresh challenge, invalidating any previous pending challenge for
   * the same member so only the newest code can ever pass.
   */
  public async createChallenge(
    input: VerificationChallengeCreateInput,
  ): Promise<VerificationChallenge> {
    const parsed = verificationChallengeCreateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const stale = await transaction.verificationChallenge.findMany({
        where: { guildId: this.guildId, userId: parsed.userId, status: 'PENDING' },
        select: { id: true },
      });

      if (stale.length > 0) {
        await transaction.verificationChallenge.updateMany({
          where: { id: { in: stale.map((entry) => entry.id) } },
          data: {
            status: 'INVALIDATED',
            failureReason: 'superseded by a newer challenge',
            completedAt: new Date(),
          },
        });
      }

      const challenge = await transaction.verificationChallenge.create({
        data: {
          guildId: this.guildId,
          userId: parsed.userId,
          mode: parsed.mode,
          answerHash: parsed.answerHash,
          maxAttempts: parsed.maxAttempts,
          expiresAt: parsed.expiresAt,
          channelId: parsed.channelId ?? null,
          messageId: parsed.messageId ?? null,
        },
      });

      await this.appendAudit(transaction, {
        action: AUDIT_ACTIONS.verificationChallengeIssued,
        targetType: 'VerificationChallenge',
        targetId: challenge.id,
        after: {
          userId: challenge.userId,
          mode: challenge.mode,
          maxAttempts: challenge.maxAttempts,
          expiresAt: challenge.expiresAt.toISOString(),
        },
      });

      return challenge;
    });
  }

  /** Attaches the Discord message that renders the challenge. */
  public async attachMessage(input: {
    readonly challengeId: string;
    readonly channelId: string;
    readonly messageId: string;
  }): Promise<VerificationChallenge> {
    const challenge = this.assertRowOwnership(
      await this.database.client.verificationChallenge.findFirst({
        where: { id: input.challengeId, guildId: this.guildId },
      }),
      'verification challenge',
      input.challengeId,
    );

    return this.database.client.verificationChallenge.update({
      where: { id: challenge.id },
      data: { channelId: input.channelId, messageId: input.messageId },
    });
  }

  /** Persists a wrong attempt, terminal or not, with an audit trail marker. */
  public async recordFailedAttempt(
    update: VerificationAttemptUpdate,
  ): Promise<VerificationChallenge> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.verificationChallenge.findFirst({
          where: { id: update.challengeId, guildId: this.guildId },
        }),
        'verification challenge',
        update.challengeId,
      );

      if (before.status !== 'PENDING') {
        return before;
      }

      const challenge = await transaction.verificationChallenge.update({
        where: { id: before.id },
        data: {
          attempts: update.attempts,
          status: update.status,
          failureReason: update.failureReason,
          lastAttemptAt: update.attemptedAt,
          completedAt: update.status === 'FAILED' ? update.attemptedAt : before.completedAt,
        },
      });

      await this.appendAudit(transaction, {
        action: AUDIT_ACTIONS.verificationChallengeFailed,
        targetType: 'VerificationChallenge',
        targetId: challenge.id,
        after: {
          userId: challenge.userId,
          attempts: challenge.attempts,
          maxAttempts: challenge.maxAttempts,
          status: challenge.status,
          failureReason: challenge.failureReason,
        },
      });

      return challenge;
    });
  }

  public async markPassed(
    challengeId: string,
    completedAt: Date = new Date(),
  ): Promise<VerificationChallenge> {
    return this.#resolve(challengeId, {
      status: 'PASSED',
      completedAt,
      action: AUDIT_ACTIONS.verificationChallengePassed,
    });
  }

  public async markExpired(
    challengeId: string,
    completedAt: Date = new Date(),
  ): Promise<VerificationChallenge> {
    return this.#resolve(challengeId, {
      status: 'EXPIRED',
      completedAt,
      failureReason: 'challenge timed out',
      action: AUDIT_ACTIONS.verificationChallengeExpired,
    });
  }

  public async invalidate(
    challengeId: string,
    reason: string,
    completedAt: Date = new Date(),
  ): Promise<VerificationChallenge> {
    return this.#resolve(challengeId, {
      status: 'INVALIDATED',
      completedAt,
      failureReason: reason,
      action: AUDIT_ACTIONS.verificationChallengeInvalidated,
    });
  }

  public async findPendingForUser(userId: string): Promise<VerificationChallenge | null> {
    return this.database.client.verificationChallenge.findFirst({
      where: { guildId: this.guildId, userId, status: 'PENDING' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  public async findById(challengeId: string): Promise<VerificationChallenge | null> {
    return this.database.client.verificationChallenge.findFirst({
      where: { id: challengeId, guildId: this.guildId },
    });
  }

  /** Pending challenges whose deadline has passed; used by the expiry sweeper. */
  public async listExpired(now: Date = new Date(), limit = 100): Promise<VerificationChallenge[]> {
    return this.database.client.verificationChallenge.findMany({
      where: { guildId: this.guildId, status: 'PENDING', expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  public async listRecent(limit = 25): Promise<VerificationChallenge[]> {
    return this.database.client.verificationChallenge.findMany({
      where: { guildId: this.guildId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  public async countByStatus(status: VerificationChallenge['status']): Promise<number> {
    return this.database.client.verificationChallenge.count({
      where: { guildId: this.guildId, status },
    });
  }

  async #resolve(
    challengeId: string,
    input: {
      status: 'PASSED' | 'EXPIRED' | 'INVALIDATED';
      completedAt: Date;
      failureReason?: string;
      action: string;
    },
  ): Promise<VerificationChallenge> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.verificationChallenge.findFirst({
          where: { id: challengeId, guildId: this.guildId },
        }),
        'verification challenge',
        challengeId,
      );

      if (before.status !== 'PENDING') {
        return before;
      }

      const challenge = await transaction.verificationChallenge.update({
        where: { id: before.id },
        data: {
          status: input.status,
          completedAt: input.completedAt,
          failureReason: input.failureReason ?? before.failureReason,
        },
      });

      await this.appendAudit(transaction, {
        action: input.action,
        targetType: 'VerificationChallenge',
        targetId: challenge.id,
        before: { status: before.status },
        after: { status: challenge.status, failureReason: challenge.failureReason },
      });

      return challenge;
    });
  }
}

/** Reads a challenge and asserts tenant ownership for callers outside the repo. */
export function assertVerificationChallenge(
  challenge: VerificationChallenge | null,
  challengeId: string,
): VerificationChallenge {
  if (challenge === null) {
    throw new TenantRecordNotFoundError('verification challenge', challengeId);
  }
  return challenge;
}

function verificationSnapshot(config: VerificationConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    mode: config.mode,
    buttonFallbackEnabled: config.buttonFallbackEnabled,
    unverifiedRoleId: config.unverifiedRoleId,
    verifiedRoleId: config.verifiedRoleId,
    channelId: config.channelId,
    challengeLength: config.challengeLength,
    timeoutSeconds: config.timeoutSeconds,
    maxAttempts: config.maxAttempts,
    captchaNoise: config.captchaNoise,
    releaseQuarantineOnPass: config.releaseQuarantineOnPass,
  };
}
