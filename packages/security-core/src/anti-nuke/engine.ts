import { actionDefinition, incidentTypeForAction, severityForScore } from './catalog.js';
import { resolveExemption } from './exemptions.js';
import { resolveResponsePolicy } from './response-policy.js';
import type {
  AntiNukeCounterStore,
  AntiNukeDecision,
  AntiNukeEngineOptions,
  AntiNukeEvaluationInput,
  AntiNukeRiskEntry,
  ResponseBlockReason,
} from './types.js';

interface RiskEntry {
  at: number;
  weight: number;
}

interface CounterSnapshot {
  windowTimestamps: readonly number[];
  riskEntries: readonly RiskEntry[];
  cooldownActive: boolean;
}

const DEFAULT_RISK_WINDOW_SECONDS = 900;
const DEFAULT_MINIMUM_EVENTS = 2;
const DEFAULT_ACTOR_COOLDOWN_SECONDS = 60;
const DEFAULT_MAX_TRACKED_ACTORS = 25_000;

/**
 * Deterministic, in-memory Anti-Nuke evaluation engine.
 *
 * The engine deliberately performs no I/O. Production uses `evaluateWithStore`
 * so rolling counters live in Redis, while unit tests use the synchronous
 * in-memory `evaluate` path. Durable event history remains the audit trail.
 */
export class AntiNukeEngine {
  private readonly riskWindowMs: number;
  private readonly minimumEventsForEnforcement: number;
  private readonly actorResponseCooldownMs: number;
  private readonly maxTrackedActors: number;
  private readonly clock: () => Date;

  private readonly windows = new Map<string, number[]>();
  private readonly risk = new Map<string, RiskEntry[]>();
  private readonly lastEnforcementByActorAction = new Map<string, number>();
  private readonly lastEnforcementByActor = new Map<string, number>();

  public constructor(options: AntiNukeEngineOptions = {}) {
    this.riskWindowMs = (options.riskWindowSeconds ?? DEFAULT_RISK_WINDOW_SECONDS) * 1_000;
    this.minimumEventsForEnforcement =
      options.minimumEventsForEnforcement ?? DEFAULT_MINIMUM_EVENTS;
    this.actorResponseCooldownMs =
      (options.actorResponseCooldownSeconds ?? DEFAULT_ACTOR_COOLDOWN_SECONDS) * 1_000;
    this.maxTrackedActors = options.maxTrackedActors ?? DEFAULT_MAX_TRACKED_ACTORS;
    this.clock = options.clock ?? (() => new Date());

    if (this.minimumEventsForEnforcement < 2) {
      throw new Error('Anti-Nuke requires at least two certain events before enforcement.');
    }
  }

  /** Synchronous in-memory evaluation. Used by unit tests and as a fallback. */
  public evaluate(input: AntiNukeEvaluationInput): AntiNukeDecision {
    const preparation = this.prepare(input);
    if ('decision' in preparation) {
      return preparation.decision;
    }

    const counters = this.recordInMemory(input, preparation.definition, preparation.now);

    return this.decide(input, preparation.base, preparation.definition, counters);
  }

  /**
   * Evaluation backed by a durable counter store (Redis in production).
   *
   * The store atomically prunes expired entries, records this event, and returns
   * the current window and risk counters. Engine policy is unchanged, so the
   * safety invariants tested in the synchronous path also apply here.
   */
  public async evaluateWithStore(
    input: AntiNukeEvaluationInput,
    store: AntiNukeCounterStore,
  ): Promise<AntiNukeDecision> {
    const preparation = this.prepare(input);
    if ('decision' in preparation) {
      return preparation.decision;
    }

    const { event, rule } = input;
    const now = preparation.now;
    const actorId = event.actorId as string;

    const snapshot = await store.record({
      guildId: event.guildId,
      actorId,
      action: event.action,
      eventId: event.eventId,
      occurredAt: Math.min(event.occurredAt.getTime(), now),
      now,
      windowSeconds: rule.windowSeconds,
      riskWindowSeconds: this.riskWindowMs / 1_000,
      riskWeight: preparation.definition.riskWeight,
      cooldownSeconds: rule.cooldownSeconds,
      actorCooldownSeconds: this.actorResponseCooldownMs / 1_000,
    });

    const decision = this.decide(
      input,
      preparation.base,
      preparation.definition,
      {
        windowTimestamps: snapshot.windowTimestamps,
        riskEntries: snapshot.riskEntries,
        cooldownActive: snapshot.cooldownActive,
      },
      event.actorId as string,
    );

    if (decision.effectiveContainment !== null) {
      await store.recordEnforcement({
        guildId: event.guildId,
        actorId,
        action: event.action,
        now,
        cooldownSeconds: rule.cooldownSeconds,
        actorCooldownSeconds: this.actorResponseCooldownMs / 1_000,
      });
    }

    return decision;
  }

  /** Clears all in-memory counters. Used on explicit operator reset and in tests. */
  public reset(): void {
    this.windows.clear();
    this.risk.clear();
    this.lastEnforcementByActorAction.clear();
    this.lastEnforcementByActor.clear();
  }

  public trackedActorCount(): number {
    return this.risk.size;
  }

  /**
   * Applies rule, attribution, and exemption pre-checks shared by both paths.
   * Returns a terminal decision when evaluation must stop before counters.
   */
  private prepare(
    input: AntiNukeEvaluationInput,
  ): { decision: AntiNukeDecision } | PreparedEvaluation {
    const { event, rule, authorization } = input;
    const now = this.clock().getTime();
    const definition = actionDefinition(event.action);
    const base = {
      eventId: event.eventId,
      guildId: event.guildId,
      action: event.action,
      actorId: event.actorId,
      targetId: event.targetId,
      occurredAt: event.occurredAt,
      incidentType: incidentTypeForAction(event.action),
      threshold: rule.threshold,
      windowSeconds: rule.windowSeconds,
      recommendedContainment: rule.containment,
      attribution: event.attribution,
    } as const;

    if (!rule.enabled) {
      return {
        decision: {
          ...base,
          counted: false,
          exemption: 'RULE_DISABLED',
          count: 0,
          riskScore: 0,
          severity: 'LOW',
          thresholdExceeded: false,
          effectiveContainment: null,
          blockedReason: 'THRESHOLD_NOT_MET',
          wouldHaveActed: false,
          shouldAlert: false,
          shouldOpenIncident: false,
        },
      };
    }

    // Missing attribution or a synthetic fallback event is evidence, not proof.
    // T77 alerts and records it, but never attributes it to a member.
    if (event.attribution !== 'CERTAIN' || event.actorId === null) {
      const severity: AntiNukeDecision['severity'] = definition.destructive ? 'HIGH' : 'MEDIUM';

      return {
        decision: {
          ...base,
          counted: false,
          exemption: null,
          count: 0,
          riskScore: 0,
          severity,
          thresholdExceeded: false,
          effectiveContainment: null,
          blockedReason: 'UNCERTAIN_ATTRIBUTION',
          wouldHaveActed: false,
          shouldAlert: true,
          shouldOpenIncident: definition.destructive,
        },
      };
    }

    const exemption = resolveExemption(rule.enabled, authorization);
    if (exemption !== null) {
      return {
        decision: {
          ...base,
          counted: false,
          exemption,
          count: 0,
          riskScore: 0,
          severity: 'LOW',
          thresholdExceeded: false,
          effectiveContainment: null,
          blockedReason: 'THRESHOLD_NOT_MET',
          wouldHaveActed: false,
          shouldAlert: false,
          shouldOpenIncident: false,
        },
      };
    }

    return { now, definition, base };
  }

  private recordInMemory(
    input: AntiNukeEvaluationInput,
    definition: ReturnType<typeof actionDefinition>,
    now: number,
  ): CounterSnapshot {
    const { event, rule } = input;
    const actorId = event.actorId as string;
    const occurredAtMs = Math.min(event.occurredAt.getTime(), now);
    const windowKey = this.windowKey(actorId, event.action);
    const windowMs = Math.max(rule.windowSeconds, 1) * 1_000;
    const cutoff = now - windowMs;

    const timestamps = this.pruneTimestamps(this.windows.get(windowKey) ?? [], cutoff);
    // A late audit entry older than the rule window is evidence, but it cannot
    // retroactively push the actor over a live threshold.
    if (occurredAtMs >= cutoff) {
      timestamps.push(occurredAtMs);
      timestamps.sort((left, right) => left - right);
    }
    this.windows.set(windowKey, timestamps);

    const riskCutoff = now - this.riskWindowMs;
    const riskEntries = this.pruneRisk(this.risk.get(actorId) ?? [], riskCutoff);
    if (occurredAtMs >= riskCutoff) {
      riskEntries.push({ at: occurredAtMs, weight: definition.riskWeight });
    }
    this.risk.set(actorId, riskEntries);
    this.enforceActorLimit();

    const cooldownActive = this.isCooldownActive(actorId, event.action, now, rule.cooldownSeconds);

    return { windowTimestamps: timestamps, riskEntries, cooldownActive };
  }

  private decide(
    input: AntiNukeEvaluationInput,
    base: PreparedEvaluation['base'],
    definition: ReturnType<typeof actionDefinition>,
    counters: CounterSnapshot,
    actorIdOverride?: string,
  ): AntiNukeDecision {
    const { event, rule, authorization, automationMode } = input;
    const now = this.clock().getTime();
    const actorId = actorIdOverride ?? (event.actorId as string);
    const timestamps = counters.windowTimestamps;
    const riskEntries = counters.riskEntries;

    const count = timestamps.length;
    const thresholdExceeded = count >= rule.threshold;
    const riskScore = this.computeRiskScore(riskEntries, now);
    const severity = severityForScore(riskScore, {
      destructive: definition.destructive,
      thresholdExceeded,
    });

    const hierarchyBlocked = isHierarchyBlocked(
      authorization.actorRolePosition,
      authorization.botRolePosition,
    );

    const policy = resolveResponsePolicy({
      automationMode,
      containment: rule.containment,
      requiresDestructiveApproval: rule.requiresDestructiveApproval,
      enforcementApproved: authorization.enforcementApproved,
      eventCount: count,
      thresholdExceeded,
      attribution: event.attribution,
      hierarchyBlocked,
      cooldownActive: counters.cooldownActive,
      minimumEventsForEnforcement: this.minimumEventsForEnforcement,
    });

    // The in-memory path records enforcement here. The store path records it
    // after `decide` returns, so the counters remain atomic in Redis.
    if (actorIdOverride === undefined && policy.effectiveContainment !== null) {
      this.recordEnforcement(actorId, event.action, now);
    }

    const blockedReason: ResponseBlockReason | null = hierarchyBlocked
      ? 'HIERARCHY'
      : policy.blockedReason;

    return {
      ...base,
      counted: true,
      exemption: null,
      count,
      riskScore,
      severity,
      thresholdExceeded,
      effectiveContainment: policy.effectiveContainment,
      blockedReason,
      wouldHaveActed: policy.wouldHaveActed,
      shouldAlert: thresholdExceeded || (definition.destructive && definition.riskWeight >= 35),
      shouldOpenIncident: thresholdExceeded,
    };
  }

  private windowKey(actorId: string, action: string): string {
    return `${actorId}|${action}`;
  }

  private pruneTimestamps(timestamps: readonly number[], cutoff: number): number[] {
    return timestamps.filter((timestamp) => timestamp >= cutoff);
  }

  private pruneRisk(entries: readonly RiskEntry[], cutoff: number): RiskEntry[] {
    return entries.filter((entry) => entry.at >= cutoff);
  }

  private computeRiskScore(entries: readonly AntiNukeRiskEntry[], now: number): number {
    let score = 0;

    for (const entry of entries) {
      const age = Math.max(0, now - entry.at);
      const remaining = Math.max(0, 1 - age / this.riskWindowMs);
      score += entry.weight * remaining;
    }

    return Math.round(score);
  }

  private isCooldownActive(
    actorId: string,
    action: string,
    now: number,
    ruleCooldownSeconds: number,
  ): boolean {
    const actorActionKey = this.windowKey(actorId, action);
    const actorActionUntil =
      (this.lastEnforcementByActorAction.get(actorActionKey) ?? 0) +
      Math.max(ruleCooldownSeconds, 0) * 1_000;
    const actorUntil =
      (this.lastEnforcementByActor.get(actorId) ?? 0) + this.actorResponseCooldownMs;

    return now < actorActionUntil || now < actorUntil;
  }

  private recordEnforcement(actorId: string, action: string, now: number): void {
    const actorActionKey = this.windowKey(actorId, action);
    this.lastEnforcementByActorAction.set(actorActionKey, now);
    this.lastEnforcementByActor.set(actorId, now);
  }

  private enforceActorLimit(): void {
    if (this.risk.size <= this.maxTrackedActors) {
      return;
    }

    // Map preserves insertion order; evict the oldest actor key. This is only
    // an emergency memory guard and never influences persisted history.
    const oldest = this.risk.keys().next();
    if (!oldest.done) {
      this.risk.delete(oldest.value);
    }
  }
}

interface PreparedEvaluation {
  readonly now: number;
  readonly definition: ReturnType<typeof actionDefinition>;
  readonly base: {
    readonly eventId: string;
    readonly guildId: string;
    readonly action: AntiNukeEvaluationInput['event']['action'];
    readonly actorId: string | null;
    readonly targetId: string | null;
    readonly occurredAt: Date;
    readonly incidentType: ReturnType<typeof incidentTypeForAction>;
    readonly threshold: number;
    readonly windowSeconds: number;
    readonly recommendedContainment: AntiNukeEvaluationInput['rule']['containment'];
    readonly attribution: AntiNukeEvaluationInput['event']['attribution'];
  };
}

export function isHierarchyBlocked(
  actorRolePosition: number | null,
  botRolePosition: number | null,
): boolean {
  if (actorRolePosition === null || botRolePosition === null) {
    return true;
  }

  return actorRolePosition >= botRolePosition;
}
