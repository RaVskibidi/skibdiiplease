import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  GuildCache,
  GuildEventBus,
  GuildServices,
  RedisConnection,
  bootstrapGuild,
  createTenantContext,
  type Database,
  type GuildEventEnvelope,
} from '../../src/index.js';
import {
  ACTOR_ID,
  GUILD_A,
  GUILD_B,
  OWNER_ID,
  TEST_REDIS_URL,
  createTestDatabase,
  redisEnabled,
  resetDatabase,
  resetRedis,
} from './helpers.js';

const describeIntegration = redisEnabled ? describe : describe.skip;

describeIntegration('Redis cache and Pub/Sub', () => {
  let database: Database;
  let redis: RedisConnection;

  beforeAll(async () => {
    database = createTestDatabase();
    await database.connect();
    redis = new RedisConnection({ url: TEST_REDIS_URL ?? '' });
    await redis.connect();
  });

  afterAll(async () => {
    await redis.close();
    await database.disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(database);
    await resetRedis();

    await bootstrapGuild(database, { id: GUILD_A, name: 'Cache A', ownerId: OWNER_ID });
    await bootstrapGuild(database, { id: GUILD_B, name: 'Cache B', ownerId: OWNER_ID });
  });

  it('detects a working Redis connection', async () => {
    await expect(redis.ping()).resolves.toBe(true);
  });

  it('reads configuration through the cache and invalidates on update', async () => {
    const cache = new GuildCache(redis, { prefix: 't77-test' });
    const services = new GuildServices(database, createTenantContext({ guildId: GUILD_A }), {
      cache,
    });

    const initial = await services.getConfig();
    expect(initial.locale).toBe('en');

    // Bypass the service to prove the second read is served from Redis.
    await services.config.update({ locale: 'de' }, ACTOR_ID);
    expect((await services.getConfig()).locale).toBe('en');

    const updated = await services.updateConfig({ locale: 'fr' }, ACTOR_ID);
    expect(updated.locale).toBe('fr');
    expect((await services.getConfig()).locale).toBe('fr');
  });

  it('never returns another guild cache entry', async () => {
    const cache = new GuildCache(redis, { prefix: 't77-test' });
    await cache.set(GUILD_A, 'config', { guild: 'a' });

    expect(await cache.get(GUILD_B, 'config')).toBeNull();

    await cache.set(GUILD_B, 'config', { guild: 'b' });
    expect(await cache.invalidateGuild(GUILD_A)).toBe(1);
    expect(await cache.get(GUILD_B, 'config')).toEqual({ guild: 'b' });
  });

  it('publishes and receives guild-scoped events across connections', async () => {
    const publisher = new GuildEventBus(redis, { prefix: 't77-test' });
    const subscriberConnection = new RedisConnection({ url: TEST_REDIS_URL ?? '' });
    await subscriberConnection.connect();
    const subscriber = new GuildEventBus(subscriberConnection, { prefix: 't77-test' });

    const received: GuildEventEnvelope<{ version: number }>[] = [];
    const unsubscribe = await subscriber.subscribe<{ version: number }>(GUILD_A, (event) => {
      received.push(event);
    });

    try {
      await publisher.publish(GUILD_A, 'config.updated', { version: 7 });
      await publisher.publish(GUILD_B, 'config.updated', { version: 9 });

      await waitFor(() => received.length > 0);

      expect(received).toHaveLength(1);
      expect(received[0]?.guildId).toBe(GUILD_A);
      expect(received[0]?.payload.version).toBe(7);
    } finally {
      await unsubscribe();
      await subscriberConnection.close();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for Pub/Sub delivery.');
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
