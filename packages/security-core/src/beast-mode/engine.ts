export interface BeastModePolicy {
  readonly enabled: boolean;
  /** Aggregate risk required to activate heightened monitoring. */
  readonly threshold: number;
  readonly durationMinutes: number;
  /** Score contributions older than this contribute nothing. */
  readonly riskWindowSeconds: number;
  /** True when activation should restrict channels. Disabled by default. */
  readonly emergencyLockdown: boolean;
}

export interface BeastRiskContribution {
  readonly eventId: string;
  readonly actorId: string | null;
  readonly at: Date;
  readonly weight: number;
  readonly counted: boolean;
  readonly authorized: boolean;
  readonly isOwner: boolean;
  readonly destructive: boolean;
}

export interface BeastStateSnapshot {
  readonly active: boolean;
  readonly score: number;
  readonly activatedAt: Date | null;
  readonly expiresAt: Date | null;
}

export type BeastBlockedReason =
  'BEAST_DISABLED' | 'AUTHORIZED_ACTOR' | 'OWNER' | 'NOT_COUNTED' | 'NO_ACTOR';

export interface BeastActorEvaluation {
  readonly actorId: string | null;
  readonly contributes: boolean;
  readonly weight: number;
  readonly blockedReason: BeastBlockedReason | null;
  /** Beast mode never punishes on its own; this only marks heightened scrutiny. */
  readonly heightenedScrutiny: boolean;
}

export interface BeastTransition {
  readonly shouldActivate: boolean;
  readonly shouldDeactivate: boolean;
  readonly score: number;
  readonly expiresAt: Date | null;
  readonly blockedReason: BeastBlockedReason | null;
}

export const DEFAULT_BEAST_MODE_POLICY: BeastModePolicy = {
  enabled: true,
  threshold: 100,
  durationMinutes: 60,
  riskWindowSeconds: 900,
  emergencyLockdown: false,
};

/**
 * Budgets one security event into the Beast score.
 *
 * Only an unauthorized, attributable, counted action contributes. Authorized
 * staff, trusted actors, and the owner are never treated as threats merely
 * because Beast Mode is active.
 */
export function evaluateBeastActor(
  contribution: BeastRiskContribution,
  policy: BeastModePolicy,
): BeastActorEvaluation {
  if (!policy.enabled) {
    return { ...blocked(contribution, 'BEAST_DISABLED'), heightenedScrutiny: false };
  }

  if (contribution.isOwner) {
    return { ...blocked(contribution, 'OWNER'), heightenedScrutiny: false };
  }

  if (contribution.authorized) {
    return { ...blocked(contribution, 'AUTHORIZED_ACTOR'), heightenedScrutiny: false };
  }

  if (!contribution.counted) {
    return { ...blocked(contribution, 'NOT_COUNTED'), heightenedScrutiny: false };
  }

  if (contribution.actorId === null) {
    return { ...blocked(contribution, 'NO_ACTOR'), heightenedScrutiny: false };
  }

  return {
    actorId: contribution.actorId,
    contributes: true,
    weight: Math.max(0, Math.round(contribution.weight)),
    blockedReason: null,
    heightenedScrutiny: true,
  };
}

/** Sums decayed Beast contributions inside the policy window. */
export function computeBeastScore(
  contributions: readonly BeastRiskContribution[],
  policy: BeastModePolicy,
  now: Date,
): number {
  const windowMs = Math.max(policy.riskWindowSeconds, 1) * 1_000;

  return Math.round(
    contributions.reduce((total, contribution) => {
      const age = now.getTime() - contribution.at.getTime();
      if (age < 0 || age > windowMs) {
        return total;
      }

      const remaining = Math.max(0, 1 - age / windowMs);
      const evaluation = evaluateBeastActor(contribution, policy);
      return total + (evaluation.contributes ? evaluation.weight * remaining : 0);
    }, 0),
  );
}

/**
 * Applies a new aggregate score to the current Beast state.
 *
 * Activation never triggers a punishment. It only opens an incident and raises
 * scrutiny for independently evaluated, unauthorized actors.
 */
export function transitionBeastState(input: {
  readonly policy: BeastModePolicy;
  readonly state: BeastStateSnapshot;
  readonly score: number;
  readonly now: Date;
}): BeastTransition {
  const { policy, state, score, now } = input;

  if (!policy.enabled) {
    return {
      shouldActivate: false,
      shouldDeactivate: false,
      score: 0,
      expiresAt: null,
      blockedReason: 'BEAST_DISABLED',
    };
  }

  const expired = state.expiresAt !== null && state.expiresAt.getTime() <= now.getTime();

  if (state.active && expired) {
    return {
      shouldActivate: false,
      shouldDeactivate: true,
      score: 0,
      expiresAt: null,
      blockedReason: null,
    };
  }

  if (!state.active && score >= policy.threshold) {
    return {
      shouldActivate: true,
      shouldDeactivate: false,
      score,
      expiresAt: new Date(now.getTime() + Math.max(policy.durationMinutes, 1) * 60_000),
      blockedReason: null,
    };
  }

  return {
    shouldActivate: false,
    shouldDeactivate: false,
    score,
    expiresAt: state.expiresAt,
    blockedReason: state.active ? null : 'NOT_COUNTED',
  };
}

function blocked(
  contribution: BeastRiskContribution,
  blockedReason: BeastBlockedReason,
): Omit<BeastActorEvaluation, 'heightenedScrutiny'> {
  return {
    actorId: contribution.actorId,
    contributes: false,
    weight: 0,
    blockedReason,
  };
}
