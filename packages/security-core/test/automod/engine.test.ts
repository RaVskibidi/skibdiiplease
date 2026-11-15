import { describe, expect, it } from 'vitest';

import { evaluateMessage, normalizeMessage } from '../../src/automod/engine.js';
import {
  DEFAULT_AUTOMOD_POLICY,
  type AutomodEvaluationInput,
  type AutomodMessageSnapshot,
  type AutomodPolicy,
} from '../../src/automod/types.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeMessage(overrides: Partial<AutomodMessageSnapshot> = {}): AutomodMessageSnapshot {
  return {
    id: 'message-1',
    channelId: '111111111111111111',
    userId: '222222222222222222',
    content: 'hello everyone',
    createdAt: NOW,
    mentionCount: 0,
    roleMentionCount: 0,
    mentionsEveryone: false,
    isBot: false,
    isStaff: false,
    roleIds: [],
    ...overrides,
  };
}

type InputOverrides = Omit<Partial<AutomodEvaluationInput>, 'policy'> & {
  policy?: Partial<AutomodPolicy>;
};

function makeInput(overrides: InputOverrides = {}): AutomodEvaluationInput {
  const { policy, ...rest } = overrides;
  return {
    message: makeMessage(),
    policy: { ...DEFAULT_AUTOMOD_POLICY, ...policy },
    automationMode: 'OBSERVE',
    enforcementApproved: false,
    recentMessages: [],
    warningCount: 0,
    exemption: {
      isOwner: false,
      isWhitelistedUser: false,
      isAuthorizedStaff: false,
      isExemptChannel: false,
      isExemptRole: false,
      isExemptUser: false,
    },
    ...rest,
  };
}

describe('AutoMod engine', () => {
  it('does nothing when the module is disabled', () => {
    const decision = evaluateMessage(makeInput({ policy: { enabled: false } }), NOW);
    expect(decision.matched).toBe(false);
    expect(decision.blockedReason).toBe('AUTOMOD_DISABLED');
  });

  it('records no match for an ordinary message', () => {
    const decision = evaluateMessage(makeInput(), NOW);
    expect(decision.matched).toBe(false);
    expect(decision.blockedReason).toBe('NO_MATCH');
  });

  it('detects a message flood only at the configured threshold', () => {
    const recent = Array.from({ length: 7 }, (_, index) => ({
      id: `prior-${index}`,
      content: `message ${index}`,
      createdAt: new Date(NOW.getTime() - index * 1_000),
    }));

    const below = evaluateMessage(makeInput({ recentMessages: recent.slice(0, 6) }), NOW);
    expect(below.signals.map((signal) => signal.rule)).not.toContain('FLOOD');

    const matched = evaluateMessage(makeInput({ recentMessages: recent }), NOW);
    expect(matched.signals.map((signal) => signal.rule)).toContain('FLOOD');
  });

  it('detects duplicate messages after normalising case and punctuation', () => {
    const decision = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'BUY NOW!!!' }),
        recentMessages: [
          { id: 'a', content: 'buy now', createdAt: NOW },
          { id: 'b', content: 'Buy   now...', createdAt: NOW },
        ],
      }),
      NOW,
    );

    expect(decision.signals.map((signal) => signal.rule)).toContain('DUPLICATE');
  });

  it('keeps normalised text stable without leaking it', () => {
    expect(normalizeMessage('  Hello,   WORLD!!! ')).toBe('hello world');
  });

  it('does not flag two repeated messages by default', () => {
    const decision = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'same' }),
        recentMessages: [{ id: 'a', content: 'same', createdAt: NOW }],
      }),
      NOW,
    );

    expect(decision.signals.map((signal) => signal.rule)).not.toContain('DUPLICATE');
  });

  it('detects mention spam and @everyone separately', () => {
    const mentions = evaluateMessage(makeInput({ message: makeMessage({ mentionCount: 6 }) }), NOW);
    expect(mentions.signals.map((signal) => signal.rule)).toContain('MENTION_SPAM');

    const everyone = evaluateMessage(
      makeInput({ message: makeMessage({ mentionsEveryone: true }) }),
      NOW,
    );
    expect(everyone.signals.map((signal) => signal.rule)).toContain('EVERYONE_MENTION');
  });

  it('detects excessive caps', () => {
    const decision = evaluateMessage(
      makeInput({ message: makeMessage({ content: 'THIS MESSAGE IS FAR TOO LOUD FOR ANY CHAT' }) }),
      NOW,
    );
    expect(decision.signals.map((signal) => signal.rule)).toContain('EXCESSIVE_CAPS');
  });

  it('does not flag short or mostly numeric uppercase text', () => {
    const short = evaluateMessage(makeInput({ message: makeMessage({ content: 'OK' }) }), NOW);
    expect(short.signals.map((signal) => signal.rule)).not.toContain('EXCESSIVE_CAPS');

    const numbers = evaluateMessage(
      makeInput({ message: makeMessage({ content: '1234 5678 9012 3456 7890' }) }),
      NOW,
    );
    expect(numbers.signals.map((signal) => signal.rule)).not.toContain('EXCESSIVE_CAPS');
  });

  it('detects Discord invites only when invite blocking is enabled', () => {
    const matched = evaluateMessage(
      makeInput({ message: makeMessage({ content: 'join discord.gg/example' }) }),
      NOW,
    );
    expect(matched.signals.map((signal) => signal.rule)).toContain('INVITE_LINK');

    const disabled = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'join discord.gg/example' }),
        policy: { inviteLinksBlocked: false },
      }),
      NOW,
    );
    expect(disabled.signals.map((signal) => signal.rule)).not.toContain('INVITE_LINK');
  });

  it('blocks exact and subdomain links but allows unlisted domains', () => {
    const blocked = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'see https://cdn.bad.example/path' }),
        policy: { blockedDomains: ['bad.example'] },
      }),
      NOW,
    );
    expect(blocked.signals.map((signal) => signal.rule)).toContain('BLOCKED_LINK');

    const allowed = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'see https://good.example/path' }),
        policy: { blockedDomains: ['bad.example'] },
      }),
      NOW,
    );
    expect(allowed.signals.map((signal) => signal.rule)).not.toContain('BLOCKED_LINK');
  });

  it('does not treat a malformed link as a blocked domain', () => {
    const decision = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'https://' }),
        policy: { blockedDomains: ['bad.example'] },
      }),
      NOW,
    );
    expect(decision.signals.map((signal) => signal.rule)).not.toContain('BLOCKED_LINK');
  });

  it('matches blocked words at boundaries to avoid substring false positives', () => {
    const matched = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'what an ass' }),
        policy: { bannedWords: ['ass'] },
      }),
      NOW,
    );
    expect(matched.signals.map((signal) => signal.rule)).toContain('BLOCKED_WORD');

    const substring = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'a classic assignment' }),
        policy: { bannedWords: ['ass'] },
      }),
      NOW,
    );
    expect(substring.signals.map((signal) => signal.rule)).not.toContain('BLOCKED_WORD');
  });

  it('observes a match without deleting, warning, or timing out', () => {
    const decision = evaluateMessage(
      makeInput({ message: makeMessage({ content: 'discord.gg/raid' }) }),
      NOW,
    );

    expect(decision.matched).toBe(true);
    expect(decision.score).toBeGreaterThan(0);
    expect(decision.recommendedAction).toBe('WARN');
    expect(decision.effectiveAction).toBe('NONE');
    expect(decision.deleteMessage).toBe(false);
    expect(decision.blockedReason).toBe('OBSERVE_MODE');
  });

  it('blocks enforcement when owner approval is missing', () => {
    const decision = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'discord.gg/raid' }),
        automationMode: 'ENFORCE_REVERSIBLE',
      }),
      NOW,
    );

    expect(decision.effectiveAction).toBe('NONE');
    expect(decision.blockedReason).toBe('OWNER_APPROVAL_REQUIRED');
  });

  it('issues a warning, not a timeout, for a first low-confidence message', () => {
    const decision = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'discord.gg/raid' }),
        automationMode: 'ENFORCE_REVERSIBLE',
        enforcementApproved: true,
      }),
      NOW,
    );

    expect(decision.effectiveAction).toBe('WARN');
    expect(decision.warn).toBe(true);
    expect(decision.deleteMessage).toBe(true);
    expect(decision.timeoutSeconds).toBeNull();
  });

  it('times out once the configured warning count is reached', () => {
    const decision = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'discord.gg/raid' }),
        automationMode: 'ENFORCE_REVERSIBLE',
        enforcementApproved: true,
        warningCount: 2,
      }),
      NOW,
    );

    expect(decision.recommendedAction).toBe('TIMEOUT');
    expect(decision.effectiveAction).toBe('TIMEOUT');
    expect(decision.timeoutSeconds).toBe(600);
  });

  it('blocks a first-message timeout unless a high-confidence rule is configured', () => {
    const decision = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'discord.gg/raid' }),
        policy: { timeoutAfterWarnings: 1 },
        automationMode: 'ENFORCE_DESTRUCTIVE',
        enforcementApproved: true,
      }),
      NOW,
    );

    expect(decision.blockedReason).toBe('SINGLE_MESSAGE_TIMEOUT_BLOCKED');
    expect(decision.effectiveAction).toBe('NONE');
  });

  it('allows an explicitly configured high-confidence first-message timeout', () => {
    const decision = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'discord.gg/raid' }),
        policy: { timeoutAfterWarnings: 1, highConfidenceRules: ['INVITE_LINK'] },
        automationMode: 'ENFORCE_DESTRUCTIVE',
        enforcementApproved: true,
      }),
      NOW,
    );

    expect(decision.highConfidence).toBe(true);
    expect(decision.effectiveAction).toBe('TIMEOUT');
  });

  it('exempts owner, whitelist, channel, role, user, and staff', () => {
    const cases: Array<[Partial<AutomodEvaluationInput['exemption']>, string]> = [
      [{ isOwner: true }, 'OWNER'],
      [{ isWhitelistedUser: true }, 'WHITELISTED'],
      [{ isExemptChannel: true }, 'EXEMPT_CHANNEL'],
      [{ isExemptRole: true }, 'EXEMPT_ROLE'],
      [{ isExemptUser: true }, 'EXEMPT_USER'],
      [{ isAuthorizedStaff: true }, 'STAFF'],
    ];

    for (const [exemption, reason] of cases) {
      const decision = evaluateMessage(
        makeInput({
          message: makeMessage({ content: 'discord.gg/raid' }),
          exemption: {
            isOwner: false,
            isWhitelistedUser: false,
            isAuthorizedStaff: false,
            isExemptChannel: false,
            isExemptRole: false,
            isExemptUser: false,
            ...exemption,
          },
        }),
        NOW,
      );
      expect(decision.blockedReason).toBe(reason);
    }
  });

  it('respects configured channel, role, and user exemption lists', () => {
    const basePolicy: Partial<AutomodPolicy> = {
      exemptChannelIds: ['111111111111111111'],
      exemptRoleIds: ['333333333333333333'],
      exemptUserIds: ['222222222222222222'],
    };

    const channel = evaluateMessage(makeInput({ policy: basePolicy }), NOW);
    expect(channel.blockedReason).toBe('EXEMPT_CHANNEL');

    const role = evaluateMessage(
      makeInput({
        message: makeMessage({ roleIds: ['333333333333333333'] }),
        policy: { ...basePolicy, exemptChannelIds: [] },
      }),
      NOW,
    );
    expect(role.blockedReason).toBe('EXEMPT_ROLE');

    const user = evaluateMessage(
      makeInput({
        policy: { ...basePolicy, exemptChannelIds: [], exemptRoleIds: [] },
      }),
      NOW,
    );
    expect(user.blockedReason).toBe('EXEMPT_USER');
  });

  it('caps the risk score at 100 while retaining every signal', () => {
    const decision = evaluateMessage(
      makeInput({
        message: makeMessage({
          content: 'DISCORD.GG/RAID BADWORD @everyone',
          mentionCount: 10,
          mentionsEveryone: true,
        }),
        policy: { bannedWords: ['badword'], blockedDomains: [] },
        recentMessages: Array.from({ length: 8 }, (_, index) => ({
          id: `prior-${index}`,
          content: 'DISCORD.GG/RAID BADWORD @everyone',
          createdAt: NOW,
        })),
      }),
      NOW,
    );

    expect(decision.signals.length).toBeGreaterThan(3);
    expect(decision.score).toBe(100);
  });

  it('does not delete anything in observe mode even when deletion is configured', () => {
    const decision = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'discord.gg/raid' }),
        policy: { deleteOffendingMessage: true },
      }),
      NOW,
    );

    expect(decision.deleteMessage).toBe(false);
  });

  it('reports no configured action when warnings and timeouts are disabled', () => {
    const decision = evaluateMessage(
      makeInput({
        message: makeMessage({ content: 'discord.gg/raid' }),
        policy: { warnEnabled: false, timeoutEnabled: false },
        automationMode: 'ENFORCE_REVERSIBLE',
        enforcementApproved: true,
      }),
      NOW,
    );

    expect(decision.matched).toBe(true);
    expect(decision.effectiveAction).toBe('NONE');
    expect(decision.blockedReason).toBe('NO_ACTION_CONFIGURED');
  });
});
