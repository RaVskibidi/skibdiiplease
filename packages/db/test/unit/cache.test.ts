import { describe, expect, it } from 'vitest';

import { GuildCache, type CacheConnection } from '../../src/cache/guild-cache.js';
import { GuildCacheKeys } from '../../src/cache/keys.js';

class FakeCacheConnection implements CacheConnection {
  public readonly values = new Map<string, { value: string; expiresAt: number }>();
  public deleted: string[] = [];

  public get(key: string): Promise<string | null> {
    const entry = this.values.get(key);
    if (!entry) {
      return Promise.resolve(null);
    }

    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return Promise.resolve(null);
    }

    return Promise.resolve(entry.value);
  }

  public set(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve(true);
  }

  public delete(keys: readonly string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      this.deleted.push(key);
      if (this.values.delete(key)) {
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  public scan(match: string): Promise<string[]> {
    const pattern = new RegExp(
      `^${match
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('.*')}$`,
      'u',
    );
    return Promise.resolve([...this.values.keys()].filter((key) => pattern.test(key)));
  }
}

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';

describe('GuildCacheKeys', () => {
  it('namespaces every key by guild', () => {
    const keys = new GuildCacheKeys({ prefix: 't77-test' });

    expect(keys.guild(GUILD_A, 'config')).toBe(`t77-test:guild:${GUILD_A}:cache:config`);
    expect(keys.guild(GUILD_A, 'config')).not.toBe(keys.guild(GUILD_B, 'config'));
  });

  it('rejects invalid guild IDs, fields, and prefixes', () => {
    const keys = new GuildCacheKeys();

    expect(() => keys.guild('not-a-guild', 'config')).toThrow();
    expect(() => keys.guild(GUILD_A, 'bad field')).toThrow();
    expect(() => keys.guild(GUILD_A, 'bad*field')).toThrow();
    expect(() => new GuildCacheKeys({ prefix: 'BAD PREFIX' })).toThrow();
  });
});

describe('GuildCache', () => {
  it('stores entries with a guild-bound envelope', async () => {
    const connection = new FakeCacheConnection();
    const cache = new GuildCache(connection);

    await cache.set(GUILD_A, 'config', { mode: 'OBSERVE' });

    expect(await cache.get(GUILD_A, 'config')).toEqual({ mode: 'OBSERVE' });
    expect(await cache.get(GUILD_B, 'config')).toBeNull();
  });

  it('treats a mis-scoped or corrupt payload as a miss', async () => {
    const connection = new FakeCacheConnection();
    const cache = new GuildCache(connection);

    await connection.set(
      cache.key(GUILD_A, 'config'),
      JSON.stringify({
        version: 1,
        guildId: GUILD_B,
        field: 'config',
        cachedAt: new Date().toISOString(),
        data: { leaked: true },
      }),
      10_000,
    );

    expect(await cache.get(GUILD_A, 'config')).toBeNull();

    await connection.set(cache.key(GUILD_A, 'config'), 'not-json', 10_000);
    expect(await cache.get(GUILD_A, 'config')).toBeNull();
  });

  it('loads through once and then serves from cache', async () => {
    const cache = new GuildCache(new FakeCacheConnection());
    let loads = 0;

    const loader = (): Promise<{ value: number }> => {
      loads += 1;
      return Promise.resolve({ value: 42 });
    };

    expect(await cache.getOrLoad(GUILD_A, 'stat', loader)).toEqual({ value: 42 });
    expect(await cache.getOrLoad(GUILD_A, 'stat', loader)).toEqual({ value: 42 });
    expect(loads).toBe(1);
  });

  it('invalidates only the requested guild', async () => {
    const connection = new FakeCacheConnection();
    const cache = new GuildCache(connection);

    await cache.set(GUILD_A, 'config', { guild: 'a' });
    await cache.set(GUILD_A, 'resources', ['a']);
    await cache.set(GUILD_B, 'config', { guild: 'b' });

    expect(await cache.invalidateGuild(GUILD_A)).toBe(2);
    expect(await cache.get(GUILD_A, 'config')).toBeNull();
    expect(await cache.get(GUILD_A, 'resources')).toBeNull();
    expect(await cache.get(GUILD_B, 'config')).toEqual({ guild: 'b' });
  });

  it('rejects TTLs outside configured bounds', async () => {
    const cache = new GuildCache(new FakeCacheConnection(), {
      defaultTtlSeconds: 60,
      maxTtlSeconds: 120,
    });

    await expect(cache.set(GUILD_A, 'config', {}, 0)).rejects.toThrow();
    await expect(cache.set(GUILD_A, 'config', {}, 121)).rejects.toThrow();
  });
});
