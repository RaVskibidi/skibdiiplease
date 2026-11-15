import { z } from 'zod';

import type { DashboardAction } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, toJsonInput, TenantRepository } from './base.ts';

export const dashboardActionCreateSchema = z
  .object({
    type: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9.-]{2,63}$/u, 'must be a dotted lowercase action name'),
    actorId: z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake'),
    payload: z.record(z.string(), z.unknown()).default({}),
    confirmationId: z.string().trim().min(6).max(128).optional(),
  })
  .strict();

export type DashboardActionCreateInput = z.input<typeof dashboardActionCreateSchema>;

/** Queue for Discord work requested by the dashboard. The API never executes it. */
export class DashboardActionRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async create(input: DashboardActionCreateInput): Promise<DashboardAction> {
    const parsed = dashboardActionCreateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const action = await transaction.dashboardAction.create({
        data: {
          guildId: this.guildId,
          actorId: parsed.actorId,
          type: parsed.type,
          payload: toJsonInput(parsed.payload),
          confirmationId: parsed.confirmationId ?? null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId: parsed.actorId,
        action: AUDIT_ACTIONS.dashboardActionRequested,
        targetType: 'DashboardAction',
        targetId: action.id,
        after: { type: action.type, confirmationId: action.confirmationId },
      });

      return action;
    });
  }

  public async getById(actionId: string): Promise<DashboardAction | null> {
    return this.database.client.dashboardAction.findFirst({
      where: { id: actionId, guildId: this.guildId },
    });
  }

  public async list(limit = 25): Promise<DashboardAction[]> {
    return this.database.client.dashboardAction.findMany({
      where: { guildId: this.guildId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  public async cancel(actionId: string, actorId: string): Promise<boolean> {
    const result = await this.database.client.dashboardAction.updateMany({
      where: { id: actionId, guildId: this.guildId, status: 'PENDING' },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    if (result.count !== 1) {
      return false;
    }
    await this.auditTransition(
      actionId,
      actorId,
      'CANCELLED',
      AUDIT_ACTIONS.dashboardActionCancelled,
    );
    return true;
  }

  public async complete(
    actionId: string,
    actorId: string,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    const updated = await this.database.client.dashboardAction.updateMany({
      where: { id: actionId, guildId: this.guildId, status: 'RUNNING' },
      data: {
        status: 'COMPLETED',
        result: toJsonInput(result),
        completedAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      return false;
    }
    await this.auditTransition(
      actionId,
      actorId,
      'COMPLETED',
      AUDIT_ACTIONS.dashboardActionCompleted,
    );
    return true;
  }

  public async fail(actionId: string, actorId: string, error: string): Promise<boolean> {
    const updated = await this.database.client.dashboardAction.updateMany({
      where: { id: actionId, guildId: this.guildId, status: { in: ['PENDING', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        error: error.slice(0, 1_000),
        completedAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      return false;
    }
    await this.auditTransition(actionId, actorId, 'FAILED', AUDIT_ACTIONS.dashboardActionFailed);
    return true;
  }

  private async auditTransition(
    actionId: string,
    actorId: string,
    status: string,
    action: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.appendAudit(transaction, {
        actorType: 'USER',
        actorId,
        action,
        targetType: 'DashboardAction',
        targetId: actionId,
        after: { status },
      });
    });
  }
}

/**
 * System-level claim used by the bot. A compare-and-set update prevents two
 * bot replicas from executing the same queued action.
 */ export async function claimNextDashboardAction(
  database: Database,
): Promise<DashboardAction | null> {
  const candidates = await database.client.dashboardAction.findMany({
    where: { status: 'PENDING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 5,
  });

  for (const candidate of candidates) {
    const claimed = await database.client.dashboardAction.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (claimed.count === 1) {
      return database.client.dashboardAction.findUnique({ where: { id: candidate.id } });
    }
  }

  return null;
}

/**
 * Fails actions left RUNNING by a bot that stopped mid-execution. The threshold
 * is conservative so a slow restore is not marked failed while still running.
 */
export async function failStaleDashboardActions(
  database: Database,
  olderThanMs = 15 * 60_000,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const result = await database.client.dashboardAction.updateMany({
    where: { status: 'RUNNING', startedAt: { lt: cutoff } },
    data: {
      status: 'FAILED',
      error: 'T77 restarted before this action finished. Retry it from the dashboard.',
      completedAt: new Date(),
    },
  });
  return result.count;
}
