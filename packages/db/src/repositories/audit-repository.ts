import type { AuditEntry, Prisma } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { toJsonInput, TenantRepository, type AuditWriteInput } from './base.ts';

export interface AuditListOptions {
  limit?: number;
  cursor?: string;
  action?: string;
  actorId?: string;
  since?: Date;
  before?: Date;
}

export interface AuditListResult {
  entries: AuditEntry[];
  nextCursor: string | null;
}

/**
 * Append-only security audit trail.
 *
 * There is deliberately no update or delete method. PostgreSQL triggers block
 * UPDATE/DELETE/TRUNCATE on `audit_entries` as defense in depth.
 */
export class AuditRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async append(entry: AuditWriteInput): Promise<AuditEntry> {
    return this.database.transaction(async (transaction) => {
      return transaction.auditEntry.create({
        data: {
          guildId: this.guildId,
          actorType: entry.actorType ?? 'SYSTEM',
          actorId: entry.actorId ?? null,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          before: toJsonInput(entry.before),
          after: toJsonInput(entry.after),
          diff: toJsonInput(entry.diff),
          requestId: entry.requestId ?? this.tenant.requestId ?? null,
          ipHash: entry.ipHash ?? null,
          userAgent: entry.userAgent ?? null,
          confirmationId: entry.confirmationId ?? null,
        },
      });
    });
  }

  public async list(options: AuditListOptions = {}): Promise<AuditListResult> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    const where: Prisma.AuditEntryWhereInput = {
      guildId: this.guildId,
      ...(options.action === undefined ? {} : { action: options.action }),
      ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
      ...(options.since === undefined && options.before === undefined
        ? {}
        : {
            createdAt: {
              ...(options.since === undefined ? {} : { gte: options.since }),
              ...(options.before === undefined ? {} : { lt: options.before }),
            },
          }),
    };

    const entries = await this.database.client.auditEntry.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
    });

    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;

    return {
      entries: page,
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }

  public async count(action?: string): Promise<number> {
    return this.database.client.auditEntry.count({
      where: {
        guildId: this.guildId,
        ...(action === undefined ? {} : { action }),
      },
    });
  }
}
