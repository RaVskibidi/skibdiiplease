import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AutomodWindowStore, RedisConnection, SecurityStateKeys } from '../../src/index.js';
import {
  GUILD_A,
  GUILD_B,
  TARGET_ID,
  TEST_REDIS_URL,
  redisEnabled,
  resetRedis,
} from './helpers.js';

const describeIntegration = redisEnabled ? describe : describe.skip;

describeIntegration('Phase 6 AutoMod Redis state', () => {
  let redis: RedisConnection;
  let store: AutomodWindowStore;

  beforeAll(async () => {
    redis = new RedisConnection({ url: TEST_REDIS_URL ?? '' });
    await redis.connect();
    store = new AutomodWindowStore(redis, new SecurityStateKeys('t77-test'));
  });

  afterAll(async () => {
    await redis.close();
  });

  beforeEach(async () => {
    await resetRedis();
  });

  it('records a bounded window and returns only prior messages', async () => {
    const now = new Date();

    const previous = await store.record({
      guildId: GUILD_A,
      userId: TARGET_ID,
      message: { id: 'msg-1', content: 'hello', createdAt: now },
      retentionSeconds: 60,
    });

    expect(previous).toEqual([]);

    const second = await store.record({
      guildId: GUILD_A,
      userId: TARGET_ID,
      message: { id: 'msg-2', content: 'hello', createdAt: new Date(now.getTime() + 1_000) },
      retentionSeconds: 60,
    });

    expect(second.map((entry) => entry.id)).toEqual(['msg-1']);
  });

  it('reads the window since a cutoff without adding a message', async () => {
    const now = new Date();

    await store.record({
      guildId: GUILD_A,
      userId: TARGET_ID,
      message: { id: 'old', content: 'old', createdAt: new Date(now.getTime() - 120_000) },
      retentionSeconds: 60,
    });
    await store.record({
      guildId: GUILD_A,
      userId: TARGET_ID,
      message: { id: 'fresh', content: 'fresh', createdAt: now },
      retentionSeconds: 60,
    });

    const entries = await store.read({
      guildId: GUILD_A,
      userId: TARGET_ID,
      since: new Date(now.getTime() - 30_000),
    });

    expect(entries.map((entry) => entry.id)).toEqual(['fresh']);
  });

  it('isolates windows by guild and by member', async () => {
    const now = new Date();

    await store.record({
      guildId: GUILD_A,
      userId: TARGET_ID,
      message: { id: 'a', content: 'same', createdAt: now },
      retentionSeconds: 60,
    });
    await store.record({
      guildId: GUILD_B,
      userId: TARGET_ID,
      message: { id: 'b', content: 'same', createdAt: now },
      retentionSeconds: 60,
    });

    const otherGuild = await store.read({
      guildId: GUILD_B,
      userId: TARGET_ID,
      since: new Date(now.getTime() - 30_000),
    });
    expect(otherGuild.map((entry) => entry.id)).toEqual(['b']);

    const otherUser = await store.read({
      guildId: GUILD_A,
      userId: '999999999999999999',
      since: new Date(now.getTime() - 30_000),
    });
    expect(otherUser).toEqual([]);
  });

  it('increments and clears the warning counter atomically', async () => {
    expect(await store.warningCount(GUILD_A, TARGET_ID)).toBe(0);

    expect(
      await store.recordWarning({ guildId: GUILD_A, userId: TARGET_ID, windowSeconds: 60 }),
    ).toBe(1);
    expect(
      await store.recordWarning({ guildId: GUILD_A, userId: TARGET_ID, windowSeconds: 60 }),
    ).toBe(2);
    expect(await store.warningCount(GUILD_A, TARGET_ID)).toBe(2);

    await store.clearWarnings(GUILD_A, TARGET_ID);
    expect(await store.warningCount(GUILD_A, TARGET_ID)).toBe(0);
  });

  it('clears one member window without touching another member', async () => {
    const now = new Date();

    await store.record({
      guildId: GUILD_A,
      userId: TARGET_ID,
      message: { id: 'one', content: 'text', createdAt: now },
      retentionSeconds: 60,
    });
    await store.record({
      guildId: GUILD_A,
      userId: '999999999999999999',
      message: { id: 'two', content: 'text', createdAt: now },
      retentionSeconds: 60,
    });

    await store.clear(GUILD_A, TARGET_ID);

    expect(
      await store.read({
        guildId: GUILD_A,
        userId: TARGET_ID,
        since: new Date(now.getTime() - 30_000),
      }),
    ).toEqual([]);
    expect(
      await store.read({
        guildId: GUILD_A,
        userId: '999999999999999999',
        since: new Date(now.getTime() - 30_000),
      }),
    ).toHaveLength(1);
  });
});
