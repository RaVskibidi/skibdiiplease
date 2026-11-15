import { describe, expect, it } from 'vitest';

import {
  ANTI_NUKE_ACTIONS,
  AntiNukeEngine,
  actionDefinition,
  defaultAntiNukeRules,
  type ActorAuthorization,
  type AntiNukeRuleConfig,
  type NormalizedSecurityAction,
} from '../../src/index.js';

const GUILD_ID = '111111111111111111';
const ACTOR_ID = '222222222222222222';
const OWNER_ID = '333333333333333333';
const TARGET_ID = '555555555555555555';

function ruleFor(
  action: (typeof ANTI_NUKE_ACTIONS)[number],
  overrides: Partial<AntiNukeRuleConfig> = {},
): AntiNukeRuleConfig {
  const definition = actionDefinition(action);
  return {
    action,
    enabled: true,
    threshold: definition.defaultThreshold,
    windowSeconds: definition.defaultWindowSeconds,
    containment: definition.defaultContainment,
    requiresDestructiveApproval: definition.defaultRequiresDestructiveApproval,
    cooldownSeconds: definition.defaultCooldownSeconds,
    ...overrides,
  };
}

function authorization(overrides: Partial<ActorAuthorization> = {}): ActorAuthorization {
  return {
    actorId: ACTOR_ID,
    isOwner: false,
    isSelf: false,
    isBot: false,
    actorRolePosition: 2,
    botRolePosition: 10,
    whitelist: {
      globalUser: false,
      actionUser: false,
      globalRole: false,
      actionRole: false,
      targetChannel: false,
    },
    isAuthorizedStaff: false,
    targetBotApproved: false,
    enforcementApproved: false,
    ...overrides,
  };
}

let sequence = 0;

function eventFor(
  action: (typeof ANTI_NUKE_ACTIONS)[number],
  occurredAt: Date,
  overrides: Partial<NormalizedSecurityAction> = {},
): NormalizedSecurityAction {
  sequence += 1;
  return {
    eventId: `audit-${sequence}`,
    guildId: GUILD_ID,
    action,
    actorId: ACTOR_ID,
    targetId: TARGET_ID,
    occurredAt,
    source: 'AUDIT_LOG',
    attribution: 'CERTAIN',
    ...overrides,
  };
}

function at(seconds: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
}

describe('AntiNukeEngine thresholds and scoring', () => {
  it('covers every monitored action', () => {
    for (const action of ANTI_NUKE_ACTIONS) {
      const engine = new AntiNukeEngine({ clock: () => at(0) });
      const decision = engine.evaluate({
        event: eventFor(action, at(0)),
        rule: ruleFor(action),
        authorization: authorization(),
        automationMode: 'OBSERVE',
      });

      expect(decision.action).toBe(action);
      expect(decision.counted).toBe(true);
      expect(decision.count).toBe(1);
      expect(decision.riskScore).toBeGreaterThan(0);
    }
  });

  it('triggers exactly at the threshold, not before', () => {
    const engine = new AntiNukeEngine({ clock: () => at(0) });
    const rule = ruleFor('MEMBER_BAN', { threshold: 3, windowSeconds: 60, containment: 'ALERT' });

    const first = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(0)),
      rule,
      authorization: authorization(),
      automationMode: 'OBSERVE',
    });
    const second = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(10)),
      rule,
      authorization: authorization(),
      automationMode: 'OBSERVE',
    });
    const third = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(20)),
      rule,
      authorization: authorization(),
      automationMode: 'OBSERVE',
    });

    expect(first.count).toBe(1);
    expect(first.thresholdExceeded).toBe(false);
    expect(second.count).toBe(2);
    expect(second.thresholdExceeded).toBe(false);
    expect(third.count).toBe(3);
    expect(third.thresholdExceeded).toBe(true);
    expect(third.shouldOpenIncident).toBe(true);
  });

  it('ignores events outside the configured window', () => {
    const engine = new AntiNukeEngine({ clock: () => at(120) });
    const rule = ruleFor('CHANNEL_DELETE', {
      threshold: 2,
      windowSeconds: 60,
      containment: 'ALERT',
    });

    engine.evaluate({
      event: eventFor('CHANNEL_DELETE', at(0)),
      rule,
      authorization: authorization(),
      automationMode: 'OBSERVE',
    });
    const second = engine.evaluate({
      event: eventFor('CHANNEL_DELETE', at(120)),
      rule,
      authorization: authorization(),
      automationMode: 'OBSERVE',
    });

    expect(second.count).toBe(1);
    expect(second.thresholdExceeded).toBe(false);
  });

  it('separates counters per actor and per action', () => {
    const engine = new AntiNukeEngine({ clock: () => at(0) });
    const banRule = ruleFor('MEMBER_BAN', {
      threshold: 2,
      windowSeconds: 60,
      containment: 'ALERT',
    });
    const kickRule = ruleFor('MEMBER_KICK', {
      threshold: 2,
      windowSeconds: 60,
      containment: 'ALERT',
    });

    engine.evaluate({
      event: eventFor('MEMBER_BAN', at(0)),
      rule: banRule,
      authorization: authorization(),
      automationMode: 'OBSERVE',
    });
    const otherActor = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(1), { actorId: '999999999999999999' }),
      rule: banRule,
      authorization: authorization({ actorId: '999999999999999999' }),
      automationMode: 'OBSERVE',
    });
    const otherAction = engine.evaluate({
      event: eventFor('MEMBER_KICK', at(2)),
      rule: kickRule,
      authorization: authorization(),
      automationMode: 'OBSERVE',
    });

    expect(otherActor.count).toBe(1);
    expect(otherAction.count).toBe(1);
  });

  it('scores risk with decay and reports severity', () => {
    const engine = new AntiNukeEngine({ clock: () => at(30), riskWindowSeconds: 60 });
    const rule = ruleFor('ADMINISTRATOR_GRANT', {
      threshold: 5,
      windowSeconds: 300,
      containment: 'ALERT',
    });

    const decision = engine.evaluate({
      event: eventFor('ADMINISTRATOR_GRANT', at(0)),
      rule,
      authorization: authorization(),
      automationMode: 'OBSERVE',
    });

    // 45 base weight with 50% of its 60s risk window elapsed.
    expect(decision.riskScore).toBe(23);
    expect(decision.severity).toBe('MEDIUM');
  });
});

describe('AntiNukeEngine safety gates', () => {
  it('never enforces on a single event, even with a threshold of one', () => {
    const engine = new AntiNukeEngine({ clock: () => at(0) });
    const rule = ruleFor('MEMBER_BAN', {
      threshold: 1,
      containment: 'BAN',
      requiresDestructiveApproval: true,
    });

    const decision = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(0)),
      rule,
      authorization: authorization({ enforcementApproved: true }),
      automationMode: 'ENFORCE_DESTRUCTIVE',
    });

    expect(decision.thresholdExceeded).toBe(true);
    expect(decision.effectiveContainment).toBeNull();
    expect(decision.blockedReason).toBe('INSUFFICIENT_EVENTS');
    expect(decision.wouldHaveActed).toBe(false);
  });

  it('never enforces from uncertain audit attribution', () => {
    const engine = new AntiNukeEngine({ clock: () => at(0) });
    const decision = engine.evaluate({
      event: eventFor('CHANNEL_DELETE', at(0), {
        actorId: null,
        attribution: 'UNCERTAIN',
      }),
      rule: ruleFor('CHANNEL_DELETE', { containment: 'BAN', threshold: 1 }),
      authorization: authorization({ enforcementApproved: true }),
      automationMode: 'ENFORCE_DESTRUCTIVE',
    });

    expect(decision.counted).toBe(false);
    expect(decision.effectiveContainment).toBeNull();
    expect(decision.blockedReason).toBe('UNCERTAIN_ATTRIBUTION');
    expect(decision.shouldAlert).toBe(true);
  });

  it('observes by default and records would-have-acted intent', () => {
    const engine = new AntiNukeEngine({ clock: () => at(0) });
    const rule = ruleFor('MEMBER_BAN', { threshold: 2, containment: 'BAN', windowSeconds: 60 });

    engine.evaluate({
      event: eventFor('MEMBER_BAN', at(0)),
      rule,
      authorization: authorization({ enforcementApproved: true }),
      automationMode: 'OBSERVE',
    });
    const decision = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(1)),
      rule,
      authorization: authorization({ enforcementApproved: true }),
      automationMode: 'OBSERVE',
    });

    expect(decision.effectiveContainment).toBeNull();
    expect(decision.blockedReason).toBe('OBSERVE_MODE');
    expect(decision.wouldHaveActed).toBe(true);
  });

  it('requires destructive mode and recorded approval for bans', () => {
    const engine = new AntiNukeEngine({ clock: () => at(0) });
    const rule = ruleFor('MEMBER_BAN', { threshold: 2, containment: 'BAN', windowSeconds: 60 });

    engine.evaluate({
      event: eventFor('MEMBER_BAN', at(0)),
      rule,
      authorization: authorization({ enforcementApproved: true }),
      automationMode: 'ENFORCE_REVERSIBLE',
    });
    const reversibleOnly = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(1)),
      rule,
      authorization: authorization({ enforcementApproved: true }),
      automationMode: 'ENFORCE_REVERSIBLE',
    });

    expect(reversibleOnly.effectiveContainment).toBeNull();
    expect(reversibleOnly.blockedReason).toBe('DESTRUCTIVE_MODE_REQUIRED');

    const unapprovedEngine = new AntiNukeEngine({ clock: () => at(0) });
    unapprovedEngine.evaluate({
      event: eventFor('MEMBER_BAN', at(0)),
      rule,
      authorization: authorization({ enforcementApproved: false }),
      automationMode: 'ENFORCE_DESTRUCTIVE',
    });
    const unapproved = unapprovedEngine.evaluate({
      event: eventFor('MEMBER_BAN', at(1)),
      rule,
      authorization: authorization({ enforcementApproved: false }),
      automationMode: 'ENFORCE_DESTRUCTIVE',
    });

    expect(unapproved.effectiveContainment).toBeNull();
    expect(unapproved.blockedReason).toBe('OWNER_APPROVAL_REQUIRED');
  });

  it('applies approved destructive containment after two certain events', () => {
    const engine = new AntiNukeEngine({ clock: () => at(1) });
    const rule = ruleFor('MEMBER_BAN', { threshold: 2, containment: 'BAN', windowSeconds: 60 });

    engine.evaluate({
      event: eventFor('MEMBER_BAN', at(0)),
      rule,
      authorization: authorization({ enforcementApproved: true }),
      automationMode: 'ENFORCE_DESTRUCTIVE',
    });
    const decision = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(1)),
      rule,
      authorization: authorization({ enforcementApproved: true }),
      automationMode: 'ENFORCE_DESTRUCTIVE',
    });

    expect(decision.effectiveContainment).toBe('BAN');
    expect(decision.blockedReason).toBeNull();
    expect(decision.wouldHaveActed).toBe(true);
  });

  it('respects hierarchy and never recommends enforcement above the bot', () => {
    const engine = new AntiNukeEngine({ clock: () => at(1) });
    const rule = ruleFor('MEMBER_BAN', { threshold: 2, containment: 'KICK', windowSeconds: 60 });
    const admin = authorization({ actorRolePosition: 20, botRolePosition: 10 });

    engine.evaluate({
      event: eventFor('MEMBER_BAN', at(0)),
      rule,
      authorization: admin,
      automationMode: 'ENFORCE_DESTRUCTIVE',
    });
    const decision = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(1)),
      rule,
      authorization: admin,
      automationMode: 'ENFORCE_DESTRUCTIVE',
    });

    expect(decision.effectiveContainment).toBeNull();
    expect(decision.blockedReason).toBe('HIERARCHY');
    expect(decision.wouldHaveActed).toBe(false);
    expect(decision.shouldAlert).toBe(true);
  });

  it('suppresses repeat containment during cooldown to prevent response loops', () => {
    const engine = new AntiNukeEngine({
      clock: () => at(3),
      actorResponseCooldownSeconds: 60,
    });
    const rule = ruleFor('MEMBER_BAN', {
      threshold: 2,
      containment: 'KICK',
      windowSeconds: 60,
      cooldownSeconds: 300,
    });

    engine.evaluate({
      event: eventFor('MEMBER_BAN', at(0)),
      rule,
      authorization: authorization({ enforcementApproved: true }),
      automationMode: 'ENFORCE_DESTRUCTIVE',
    });
    const firstEnforcement = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(1)),
      rule,
      authorization: authorization({ enforcementApproved: true }),
      automationMode: 'ENFORCE_DESTRUCTIVE',
    });
    const duringCooldown = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(2)),
      rule,
      authorization: authorization({ enforcementApproved: true }),
      automationMode: 'ENFORCE_DESTRUCTIVE',
    });

    expect(firstEnforcement.effectiveContainment).toBe('KICK');
    expect(duringCooldown.effectiveContainment).toBeNull();
    expect(duringCooldown.blockedReason).toBe('COOLDOWN_ACTIVE');
  });
});

describe('AntiNukeEngine exemptions', () => {
  it.each([
    ['server owner', authorization({ isOwner: true })],
    ['T77 self action', authorization({ isSelf: true })],
    [
      'global user whitelist',
      authorization({ whitelist: { ...authorization().whitelist, globalUser: true } }),
    ],
    [
      'action user whitelist',
      authorization({ whitelist: { ...authorization().whitelist, actionUser: true } }),
    ],
    [
      'global role whitelist',
      authorization({ whitelist: { ...authorization().whitelist, globalRole: true } }),
    ],
    [
      'action role whitelist',
      authorization({ whitelist: { ...authorization().whitelist, actionRole: true } }),
    ],
    [
      'target channel whitelist',
      authorization({ whitelist: { ...authorization().whitelist, targetChannel: true } }),
    ],
    ['authorized staff', authorization({ isAuthorizedStaff: true })],
    ['approved bot', authorization({ targetBotApproved: true })],
  ])('exempts %s without counting or alerting', (_label, auth) => {
    const engine = new AntiNukeEngine({ clock: () => at(0) });
    const decision = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(0)),
      rule: ruleFor('MEMBER_BAN', { containment: 'BAN' }),
      authorization: auth,
      automationMode: 'ENFORCE_DESTRUCTIVE',
    });

    expect(decision.counted).toBe(false);
    expect(decision.exemption).not.toBeNull();
    expect(decision.shouldAlert).toBe(false);
    expect(decision.effectiveContainment).toBeNull();
  });

  it('does not count a disabled rule', () => {
    const engine = new AntiNukeEngine({ clock: () => at(0) });
    const decision = engine.evaluate({
      event: eventFor('MEMBER_BAN', at(0)),
      rule: ruleFor('MEMBER_BAN', { enabled: false }),
      authorization: authorization(),
      automationMode: 'OBSERVE',
    });

    expect(decision.exemption).toBe('RULE_DISABLED');
    expect(decision.counted).toBe(false);
  });

  it('treats the owner as exempt even when destructive mode is active', () => {
    const engine = new AntiNukeEngine({ clock: () => at(1) });
    const rule = ruleFor('MEMBER_BAN', { threshold: 2, containment: 'BAN', windowSeconds: 60 });
    const owner = authorization({ actorId: OWNER_ID, isOwner: true, enforcementApproved: true });

    for (let index = 0; index < 5; index += 1) {
      const decision = engine.evaluate({
        event: eventFor('MEMBER_BAN', at(index), { actorId: OWNER_ID }),
        rule,
        authorization: owner,
        automationMode: 'ENFORCE_DESTRUCTIVE',
      });
      expect(decision.exemption).toBe('SERVER_OWNER');
      expect(decision.effectiveContainment).toBeNull();
    }
  });
});

describe('default rule catalog', () => {
  it('ships a default rule for every action, all observation-safe', () => {
    const rules = defaultAntiNukeRules();

    expect(rules).toHaveLength(ANTI_NUKE_ACTIONS.length);
    expect(new Set(rules.map((rule) => rule.action)).size).toBe(ANTI_NUKE_ACTIONS.length);
    for (const rule of rules) {
      expect(rule.enabled).toBe(true);
      expect(rule.containment).toBe('ALERT');
      expect(rule.threshold).toBeGreaterThan(0);
      expect(rule.windowSeconds).toBeGreaterThan(0);
    }
  });
});
