import { z } from 'zod';

import type { SecurityEvent, SecurityIncident } from '../generated/prisma/client.ts';
import type { Database } from '../client.ts';
import { isUniqueConstraintError } from '../client.ts';
import type { DbLogger } from '../logger.ts';
import { silentDbLogger } from '../logger.ts';
import type { TenantContext } from '../tenant.ts';
import { AUDIT_ACTIONS, toJsonInput, TenantRepository } from './base.ts';

const incidentTypeSchema = z.enum([
  'NUKING',
  'MASS_JOIN',
  'RAID',
  'BEAST_MODE',
  'SPAM',
  'AUTOMOD',
  'VERIFICATION_ABUSE',
  'SUSPICIOUS_BOT',
  'DANGEROUS_PERMISSION',
  'MANUAL',
]);

export const incidentOpenSchema = z
  .object({
    type: incidentTypeSchema,
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
    score: z.number().int().min(0).max(100_000).default(0),
    actorId: z
      .string()
      .regex(/^\d{17,20}$/u)
      .nullable()
      .optional(),
    actorSummary: z.string().trim().max(500).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const securityEventSchema = z
  .object({
    source: z.enum(['AUDIT_LOG', 'GATEWAY', 'MESSAGE', 'COMMAND', 'DASHBOARD', 'SYSTEM']),
    externalEventId: z.string().trim().min(1).max(128),
    action: z.string().trim().min(1).max(128),
    actorId: z
      .string()
      .regex(/^\d{17,20}$/u)
      .nullable()
      .optional(),
    targetId: z
      .string()
      .regex(/^\d{17,20}$/u)
      .nullable()
      .optional(),
    riskScore: z.number().int().min(0).max(100_000).default(0),
    incidentId: z.string().cuid().nullable().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    occurredAt: z.date().optional(),
  })
  .strict();

export type IncidentCreateInput = z.input<typeof incidentOpenSchema>;
export type SecurityEventInput = z.input<typeof securityEventSchema>;

/** Security incidents and the normalized event ledger that feeds them. */
export class IncidentRepository extends TenantRepository {
  public constructor(database: Database, tenant: TenantContext, logger: DbLogger = silentDbLogger) {
    super(database, tenant, logger);
  }

  public async open(input: IncidentCreateInput): Promise<SecurityIncident> {
    const parsed = incidentOpenSchema.parse(input);

    return this.database.transaction(async (transaction) => {
      const incident = await transaction.securityIncident.create({
        data: {
          guildId: this.guildId,
          type: parsed.type,
          severity: parsed.severity,
          score: parsed.score,
          actorId: parsed.actorId ?? null,
          actorSummary: parsed.actorSummary ?? null,
          metadata: toJsonInput(parsed.metadata),
        },
      });

      await this.appendAudit(transaction, {
        action: AUDIT_ACTIONS.incidentOpened,
        targetType: 'SecurityIncident',
        targetId: incident.id,
        after: {
          type: incident.type,
          severity: incident.severity,
          score: incident.score,
        },
      });

      return incident;
    });
  }

  /**
   * Inserts a security event once per (guild, source, externalEventId).
   * Duplicate delivery returns the existing ledger row instead of double-counting.
   */
  public async recordEvent(input: SecurityEventInput): Promise<SecurityEvent> {
    const result = await this.recordEventOnce(input);
    return result.event;
  }

  /**
   * Idempotent insert that tells the caller whether this delivery was new.
   * The Anti-Nuke coordinator uses this to avoid double counting and duplicate
   * alerts when the gateway redelivers an audit entry.
   */
  public async recordEventOnce(
    input: SecurityEventInput,
  ): Promise<{ event: SecurityEvent; created: boolean }> {
    const parsed = securityEventSchema.parse(input);

    try {
      const event = await this.database.client.securityEvent.create({
        data: {
          guildId: this.guildId,
          source: parsed.source,
          externalEventId: parsed.externalEventId,
          action: parsed.action,
          actorId: parsed.actorId ?? null,
          targetId: parsed.targetId ?? null,
          riskScore: parsed.riskScore,
          incidentId: parsed.incidentId ?? null,
          payload: toJsonInput(parsed.payload),
          occurredAt: parsed.occurredAt ?? new Date(),
        },
      });

      return { event, created: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await this.database.client.securityEvent.findUnique({
        where: {
          guildId_source_externalEventId: {
            guildId: this.guildId,
            source: parsed.source,
            externalEventId: parsed.externalEventId,
          },
        },
      });

      if (existing === null) {
        throw error;
      }

      return { event: existing, created: false };
    }
  }

  public async getById(incidentId: string): Promise<SecurityIncident | null> {
    return this.database.client.securityIncident.findFirst({
      where: { id: incidentId, guildId: this.guildId },
    });
  }

  /** Finds the newest open incident of a type, used to coalesce a raid burst. */
  public async findOpenByTypeSince(
    type:
      | 'NUKING'
      | 'MASS_JOIN'
      | 'RAID'
      | 'BEAST_MODE'
      | 'SPAM'
      | 'AUTOMOD'
      | 'VERIFICATION_ABUSE'
      | 'SUSPICIOUS_BOT'
      | 'DANGEROUS_PERMISSION'
      | 'MANUAL',
    since: Date,
  ): Promise<SecurityIncident | null> {
    return this.database.client.securityIncident.findFirst({
      where: {
        guildId: this.guildId,
        type,
        status: { in: ['OPEN', 'MONITORING'] },
        openedAt: { gte: since },
      },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    });
  }

  public async findOpenForActor(
    actorId: string | null,
    type?:
      | 'NUKING'
      | 'MASS_JOIN'
      | 'RAID'
      | 'BEAST_MODE'
      | 'SPAM'
      | 'AUTOMOD'
      | 'VERIFICATION_ABUSE'
      | 'SUSPICIOUS_BOT'
      | 'DANGEROUS_PERMISSION'
      | 'MANUAL',
  ): Promise<SecurityIncident | null> {
    return this.database.client.securityIncident.findFirst({
      where: {
        guildId: this.guildId,
        actorId,
        status: { in: ['OPEN', 'MONITORING'] },
        ...(type === undefined ? {} : { type }),
      },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    });
  }

  public async updateScore(
    incidentId: string,
    input: {
      score: number;
      severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      actorSummary?: string | null;
      metadata?: Record<string, unknown>;
      status?: 'OPEN' | 'MONITORING';
    },
  ): Promise<SecurityIncident | null> {
    return this.database.transaction(async (transaction) => {
      const before = this.assertRowOwnership(
        await transaction.securityIncident.findFirst({
          where: { id: incidentId, guildId: this.guildId },
        }),
        'security incident',
        incidentId,
      );

      const incident = await transaction.securityIncident.update({
        where: { id: incidentId },
        data: {
          score: input.score,
          severity: input.severity,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.actorSummary === undefined ? {} : { actorSummary: input.actorSummary }),
          ...(input.metadata === undefined ? {} : { metadata: toJsonInput(input.metadata) }),
        },
      });

      await this.appendAudit(transaction, {
        action: AUDIT_ACTIONS.incidentUpdated,
        targetType: 'SecurityIncident',
        targetId: incidentId,
        before: { score: before.score, severity: before.severity, status: before.status },
        after: {
          score: incident.score,
          severity: incident.severity,
          status: incident.status,
        },
      });

      return incident;
    });
  }

  /** Links a previously persisted event to its incident without rewriting history. */
  public async attachEvent(eventId: string, incidentId: string): Promise<boolean> {
    const result = await this.database.client.securityEvent.updateMany({
      where: { id: eventId, guildId: this.guildId },
      data: { incidentId },
    });

    return result.count === 1;
  }

  /**
   * Updates the scoring metadata of an already-recorded event.
   *
   * The audit ledger is append-only, but `security_events` is operational state:
   * the risk score and incident link are filled in after the engine evaluates the
   * event. No message content or actor attribution is ever rewritten here.
   */
  public async updateEvent(
    eventId: string,
    input: { riskScore?: number; incidentId?: string | null },
  ): Promise<boolean> {
    const result = await this.database.client.securityEvent.updateMany({
      where: { id: eventId, guildId: this.guildId },
      data: {
        ...(input.riskScore === undefined ? {} : { riskScore: input.riskScore }),
        ...(input.incidentId === undefined ? {} : { incidentId: input.incidentId }),
      },
    });

    return result.count === 1;
  }

  public async close(
    incidentId: string,
    status: 'RESOLVED' | 'DISMISSED' = 'RESOLVED',
    actorId?: string | null,
    reason?: string,
  ): Promise<SecurityIncident | null> {
    return this.database.transaction(async (transaction) => {
      const before = await transaction.securityIncident.findFirst({
        where: { id: incidentId, guildId: this.guildId },
      });

      if (before === null) {
        return null;
      }

      this.assertRowOwnership(before, 'security incident', incidentId);

      const incident = await transaction.securityIncident.update({
        where: { id: incidentId },
        data: {
          status,
          closedAt: new Date(),
          overrideBy: actorId ?? null,
          overrideReason: reason ?? null,
        },
      });

      await this.appendAudit(transaction, {
        actorType: actorId ? 'USER' : 'SYSTEM',
        actorId: actorId ?? null,
        action: AUDIT_ACTIONS.incidentClosed,
        targetType: 'SecurityIncident',
        targetId: incidentId,
        before: { status: before.status },
        after: { status, reason: reason ?? null },
      });

      return incident;
    });
  }

  public async list(
    options: {
      status?: 'OPEN' | 'MONITORING' | 'RESOLVED' | 'DISMISSED';
      limit?: number;
    } = {},
  ): Promise<SecurityIncident[]> {
    return this.database.client.securityIncident.findMany({
      where: {
        guildId: this.guildId,
        ...(options.status === undefined ? {} : { status: options.status }),
      },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });
  }

  public async recentEvents(limit = 50): Promise<SecurityEvent[]> {
    return this.database.client.securityEvent.findMany({
      where: { guildId: this.guildId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });
  }
}
