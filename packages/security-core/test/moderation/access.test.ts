import { describe, expect, it } from 'vitest';

import {
  authorizeModeration,
  canViewModeration,
  deniedReasonMessage,
  DISCORD_PERMISSION_BITS,
  type ModerationAction,
  type ModerationActor,
  type ModerationBot,
  type ModerationTarget,
} from '../../src/moderation/access.js';
import {
  DEFAULT_WARNING_ESCALATION,
  MAX_TIMEOUT_SECONDS,
  parseDuration,
  validateTimeoutDuration,
  warningEscalation,
} from '../../src/moderation/durations.js';
import {
  normalizePermissionKeys,
  T77_PERMISSION_KEYS,
  T77_PERMISSIONS,
} from '../../src/moderation/permissions.js';

const ACTOR: ModerationActor = {
  userId: '100000000000000001',
  isOwner: false,
  highestRolePosition: 10,
  permissions:
    DISCORD_PERMISSION_BITS.BanMembers |
    DISCORD_PERMISSION_BITS.KickMembers |
    DISCORD_PERMISSION_BITS.ModerateMembers,
  grantedPermissions: [],
};

const TARGET: ModerationTarget = {
  userId: '200000000000000002',
  isOwner: false,
  highestRolePosition: 5,
  isBot: false,
};

const BOT: ModerationBot = {
  userId: '300000000000000003',
  highestRolePosition: 20,
  permissions:
    DISCORD_PERMISSION_BITS.BanMembers |
    DISCORD_PERMISSION_BITS.KickMembers |
    DISCORD_PERMISSION_BITS.ModerateMembers,
};

function input(
  overrides: {
    action?: ModerationAction;
    actor?: Partial<ModerationActor>;
    target?: Partial<ModerationTarget>;
    bot?: Partial<ModerationBot>;
  } = {},
) {
  return {
    action: overrides.action ?? ('BAN' as const),
    actor: { ...ACTOR, ...overrides.actor },
    target: { ...TARGET, ...overrides.target },
    bot: { ...BOT, ...overrides.bot },
  };
}

describe('moderation authorization', () => {
  it('allows a permitted moderator above the target', () => {
    expect(authorizeModeration(input())).toEqual({ allowed: true });
  });

  it('refuses self moderation', () => {
    expect(authorizeModeration(input({ target: { userId: ACTOR.userId } }))).toEqual({
      allowed: false,
      reason: 'SELF_TARGET',
    });
  });

  it('refuses the guild owner as a target', () => {
    expect(authorizeModeration(input({ target: { isOwner: true } }))).toEqual({
      allowed: false,
      reason: 'TARGET_IS_OWNER',
    });
  });

  it('refuses a target at or above the actor', () => {
    expect(authorizeModeration(input({ target: { highestRolePosition: 10 } }))).toEqual({
      allowed: false,
      reason: 'ACTOR_BELOW_TARGET',
    });
  });

  it('refuses a target at or above the T77 bot', () => {
    expect(authorizeModeration(input({ bot: { highestRolePosition: 5 } }))).toEqual({
      allowed: false,
      reason: 'BOT_BELOW_TARGET',
    });
  });

  it('allows the owner to act even without Discord permissions', () => {
    expect(
      authorizeModeration(
        input({ actor: { isOwner: true, permissions: 0n, highestRolePosition: 1 } }),
      ),
    ).toEqual({ allowed: true });
  });

  it('still requires T77 to outrank the target for the owner', () => {
    expect(
      authorizeModeration(
        input({
          actor: { isOwner: true, permissions: 0n },
          bot: { highestRolePosition: 1 },
        }),
      ),
    ).toEqual({ allowed: false, reason: 'BOT_BELOW_TARGET' });
  });

  it('requires the Discord permission for a ban', () => {
    expect(authorizeModeration(input({ actor: { permissions: 0n } }))).toEqual({
      allowed: false,
      reason: 'MISSING_T77_PERMISSION',
    });
  });

  it('accepts an explicit T77 grant instead of a Discord permission', () => {
    expect(
      authorizeModeration(
        input({
          actor: {
            permissions: 0n,
            grantedPermissions: [T77_PERMISSIONS.MODERATION_BAN],
          },
          action: 'BAN',
        }),
      ),
    ).toEqual({ allowed: true });
  });

  it('a T77 grant never bypasses hierarchy', () => {
    expect(
      authorizeModeration(
        input({
          actor: {
            permissions: 0n,
            grantedPermissions: [T77_PERMISSIONS.MODERATION_BAN],
            highestRolePosition: 3,
          },
          target: { highestRolePosition: 5 },
        }),
      ),
    ).toEqual({ allowed: false, reason: 'ACTOR_BELOW_TARGET' });
  });

  it('requires the bot to hold the API permission', () => {
    expect(authorizeModeration(input({ bot: { permissions: 0n } }))).toEqual({
      allowed: false,
      reason: 'MISSING_BOT_PERMISSION',
    });
  });

  it('allows warning a bot but not kicking it', () => {
    expect(authorizeModeration(input({ action: 'WARN', target: { isBot: true } }))).toEqual({
      allowed: true,
    });
    expect(authorizeModeration(input({ action: 'KICK', target: { isBot: true } }))).toEqual({
      allowed: false,
      reason: 'TARGET_IS_BOT',
    });
  });

  it('returns a user-facing message for every denial', () => {
    for (const reason of [
      'SELF_TARGET',
      'TARGET_IS_OWNER',
      'TARGET_IS_BOT',
      'ACTOR_BELOW_TARGET',
      'BOT_BELOW_TARGET',
      'MISSING_DISCORD_PERMISSION',
      'MISSING_T77_PERMISSION',
      'MISSING_BOT_PERMISSION',
    ] as const) {
      expect(deniedReasonMessage(reason).length).toBeGreaterThan(10);
    }
  });

  it('gates the moderation console', () => {
    expect(canViewModeration({ isOwner: false, permissions: 0n, grantedPermissions: [] })).toBe(
      false,
    );
    expect(
      canViewModeration({
        isOwner: false,
        permissions: DISCORD_PERMISSION_BITS.ModerateMembers,
        grantedPermissions: [],
      }),
    ).toBe(true);
    expect(
      canViewModeration({
        isOwner: false,
        permissions: 0n,
        grantedPermissions: ['moderation.view'],
      }),
    ).toBe(true);
  });
});

describe('moderation durations', () => {
  it('parses compact durations', () => {
    expect(parseDuration('30m')).toEqual({ seconds: 1_800, normalised: '30m' });
    expect(parseDuration('12h')).toEqual({ seconds: 43_200, normalised: '12h' });
    expect(parseDuration('7d')).toEqual({ seconds: 604_800, normalised: '7d' });
    expect(parseDuration('2w')).toEqual({ seconds: 1_209_600, normalised: '2w' });
    expect(parseDuration('45')).toEqual({ seconds: 45, normalised: '45s' });
  });

  it('rejects malformed or zero durations', () => {
    expect(parseDuration('0m')).toBeNull();
    expect(parseDuration('-5m')).toBeNull();
    expect(parseDuration('five minutes')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });

  it('bounds Discord timeouts', () => {
    expect(validateTimeoutDuration(30)).toEqual({
      valid: false,
      reason: 'TOO_SHORT',
      seconds: 30,
    });
    expect(validateTimeoutDuration(MAX_TIMEOUT_SECONDS + 1)).toEqual({
      valid: false,
      reason: 'TOO_LONG',
      seconds: MAX_TIMEOUT_SECONDS + 1,
    });
    expect(validateTimeoutDuration(600)).toEqual({ valid: true, seconds: 600 });
  });

  it('produces advisory warning escalation only', () => {
    expect(warningEscalation(0)).toBe('NONE');
    expect(warningEscalation(DEFAULT_WARNING_ESCALATION.timeoutAtWarnings)).toBe('TIMEOUT');
    expect(warningEscalation(DEFAULT_WARNING_ESCALATION.kickAtWarnings)).toBe('KICK');
    expect(warningEscalation(DEFAULT_WARNING_ESCALATION.banAtWarnings)).toBe('BAN');
    expect(warningEscalation(-1)).toBe('NONE');
  });
});

describe('T77 permission catalogue', () => {
  it('normalises duplicates and rejects unknown keys', () => {
    expect(normalizePermissionKeys(['moderation.warn', 'moderation.warn', 'staff.manage'])).toEqual(
      ['moderation.warn', 'staff.manage'],
    );
    expect(() => normalizePermissionKeys(['moderation.root'])).toThrow(/Unknown/);
  });

  it('exposes every declared key exactly once', () => {
    expect(new Set(T77_PERMISSION_KEYS).size).toBe(T77_PERMISSION_KEYS.length);
  });
});
