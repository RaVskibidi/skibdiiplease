import { z } from 'zod';

import type { Backup } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, TenantRepository } from './base.ts';

export const backupCreateSchema = z
  .object({
    type: z.enum(['MANUAL', 'SCHEDULED', 'PRE_RESTORE']),
    createdBy: z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake'),
    retentionUntil: z.date().nullable().optional(),
  })
  .strict();

export type BackupCreateInput = z.input<typeof backupCreateSchema>;

/** Backup metadata. Snapshot bytes live in object storage, never in PostgreSQL. */
export class BackupRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async create(input: BackupCreateInput): Promise<Backup> {
    const parsed = backupCreateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const backup = await transaction.backup.create({
        data: {
          guildId: this.guildId,
          type: parsed.type,
          createdBy: parsed.createdBy,
          retentionUntil: parsed.retentionUntil ?? null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId: parsed.createdBy,
        action: AUDIT_ACTIONS.backupCreated,
        targetType: 'Backup',
        targetId: backup.id,
        after: { type: backup.type, status: backup.status },
      });

      return backup;
    });
  }

  public async list(limit = 50): Promise<Backup[]> {
    return this.database.client.backup.findMany({
      where: { guildId: this.guildId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  public async markReady(
    backupId: string,
    details: {
      objectKey: string;
      checksum: string;
      sizeBytes: bigint;
      schemaVersion?: number;
    },
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      this.assertRowOwnership(
        await transaction.backup.findFirst({ where: { id: backupId, guildId: this.guildId } }),
        'backup',
        backupId,
      );

      const result = await transaction.backup.updateMany({
        where: { id: backupId, guildId: this.guildId },
        data: {
          status: 'READY',
          objectKey: details.objectKey,
          checksum: details.checksum,
          sizeBytes: details.sizeBytes,
          schemaVersion: details.schemaVersion ?? 1,
          completedAt: new Date(),
        },
      });

      if (result.count !== 1) {
        return false;
      }

      await this.appendAudit(transaction, {
        action: AUDIT_ACTIONS.backupUpdated,
        targetType: 'Backup',
        targetId: backupId,
        after: { status: 'READY', sizeBytes: details.sizeBytes.toString() },
      });

      return true;
    });
  }

  public async markFailed(backupId: string, error: string): Promise<boolean> {
    const result = await this.database.client.backup.updateMany({
      where: { id: backupId, guildId: this.guildId },
      data: { status: 'FAILED', error, completedAt: new Date() },
    });

    return result.count === 1;
  }

  public async getById(backupId: string): Promise<Backup | null> {
    return this.database.client.backup.findFirst({
      where: { id: backupId, guildId: this.guildId },
    });
  }

  public async findReady(backupId: string): Promise<Backup | null> {
    return this.database.client.backup.findFirst({
      where: { id: backupId, guildId: this.guildId, status: 'READY' },
    });
  }

  public async markCapturing(backupId: string): Promise<boolean> {
    const result = await this.database.client.backup.updateMany({
      where: { id: backupId, guildId: this.guildId, status: 'PENDING' },
      data: { status: 'CAPTURING' },
    });
    return result.count === 1;
  }

  /** Soft-deletes expired or manually removed backups and records the audit trail. */
  public async markDeleted(
    backupId: string,
    actorId: string | null,
    reason: string,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.backup.findFirst({ where: { id: backupId, guildId: this.guildId } }),
        'backup',
        backupId,
      );

      if (before.status === 'DELETED') {
        return false;
      }

      const result = await transaction.backup.updateMany({
        where: { id: backupId, guildId: this.guildId },
        data: { status: 'DELETED', completedAt: new Date() },
      });

      if (result.count !== 1) {
        return false;
      }

      await this.appendAudit(transaction, {
        actorType: actorId === null ? 'SYSTEM' : 'USER',
        actorId,
        action: AUDIT_ACTIONS.backupDeleted,
        targetType: 'Backup',
        targetId: backupId,
        before: { status: before.status, objectKey: before.objectKey },
        after: { status: 'DELETED', reason },
      });

      return true;
    });
  }

  /** Backups whose retention date has passed and that still have stored bytes. */
  public async listExpired(limit = 50): Promise<Backup[]> {
    return this.database.client.backup.findMany({
      where: {
        guildId: this.guildId,
        status: { in: ['READY', 'FAILED'] },
        retentionUntil: { not: null, lte: new Date() },
      },
      orderBy: [{ retentionUntil: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  public async listReadyWithObject(limit = 50): Promise<Backup[]> {
    return this.database.client.backup.findMany({
      where: { guildId: this.guildId, status: 'READY', objectKey: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 500),
    });
  }
}
