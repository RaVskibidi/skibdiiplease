import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ANTI_RAID_POLICY,
  evaluateRaidJoin,
  type AntiRaidPolicy,
  type RaidEvaluationInput,
  type RaidJoinRecord,
} from '../../src/index.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1_000;

function join(overrides: Partial<RaidJoinRecord> = {}): RaidJoinRecord {
  return {
    userId: '111111111111111111',
    joinedAt: NOW,
    accountCreatedAt: new Date(NOW.getTime() - 30 * DAY),
    hasAvatar: true,
    isBot: false,
    username: 'regular-member',
    ...overrides,
  };
}

function policy(overrides: Partial<AntiRaidPolicy> = {}): AntiRaidPolicy {
  return {
    ...DEFAULT_ANTI_RAID_POLICY,
    aggregateThreshold: 5,
    minimumSignals: 2,
    riskThreshold: 50,
    ...overrides,
  };
}

function burst(count: number, overrides: Partial<RaidJoinRecord> = {}): RaidJoinRecord[] {
  return Array.from({ length: count }, (_, index) =>
    join({
      userId: `2222222222222222${String(index).padStart(2, '0')}`,
      joinedAt: new Date(NOW.getTime() - index * 1_000),
      accountCreatedAt: new Date(NOW.getTime() - 1 * DAY - index * 1_000),
      hasAvatar: false,
      username: `raid${index}12345`,
      ...overrides,
    }),
  );
}

function evaluate(overrides: Partial<RaidEvaluationInput> = {}) {
  return evaluateRaidJoin(
    {
      join: join({
        accountCreatedAt: new Date(NOW.getTime() - DAY),
        hasAvatar: false,
        username: 'raid12345',
      }),
      recentJoins: burst(5),
      policy: policy(),
      automationMode: 'OBSERVE',
      enforcementApproved: false,
      exemption: {
        isOwner: false,
        isWhitelistedUser: false,
        isAuthorizedStaff: false,
        bypassesRaidChecks: false,
      },
      ...overrides,
    },
    NOW,
  );
}

describe('evaluateRaidJoin', () => {
  it('detects a join burst but only observes by default', () => {
    const decision = evaluate();

    expect(decision.raidActive).toBe(true);
    expect(decision.recentJoinCount).toBe(6);
    expect(decision.signals.map((signal) => signal.signal)).toContain('JOIN_VELOCITY');
    expect(decision.recommendedAction).toBe('QUARANTINE');
    expect(decision.effectiveAction).toBeNull();
    expect(decision.blockedReason).toBe('OBSERVE_MODE');
    expect(decision.wouldHaveActed).toBe(true);
    expect(decision.shouldAlert).toBe(true);
    expect(decision.shouldOpenIncident).toBe(true);
    expect(decision.requiresVerification).toBe(true);
  });

  it('does nothing when Anti-Raid is disabled', () => {
    const decision = evaluate({ policy: policy({ enabled: false }) });

    expect(decision.raidActive).toBe(false);
    expect(decision.blockedReason).toBe('RAID_DISABLED');
    expect(decision.shouldAlert).toBe(false);
  });

  it('never contains from account age alone', () => {
    const decision = evaluate({
      join: join({ accountCreatedAt: new Date(NOW.getTime() - DAY) }),
      recentJoins: [],
      policy: policy({ minimumSignals: 1, riskThreshold: 10 }),
      automationMode: 'ENFORCE_REVERSIBLE',
      enforcementApproved: true,
    });

    expect(decision.signals.map((signal) => signal.signal)).toEqual(['YOUNG_ACCOUNT']);
    expect(decision.raidActive).toBe(true);
    expect(decision.effectiveAction).toBeNull();
    expect(decision.blockedReason).toBe('ACCOUNT_AGE_ONLY');
    expect(decision.wouldHaveActed).toBe(false);
  });

  it('requires the configured number of independent signals', () => {
    const decision = evaluate({
      join: join({
        userId: '333333333333333333',
        accountCreatedAt: new Date(NOW.getTime() - 100 * DAY),
      }),
      recentJoins: burst(5, {
        accountCreatedAt: new Date(NOW.getTime() - 30 * DAY),
        hasAvatar: true,
      }).map((item, index) => ({
        ...item,
        username: `calm${index}`,
        userId: `4444444444444444${index}`,
      })),
      policy: policy({ aggregateThreshold: 2, minimumSignals: 3 }),
      automationMode: 'ENFORCE_REVERSIBLE',
      enforcementApproved: true,
    });

    expect(decision.signals.map((signal) => signal.signal)).toEqual(['JOIN_VELOCITY']);
    expect(decision.raidActive).toBe(true);
    expect(decision.blockedReason).toBe('INSUFFICIENT_SIGNALS');
    expect(decision.effectiveAction).toBeNull();
  });

  it('quarantines in approved reversible mode', () => {
    const decision = evaluate({
      automationMode: 'ENFORCE_REVERSIBLE',
      enforcementApproved: true,
    });

    expect(decision.effectiveAction).toBe('QUARANTINE');
    expect(decision.blockedReason).toBeNull();
    expect(decision.wouldHaveActed).toBe(true);
  });

  it('adds lockdown only when configured', () => {
    const decision = evaluate({
      policy: policy({ lockdownEnabled: true }),
      automationMode: 'ENFORCE_REVERSIBLE',
      enforcementApproved: true,
    });

    expect(decision.effectiveAction).toBe('QUARANTINE');
    expect(decision.lockdownRecommended).toBe(true);
  });

  it('requires owner approval before reversible automation', () => {
    const decision = evaluate({ automationMode: 'ENFORCE_REVERSIBLE' });

    expect(decision.effectiveAction).toBeNull();
    expect(decision.blockedReason).toBe('OWNER_APPROVAL_REQUIRED');
    expect(decision.wouldHaveActed).toBe(true);
  });

  it('keeps auto-ban disabled by default', () => {
    const decision = evaluate({ automationMode: 'ENFORCE_DESTRUCTIVE', enforcementApproved: true });

    expect(decision.effectiveAction).toBe('QUARANTINE');
  });

  it('bans only with destructive mode, approval, and auto-ban enabled', () => {
    const decision = evaluate({
      policy: policy({ autoBanEnabled: true }),
      automationMode: 'ENFORCE_DESTRUCTIVE',
      enforcementApproved: true,
    });

    expect(decision.recommendedAction).toBe('BAN');
    expect(decision.effectiveAction).toBe('BAN');
  });

  it('blocks auto-ban in reversible mode', () => {
    const decision = evaluate({
      policy: policy({ autoBanEnabled: true }),
      automationMode: 'ENFORCE_REVERSIBLE',
      enforcementApproved: true,
    });

    expect(decision.effectiveAction).toBeNull();
    expect(decision.blockedReason).toBe('OWNER_APPROVAL_REQUIRED');
  });

  it('never contains a whitelisted or staff member', () => {
    for (const exemption of [
      {
        isOwner: true,
        isWhitelistedUser: false,
        isAuthorizedStaff: false,
        bypassesRaidChecks: false,
      },
      {
        isOwner: false,
        isWhitelistedUser: true,
        isAuthorizedStaff: false,
        bypassesRaidChecks: false,
      },
      {
        isOwner: false,
        isWhitelistedUser: false,
        isAuthorizedStaff: true,
        bypassesRaidChecks: false,
      },
      {
        isOwner: false,
        isWhitelistedUser: false,
        isAuthorizedStaff: false,
        bypassesRaidChecks: true,
      },
    ]) {
      const decision = evaluate({
        exemption,
        automationMode: 'ENFORCE_DESTRUCTIVE',
        enforcementApproved: true,
      });

      expect(decision.effectiveAction).toBeNull();
      expect(decision.blockedReason).toBe('WHITELISTED');
    }
  });

  it('leaves bot accounts to Anti-Nuke bot protection', () => {
    const decision = evaluate({
      join: join({ isBot: true }),
      automationMode: 'ENFORCE_DESTRUCTIVE',
      enforcementApproved: true,
    });

    expect(decision.blockedReason).toBe('BOT_ACCOUNT');
    expect(decision.effectiveAction).toBeNull();
  });

  it('ignores joins outside the configured window', () => {
    const old = burst(20).map((item) => ({
      ...item,
      joinedAt: new Date(NOW.getTime() - 600_000),
    }));

    const decision = evaluate({ recentJoins: old, policy: policy({ joinWindowSeconds: 60 }) });

    expect(decision.recentJoinCount).toBe(1);
    expect(decision.signals.map((signal) => signal.signal)).not.toContain('JOIN_VELOCITY');
  });

  it('flags similar account ages only with another recent join', () => {
    const decision = evaluate({
      join: join({ accountCreatedAt: new Date(NOW.getTime() - DAY) }),
      recentJoins: [
        join({
          userId: '555555555555555555',
          joinedAt: new Date(NOW.getTime() - 5_000),
          accountCreatedAt: new Date(NOW.getTime() - DAY - 60_000),
          hasAvatar: true,
          username: 'other',
        }),
      ],
      policy: policy({ aggregateThreshold: 99, riskThreshold: 20, minimumSignals: 2 }),
    });

    expect(decision.signals.map((signal) => signal.signal)).toContain('SIMILAR_ACCOUNT_AGE');
  });

  it('caps the score at 100', () => {
    const decision = evaluate();

    expect(decision.score).toBeLessThanOrEqual(100);
    expect(decision.score).toBeGreaterThan(0);
  });
});
