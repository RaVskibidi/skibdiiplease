import { z } from 'zod';

import type { BeastModeState } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, TenantRepository } from './base.ts';

export const beastModeSettingsUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    threshold: z.number().int().min(1).max(10_000).optional(),
    durationMinutes: z.number().int().min(1).max(1_440).optional(),
    emergencyLockdown: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'at least one Beast Mode field must be provided',
  );

export type BeastModeSettingsUpdateInput = z.input<typeof beastModeSettingsUpdateSchema>;

export interface BeastActivationInput {
  readonly score: number;
  readonly expiresAt: Date;
  readonly activatedBy?: string | null;
  readonly reason: string;
  readonly incidentId?: string | null;
}

/**
 * Beast Mode is an emergency *monitoring* state. Persisting activation never
 * applies a punishment; individual actions are still assessed per actor.
 */
export class BeastModeRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async getOrCreate(): Promise<BeastModeState> {
    return this.database.client.beastModeState.upsert({
      where: { guildId: this.guildId },
      create: { guildId: this.guildId },
      update: {},
    });
  }

  public async updateSettings(
    input: BeastModeSettingsUpdateInput,
    actorId?: string | null,
  ): Promise<BeastModeState> {
    const parsed = beastModeSettingsUpdateSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      await this.getOrCreate();

      const before = this.assertRowOwnership(
        await transaction.beastModeState.findUnique({ where: { guildId: this.guildId } }),
        'Beast Mode state',
        this.guildId,
      );

      const state = await transaction.beastModeState.update({
        where: { guildId: this.guildId },
        data: parsed,
      });

      await this.appendAudit(transaction, {
        actorType: actorId ? 'USER' : 'SYSTEM',
        actorId: actorId ?? null,
        action: AUDIT_ACTIONS.beastModeSettingsUpdated,
        targetType: 'BeastModeState',
        targetId: this.guildId,
        before: beastSnapshot(before),
        after: beastSnapshot(state),
      });

      return state;
    });
  }

  public async activate(input: BeastActivationInput): Promise<BeastModeState> {
    return this.database.transaction(async (transaction) => {
      await this.getOrCreate();

      const state = await transaction.beastModeState.update({
        where: { guildId: this.guildId },
        data: {
          active: true,
          score: input.score,
          activatedAt: new Date(),
          expiresAt: input.expiresAt,
          incidentId: input.incidentId ?? null,
          activatedBy: input.activatedBy ?? null,
          activationReason: input.reason,
          deactivatedAt: null,
          overrideBy: null,
          overrideReason: null,
          overriddenAt: null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: input.activatedBy ? 'USER' : 'SYSTEM',
        actorId: input.activatedBy ?? null,
        action: AUDIT_ACTIONS.beastModeActivated,
        targetType: 'BeastModeState',
        targetId: this.guildId,
        after: {
          score: state.score,
          expiresAt: state.expiresAt?.toISOString() ?? null,
          incidentId: state.incidentId,
          reason: input.reason,
        },
      });

      return state;
    });
  }

  public async updateScore(score: number): Promise<BeastModeState> {
    return this.database.client.beastModeState.update({
      where: { guildId: this.guildId },
      data: { score: Math.max(0, Math.round(score)) },
    });
  }

  public async deactivate(input: {
    readonly actorId?: string | null;
    readonly reason: string;
    readonly resetScore?: boolean;
  }): Promise<BeastModeState> {
    return this.database.transaction(async (transaction) => {
      await this.getOrCreate();

      const before = this.assertRowOwnership(
        await transaction.beastModeState.findUnique({ where: { guildId: this.guildId } }),
        'Beast Mode state',
        this.guildId,
      );

      const state = await transaction.beastModeState.update({
        where: { guildId: this.guildId },
        data: {
          active: false,
          score: input.resetScore === false ? before.score : 0,
          deactivatedAt: new Date(),
          overrideBy: input.actorId ?? null,
          overrideReason: input.reason,
          overriddenAt: input.actorId ? new Date() : null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: input.actorId ? 'USER' : 'SYSTEM',
        actorId: input.actorId ?? null,
        action: AUDIT_ACTIONS.beastModeDeactivated,
        targetType: 'BeastModeState',
        targetId: this.guildId,
        before: { active: before.active, score: before.score },
        after: { active: state.active, score: state.score, reason: input.reason },
      });

      return state;
    });
  }
}

function beastSnapshot(state: BeastModeState): Record<string, unknown> {
  return {
    enabled: state.enabled,
    threshold: state.threshold,
    durationMinutes: state.durationMinutes,
    emergencyLockdown: state.emergencyLockdown,
  };
}
