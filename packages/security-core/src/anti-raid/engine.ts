import type {
  AntiRaidPolicy,
  RaidDecision,
  RaidEvaluationInput,
  RaidJoinRecord,
  RaidSignalDetail,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const SIMILAR_ACCOUNT_AGE_MS = DAY_MS;

/**
 * Evaluates one join against the raid policy.
 *
 * Safety invariants:
 *  - account age alone can never produce containment;
 *  - a single signal can never produce containment;
 *  - velocity requires the configured aggregate threshold;
 *  - observation mode records intent but performs nothing;
 *  - destructive action needs destructive mode, owner approval, and auto-ban enabled.
 */
export function evaluateRaidJoin(input: RaidEvaluationInput, now: Date = new Date()): RaidDecision {
  const { join, policy, exemption } = input;
  const recentJoins = withinWindow(input.recentJoins, now, policy.joinWindowSeconds, join);
  const signals = collectSignals(join, recentJoins, policy, now);
  const score = Math.min(
    100,
    signals.reduce((total, signal) => total + signal.weight, 0),
  );
  const velocityDetected = signals.some((signal) => signal.signal === 'JOIN_VELOCITY');
  const raidActive =
    policy.enabled &&
    (velocityDetected ||
      (score >= policy.riskThreshold && signals.length >= policy.minimumSignals));

  const base = {
    userId: join.userId,
    score,
    signals,
    recentJoinCount: recentJoins.length,
    raidActive,
    requiresVerification: policy.verificationRequired,
    lockdownRecommended: raidActive && policy.lockdownEnabled,
    shouldOpenIncident: raidActive,
    shouldAlert: raidActive,
  } as const;

  if (!policy.enabled) {
    return noAction(base, 'ALERT', 'RAID_DISABLED');
  }

  if (industryExempt(exemption)) {
    return noAction(base, 'ALERT', 'WHITELISTED');
  }

  if (join.isBot) {
    // Bot additions are handled by Anti-Nuke's BOT_ADD rule; do not double-punish.
    return noAction(base, 'ALERT', 'BOT_ACCOUNT');
  }

  if (!raidActive) {
    return noAction(base, 'ALERT', 'THRESHOLD_NOT_MET');
  }

  const onlyAccountAge =
    signals.length > 0 && signals.every((signal) => signal.signal === 'YOUNG_ACCOUNT');
  if (onlyAccountAge) {
    return noAction(base, 'ALERT', 'ACCOUNT_AGE_ONLY');
  }

  if (signals.length < policy.minimumSignals) {
    return noAction(base, 'ALERT', 'INSUFFICIENT_SIGNALS');
  }

  const recommendedAction = selectAction(policy);
  if (recommendedAction === 'ALERT') {
    return noAction(base, 'ALERT', 'QUARANTINE_DISABLED');
  }

  if (input.automationMode === 'OBSERVE') {
    return blocked(base, recommendedAction, 'OBSERVE_MODE');
  }

  if (!input.enforcementApproved) {
    return blocked(base, recommendedAction, 'OWNER_APPROVAL_REQUIRED');
  }

  if (recommendedAction === 'BAN' && !policy.autoBanEnabled) {
    return blocked(base, recommendedAction, 'AUTO_BAN_DISABLED');
  }

  if (recommendedAction === 'BAN' && input.automationMode !== 'ENFORCE_DESTRUCTIVE') {
    return blocked(base, recommendedAction, 'OWNER_APPROVAL_REQUIRED');
  }

  return {
    ...base,
    recommendedAction,
    effectiveAction: recommendedAction,
    blockedReason: null,
    wouldHaveActed: true,
  };
}

function collectSignals(
  join: RaidJoinRecord,
  recentJoins: readonly RaidJoinRecord[],
  policy: AntiRaidPolicy,
  now: Date,
): RaidSignalDetail[] {
  const signals: RaidSignalDetail[] = [];
  const ageMs = Math.max(0, now.getTime() - join.accountCreatedAt.getTime());

  if (recentJoins.length >= policy.aggregateThreshold) {
    signals.push({
      signal: 'JOIN_VELOCITY',
      weight: policy.velocityWeight,
      detail: `${recentJoins.length} joins in ${policy.joinWindowSeconds}s`,
    });
  }

  if (ageMs < policy.minimumAccountAgeDays * DAY_MS) {
    signals.push({
      signal: 'YOUNG_ACCOUNT',
      weight: policy.accountAgeWeight,
      detail: `account is ${Math.floor(ageMs / DAY_MS)} day(s) old`,
    });
  }

  if (!join.hasAvatar) {
    signals.push({
      signal: 'NO_AVATAR',
      weight: policy.avatarWeight,
      detail: 'no custom avatar',
    });
  }

  const similar = recentJoins.some((other) => {
    if (other.userId === join.userId) {
      return false;
    }

    const delta = Math.abs(other.accountCreatedAt.getTime() - join.accountCreatedAt.getTime());
    return delta <= SIMILAR_ACCOUNT_AGE_MS;
  });

  if (similar) {
    signals.push({
      signal: 'SIMILAR_ACCOUNT_AGE',
      weight: policy.similarAgeWeight,
      detail: 'account creation time matches another recent join',
    });
  }

  if (join.username !== undefined && looksAutomated(join.username)) {
    signals.push({
      signal: 'SUSPICIOUS_USERNAME',
      weight: policy.suspiciousNameWeight,
      detail: 'username matches an automated-name pattern',
    });
  }

  return signals;
}

function looksAutomated(username: string): boolean {
  const normalized = username.toLowerCase();
  return (
    /(?:discord\.gg|raid|spam|nuke)/u.test(normalized) ||
    /\d{5,}/u.test(normalized) ||
    /(.)\1{6,}/u.test(normalized)
  );
}

function withinWindow(
  joins: readonly RaidJoinRecord[],
  now: Date,
  windowSeconds: number,
  current: RaidJoinRecord,
): RaidJoinRecord[] {
  const cutoff = now.getTime() - Math.max(windowSeconds, 1) * 1_000;
  const seen = new Set<string>();

  return [...joins, current]
    .filter((join) => join.joinedAt.getTime() >= cutoff)
    .filter((join) => {
      const key = `${join.userId}:${join.joinedAt.getTime()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.joinedAt.getTime() - right.joinedAt.getTime());
}

function selectAction(policy: AntiRaidPolicy): RaidDecision['recommendedAction'] {
  if (policy.autoBanEnabled) {
    return 'BAN';
  }

  if (!policy.quarantineEnabled) {
    return 'ALERT';
  }

  return 'QUARANTINE';
}

function industryExempt(exemption: RaidEvaluationInput['exemption']): boolean {
  return (
    exemption.isOwner ||
    exemption.isWhitelistedUser ||
    exemption.isAuthorizedStaff ||
    exemption.bypassesRaidChecks
  );
}

type DecisionBase = Pick<
  RaidDecision,
  | 'userId'
  | 'score'
  | 'signals'
  | 'recentJoinCount'
  | 'raidActive'
  | 'requiresVerification'
  | 'lockdownRecommended'
  | 'shouldAlert'
  | 'shouldOpenIncident'
>;

function noAction(
  base: DecisionBase,
  recommendedAction: RaidDecision['recommendedAction'],
  blockedReason: RaidDecision['blockedReason'],
): RaidDecision {
  return {
    ...base,
    recommendedAction,
    effectiveAction: null,
    blockedReason,
    wouldHaveActed: false,
  };
}

function blocked(
  base: DecisionBase,
  recommendedAction: RaidDecision['recommendedAction'],
  blockedReason: RaidDecision['blockedReason'],
): RaidDecision {
  return {
    ...base,
    recommendedAction,
    effectiveAction: null,
    blockedReason,
    wouldHaveActed: true,
  };
}
