import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BEAST_MODE_POLICY,
  computeBeastScore,
  evaluateBeastActor,
  transitionBeastState,
  type BeastRiskContribution,
} from '../../src/index.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function contribution(overrides: Partial<BeastRiskContribution> = {}): BeastRiskContribution {
  return {
    eventId: 'evt-1',
    actorId: '111111111111111111',
    at: NOW,
    weight: 40,
    counted: true,
    authorized: false,
    isOwner: false,
    destructive: false,
    ...overrides,
  };
}

describe('evaluateBeastActor', () => {
  it('contributes an unauthorized, attributable action', () => {
    const result = evaluateBeastActor(contribution(), DEFAULT_BEAST_MODE_POLICY);

    expect(result.contributes).toBe(true);
    expect(result.weight).toBe(40);
    expect(result.heightenedScrutiny).toBe(true);
    expect(result.blockedReason).toBeNull();
  });

  it('never counts the owner', () => {
    const result = evaluateBeastActor(contribution({ isOwner: true }), DEFAULT_BEAST_MODE_POLICY);

    expect(result.contributes).toBe(false);
    expect(result.blockedReason).toBe('OWNER');
    expect(result.heightenedScrutiny).toBe(false);
  });

  it('never counts authorized staff merely because Beast Mode is active', () => {
    const result = evaluateBeastActor(
      contribution({ authorized: true }),
      DEFAULT_BEAST_MODE_POLICY,
    );

    expect(result.contributes).toBe(false);
    expect(result.blockedReason).toBe('AUTHORIZED_ACTOR');
    expect(result.heightenedScrutiny).toBe(false);
  });

  it('ignores uncounted or unattributed events', () => {
    expect(
      evaluateBeastActor(contribution({ counted: false }), DEFAULT_BEAST_MODE_POLICY).blockedReason,
    ).toBe('NOT_COUNTED');
    expect(
      evaluateBeastActor(contribution({ actorId: null }), DEFAULT_BEAST_MODE_POLICY).blockedReason,
    ).toBe('NO_ACTOR');
  });

  it('is inert when Beast Mode is disabled', () => {
    const result = evaluateBeastActor(contribution(), {
      ...DEFAULT_BEAST_MODE_POLICY,
      enabled: false,
    });

    expect(result.contributes).toBe(false);
    expect(result.blockedReason).toBe('BEAST_DISABLED');
  });
});

describe('computeBeastScore', () => {
  it('sums authorized and unauthorized contributions but only counts the latter', () => {
    const score = computeBeastScore(
      [
        contribution({ eventId: 'a', weight: 40 }),
        contribution({ eventId: 'b', weight: 40, authorized: true }),
        contribution({ eventId: 'c', weight: 30, isOwner: true }),
      ],
      DEFAULT_BEAST_MODE_POLICY,
      NOW,
    );

    expect(score).toBe(40);
  });

  it('aggregates multiple unauthorized actors', () => {
    const score = computeBeastScore(
      [
        contribution({ eventId: 'a', actorId: '1', weight: 35 }),
        contribution({ eventId: 'b', actorId: '2', weight: 35 }),
        contribution({ eventId: 'c', actorId: '3', weight: 35 }),
      ],
      DEFAULT_BEAST_MODE_POLICY,
      NOW,
    );

    expect(score).toBe(105);
  });

  it('decays and excludes old contributions', () => {
    const fresh = computeBeastScore([contribution({ at: NOW })], DEFAULT_BEAST_MODE_POLICY, NOW);
    const halfWindow = computeBeastScore(
      [contribution({ at: new Date(NOW.getTime() - 450_000) })],
      DEFAULT_BEAST_MODE_POLICY,
      NOW,
    );
    const stale = computeBeastScore(
      [contribution({ at: new Date(NOW.getTime() - 901_000) })],
      DEFAULT_BEAST_MODE_POLICY,
      NOW,
    );

    expect(fresh).toBe(40);
    expect(halfWindow).toBe(20);
    expect(stale).toBe(0);
  });
});

describe('transitionBeastState', () => {
  const policy = { ...DEFAULT_BEAST_MODE_POLICY, threshold: 100, durationMinutes: 60 };

  it('activates at the threshold and sets an expiry', () => {
    const transition = transitionBeastState({
      policy,
      state: { active: false, score: 0, activatedAt: null, expiresAt: null },
      score: 100,
      now: NOW,
    });

    expect(transition.shouldActivate).toBe(true);
    expect(transition.expiresAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    );
  });

  it('does not activate below the threshold', () => {
    const transition = transitionBeastState({
      policy,
      state: { active: false, score: 0, activatedAt: null, expiresAt: null },
      score: 99,
      now: NOW,
    });

    expect(transition.shouldActivate).toBe(false);
  });

  it('deactivates an expired activation', () => {
    const transition = transitionBeastState({
      policy,
      state: {
        active: true,
        score: 120,
        activatedAt: new Date(NOW.getTime() - 3_600_000),
        expiresAt: new Date(NOW.getTime() - 1),
      },
      score: 120,
      now: NOW,
    });

    expect(transition.shouldDeactivate).toBe(true);
    expect(transition.score).toBe(0);
  });

  it('keeps an active window until it expires', () => {
    const transition = transitionBeastState({
      policy,
      state: {
        active: true,
        score: 120,
        activatedAt: new Date(NOW.getTime() - 60_000),
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
      score: 120,
      now: NOW,
    });

    expect(transition.shouldActivate).toBe(false);
    expect(transition.shouldDeactivate).toBe(false);
    expect(transition.expiresAt).not.toBeNull();
  });

  it('does not activate when disabled', () => {
    const transition = transitionBeastState({
      policy: { ...policy, enabled: false },
      state: { active: false, score: 0, activatedAt: null, expiresAt: null },
      score: 500,
      now: NOW,
    });

    expect(transition.shouldActivate).toBe(false);
    expect(transition.blockedReason).toBe('BEAST_DISABLED');
  });
});
