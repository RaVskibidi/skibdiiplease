import { z } from 'zod';

import type { RestoreJob } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, toJsonInput, TenantRepository } from './base.ts';

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');

export const restoreSelectionSchema = z
  .object({
    categories: z
      .array(z.enum(['roles', 'channels', 'permissions', 'emojis', 'stickers', 'guildSettings']))
      .min(1)
      .max(6),
    roleIds: z.array(snowflakeSchema).max(500).optional(),
    channelIds: z.array(snowflakeSchema).max(500).optional(),
    /** Explicit opt-in for deleting resources that exist now but are absent from the backup. */
    deleteMissing: z.boolean().default(false),
  })
  .strict();

export type RestoreSelectionInput = z.input<typeof restoreSelectionSchema>;

export const restoreCreateSchema = z
  .object({
    backupId: z.string().trim().min(5).max(64),
    requestedBy: snowflakeSchema,
    confirmationId: z.string().trim().min(6).max(128),
    selection: restoreSelectionSchema,
  })
  .strict();

export type RestoreCreateInput = z.input<typeof restoreCreateSchema>;

/** Restore transaction tracking. One row per preview/execute request. */
export class RestoreRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async create(input: RestoreCreateInput): Promise<RestoreJob> {
    const parsed = restoreCreateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const backup = await transaction.backup.findFirst({
        where: { id: parsed.backupId, guildId: this.guildId },
      });
      this.assertRowOwnership(backup, 'backup', parsed.backupId);

      const job = await transaction.restoreJob.create({
        data: {
          guildId: this.guildId,
          backupId: parsed.backupId,
          requestedBy: parsed.requestedBy,
          confirmationId: parsed.confirmationId,
          selection: toJsonInput({
            ...parsed.selection,
            backupChecksum: backup?.checksum ?? null,
          }),
          status: 'PENDING',
        },
      });

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId: parsed.requestedBy,
        action: AUDIT_ACTIONS.backupRestoreRequested,
        targetType: 'RestoreJob',
        targetId: job.id,
        after: {
          backupId: parsed.backupId,
          selection: parsed.selection,
        },
      });

      return job;
    });
  }

  public async getById(jobId: string): Promise<RestoreJob | null> {
    return this.database.client.restoreJob.findFirst({
      where: { id: jobId, guildId: this.guildId },
    });
  }

  public async list(limit = 25): Promise<RestoreJob[]> {
    return this.database.client.restoreJob.findMany({
      where: { guildId: this.guildId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  public async markPreviewed(jobId: string, actorId: string): Promise<boolean> {
    return this.transition(
      jobId,
      ['PENDING'],
      'PREVIEWED',
      actorId,
      AUDIT_ACTIONS.backupRestorePreviewed,
    );
  }

  /**
   * Binds a human-readable confirmation token to a previewed job.
   * Execution is refused until this succeeds.
   */
  public async attachConfirmation(
    jobId: string,
    confirmationId: string,
    actorId: string,
  ): Promise<boolean> {
    const token = confirmationId.trim();
    if (token.length < 6 || token.length > 128) {
      return false;
    }

    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.restoreJob.findFirst({ where: { id: jobId, guildId: this.guildId } }),
        'restore job',
        jobId,
      );

      if (before.status !== 'PREVIEWED' && before.status !== 'PENDING') {
        return false;
      }

      const result = await transaction.restoreJob.updateMany({
        where: { id: jobId, guildId: this.guildId },
        data: { status: 'PREVIEWED', confirmationId: token },
      });

      if (result.count !== 1) {
        return false;
      }

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId,
        action: AUDIT_ACTIONS.backupRestorePreviewed,
        targetType: 'RestoreJob',
        targetId: jobId,
        after: { confirmationId: token },
      });

      return true;
    });
  }

  public async markRunning(jobId: string, actorId: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.restoreJob.findFirst({ where: { id: jobId, guildId: this.guildId } }),
        'restore job',
        jobId,
      );

      if (before.status !== 'PREVIEWED' && before.status !== 'PENDING') {
        return false;
      }

      const result = await transaction.restoreJob.updateMany({
        where: { id: jobId, guildId: this.guildId, status: before.status },
        data: { status: 'RUNNING', startedAt: new Date(), progress: 0 },
      });

      if (result.count !== 1) {
        return false;
      }

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId,
        action: AUDIT_ACTIONS.backupRestoreRequested,
        targetType: 'RestoreJob',
        targetId: jobId,
        before: { status: before.status },
        after: { status: 'RUNNING' },
      });

      return true;
    });
  }

  public async updateProgress(jobId: string, progress: number): Promise<boolean> {
    const bounded = Math.min(Math.max(Math.trunc(progress), 0), 100);
    const result = await this.database.client.restoreJob.updateMany({
      where: { id: jobId, guildId: this.guildId, status: 'RUNNING' },
      data: { progress: bounded },
    });
    return result.count === 1;
  }

  public async complete(
    jobId: string,
    actorId: string,
    errors: readonly unknown[] = [],
  ): Promise<boolean> {
    return this.finish(jobId, actorId, 'COMPLETED', errors, AUDIT_ACTIONS.backupRestoreCompleted);
  }

  public async fail(
    jobId: string,
    actorId: string,
    errors: readonly unknown[] = [],
  ): Promise<boolean> {
    return this.finish(jobId, actorId, 'FAILED', errors, AUDIT_ACTIONS.backupRestoreFailed);
  }

  public async cancel(jobId: string, actorId: string): Promise<boolean> {
    return this.finish(jobId, actorId, 'CANCELLED', [], AUDIT_ACTIONS.backupRestoreCancelled);
  }

  private async finish(
    jobId: string,
    actorId: string,
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED',
    errors: readonly unknown[],
    action: string,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.restoreJob.findFirst({ where: { id: jobId, guildId: this.guildId } }),
        'restore job',
        jobId,
      );

      if (
        before.status === 'COMPLETED' ||
        before.status === 'FAILED' ||
        before.status === 'CANCELLED'
      ) {
        return false;
      }

      const result = await transaction.restoreJob.updateMany({
        where: { id: jobId, guildId: this.guildId },
        data: {
          status,
          completedAt: new Date(),
          progress: status === 'COMPLETED' ? 100 : before.progress,
          errors: errors.length === 0 ? undefined : toJsonInput(errors.slice(0, 100)),
        },
      });

      if (result.count !== 1) {
        return false;
      }

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId,
        action,
        targetType: 'RestoreJob',
        targetId: jobId,
        before: { status: before.status, progress: before.progress },
        after: { status, errorCount: errors.length },
      });

      return true;
    });
  }

  private async transition(
    jobId: string,
    from: RestoreJob['status'][],
    to: RestoreJob['status'],
    actorId: string,
    action: string,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.restoreJob.findFirst({ where: { id: jobId, guildId: this.guildId } }),
        'restore job',
        jobId,
      );

      if (!from.includes(before.status)) {
        return false;
      }

      const result = await transaction.restoreJob.updateMany({
        where: { id: jobId, guildId: this.guildId, status: before.status },
        data: { status: to },
      });

      if (result.count !== 1) {
        return false;
      }

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId,
        action,
        targetType: 'RestoreJob',
        targetId: jobId,
        before: { status: before.status },
        after: { status: to },
      });

      return true;
    });
  }
}
