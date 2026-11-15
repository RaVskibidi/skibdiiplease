import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { BeastRiskContribution, RaidJoinRecord } from '@t77/security-core';

import {
  BeastStateStore,
  RaidJoinWindowStore,
  RedisAntiNukeCounterStore,
  RedisConnection,
  SecurityStateKeys,
} from '../../src/index.js';
import {
  ACTOR_ID,
  GUILD_A,
  GUILD_B,
  TARGET_ID,
  TEST_REDIS_URL,
  redisEnabled,
  resetRedis,
} from './helpers.js';

const describeIntegration = redisEnabled ? describe : describe.skip;

describeIntegration('Phase 5 Redis security state', () => {
  let redis: RedisConnection;
  let keys: SecurityStateKeys;
  let counters: RedisAntiNukeCounterStore;
  let raidJoins: RaidJoinWindowStore;
  let beast: BeastStateStore;

  beforeAll(async () => {
    redis = new RedisConnection({ url: TEST_REDIS_URL ?? '' });
    await redis.connect();
    keys = new SecurityStateKeys('t77-test');
    counters = new RedisAntiNukeCounterStore(redis, keys);
    raidJoins = new RaidJoinWindowStore(redis, keys);
    beast = new BeastStateStore(redis, keys);
  });

  afterAll(async () => {
    await redis.close();
  });

  beforeEach(async () => {
    await resetRedis();
  });

  it('records Anti-Nuke windows atomically and prunes expired events', async () => {
    const now = Date.now();
    const base = {
      guildId: GUILD_A,
      actorId: ACTOR_ID,
      action: 'MEMBER_BAN' as const,
      windowSeconds: 60,
      riskWindowSeconds: 900,
      riskWeight: 30,
      cooldownSeconds: 60,
      actorCooldownSeconds: 60,
    };

    const first = await counters.record({
      ...base,
      eventId: 'audit:1',
      occurredAt: now,
      now,
    });
    expect(first.windowTimestamps).toHaveLength(1);
    expect(first.cooldownActive).toBe(false);

    const second = await counters.record({
      ...base,
      eventId: 'audit:2',
      occurredAt: now,
      now: now + 1_000,
    });
    expect(second.windowTimestamps).toHaveLength(2);
    expect(second.riskEntries).toHaveLength(2);

    const third = await counters.record({
      ...base,
      eventId: 'audit:3',
      occurredAt: now + 61_000,
      now: now + 61_000,
    });
    expect(third.windowTimestamps).toHaveLength(1);
    expect(third.riskEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('shares Anti-Nuke counters only inside the owning guild', async () => {
    const now = Date.now();
    const input = {
      actorId: ACTOR_ID,
      action: 'CHANNEL_DELETE' as const,
      eventId: 'audit:guild-a',
      occurredAt: now,
      now,
      windowSeconds: 60,
      riskWindowSeconds: 900,
      riskWeight: 20,
      cooldownSeconds: 60,
      actorCooldownSeconds: 60,
    };

    await counters.record({ ...input, guildId: GUILD_A });
    const otherGuild = await counters.record({ ...input, guildId: GUILD_B });

    expect(otherGuild.windowTimestamps).toHaveLength(1);

    const keyA = keys.antiNukeWindow(GUILD_A, ACTOR_ID, 'CHANNEL_DELETE');
    const keyB = keys.antiNukeWindow(GUILD_B, ACTOR_ID, 'CHANNEL_DELETE');
    expect(await redis.zcard(keyA)).toBe(1);
    expect(await redis.zcard(keyB)).toBe(1);
  });

  it('opens a per-actor cooldown after enforcement', async () => {
    const now = Date.now();
    const base = {
      guildId: GUILD_A,
      actorId: ACTOR_ID,
      action: 'MEMBER_BAN' as const,
      windowSeconds: 60,
      riskWindowSeconds: 900,
      riskWeight: 30,
      cooldownSeconds: 60,
      actorCooldownSeconds: 60,
    };

    await counters.recordEnforcement({
      guildId: GUILD_A,
      actorId: ACTOR_ID,
      action: 'MEMBER_BAN',
      now,
      cooldownSeconds: 60,
      actorCooldownSeconds: 60,
    });

    const after = await counters.record({
      ...base,
      eventId: 'audit:after',
      occurredAt: now,
      now,
    });
    const otherActor = await counters.record({
      ...base,
      actorId: TARGET_ID,
      eventId: 'audit:other',
      occurredAt: now,
      now,
    });

    expect(after.cooldownActive).toBe(true);
    expect(otherActor.cooldownActive).toBe(false);
  });

  it('retains and prunes a shared join-velocity window', async () => {
    const now = new Date();
    const join = (userId: string, secondsAgo: number): RaidJoinRecord => ({
      userId,
      joinedAt: new Date(now.getTime() - secondsAgo * 1_000),
      accountCreatedAt: new Date(now.getTime() - 2 * 86_400_000),
      hasAvatar: false,
      isBot: false,
      username: 'raid123',
    });

    await raidJoins.record({ guildId: GUILD_A, join: join(ACTOR_ID, 30), windowSeconds: 60, now });
    const retained = await raidJoins.record({
      guildId: GUILD_A,
      join: join(TARGET_ID, 10),
      windowSeconds: 60,
      now,
    });
    expect(retained).toHaveLength(2);
    expect(retained.map((entry) => entry.userId).sort()).toEqual([ACTOR_ID, TARGET_ID].sort());

    const recent = await raidJoins.recent(GUILD_A, 60, now);
    expect(recent).toHaveLength(2);

    const later = new Date(now.getTime() + 120_000);
    const pruned = await raidJoins.record({
      guildId: GUILD_A,
      join: join(TARGET_ID, 0),
      windowSeconds: 60,
      now: later,
    });
    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.userId).toBe(TARGET_ID);
  });

  it('keeps raid windows separate per guild', async () => {
    const now = new Date();
    const join: RaidJoinRecord = {
      userId: ACTOR_ID,
      joinedAt: now,
      accountCreatedAt: now,
      hasAvatar: true,
      isBot: false,
    };

    await raidJoins.record({ guildId: GUILD_A, join, windowSeconds: 60, now });
    const other = await raidJoins.recent(GUILD_B, 60, now);

    expect(other).toHaveLength(0);
  });

  it('stores Beast contributions and the active state with a TTL', async () => {
    const now = new Date();
    const contribution: BeastRiskContribution = {
      eventId: 'audit:beast',
      actorId: ACTOR_ID,
      at: now,
      weight: 30,
      counted: true,
      authorized: false,
      isOwner: false,
      destructive: true,
    };

    const list = await beast.recordContribution({
      guildId: GUILD_A,
      contribution,
      riskWindowSeconds: 900,
      now,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.eventId).toBe('audit:beast');

    expect(await beast.getState(GUILD_A)).toBeNull();

    await beast.setState(
      GUILD_A,
      { active: true, score: 60, activatedAt: now, expiresAt: new Date(now.getTime() + 60_000) },
      60,
    );

    const state = await beast.getState(GUILD_A);
    expect(state?.active).toBe(true);
    expect(state?.score).toBe(60);

    await beast.clear(GUILD_A);
    expect(await beast.getState(GUILD_A)).toBeNull();
    expect(await beast.listContributions(GUILD_A, 900, now)).toHaveLength(0);
  });
});
