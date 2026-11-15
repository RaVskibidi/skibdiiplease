import { z } from 'zod';

import { GuildCacheKeys, validateGuildId, type GuildCacheKeyOptions } from './keys.js';

/** The subset of RedisConnection the cache needs; easy to fake in unit tests. */
export interface CacheConnection {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<boolean>;
  delete(keys: readonly string[]): Promise<number>;
  scan(match: string, count?: number): Promise<string[]>;
}

export interface GuildCacheOptions extends GuildCacheKeyOptions {
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
}

const cacheEnvelopeSchema = z
  .object({
    version: z.literal(1),
    guildId: z.string().regex(/^\d{17,20}$/u),
    field: z.string().min(1).max(64),
    cachedAt: z.string().datetime(),
    data: z.unknown(),
  })
  .strict();

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 86_400;

/**
 * Read-through cache for tenant-scoped projections.
 *
 * Values are wrapped with their guild, field, and schema version. A stale or
 * misplaced payload is treated as a miss instead of being returned to the
 * caller, which keeps a misconfigured Redis instance from becoming a data leak.
 */
export class GuildCache {
  private readonly connection: CacheConnection;
  private readonly keys: GuildCacheKeys;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;

  public constructor(connection: CacheConnection, options: GuildCacheOptions = {}) {
    this.connection = connection;
    this.keys = new GuildCacheKeys(options);

    const defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
    const maxTtlSeconds = options.maxTtlSeconds ?? MAX_TTL_SECONDS;

    if (maxTtlSeconds < 1 || defaultTtlSeconds < 1 || defaultTtlSeconds > maxTtlSeconds) {
      throw new Error('T77 cache TTL configuration is invalid.');
    }

    this.defaultTtlMs = Math.floor(defaultTtlSeconds * 1_000);
    this.maxTtlMs = Math.floor(maxTtlSeconds * 1_000);
  }

  public key(guildId: string, field: string): string {
    return this.keys.guild(guildId, field);
  }

  public async get<T>(guildId: string, field: string): Promise<T | null> {
    const raw = await this.connection.get(this.keys.guild(guildId, field));
    if (raw === null) {
      return null;
    }

    const parsed = parseEnvelope(raw);
    if (parsed === null || parsed.guildId !== guildId || parsed.field !== field) {
      return null;
    }

    return parsed.data as T;
  }

  public async set<T>(
    guildId: string,
    field: string,
    data: T,
    ttlSeconds?: number,
  ): Promise<boolean> {
    validateGuildId(guildId);

    const ttlMs = Math.floor((ttlSeconds ?? this.defaultTtlMs / 1_000) * 1_000);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > this.maxTtlMs) {
      throw new Error('T77 cache TTL is outside the configured bounds.');
    }

    const envelope = {
      version: 1 as const,
      guildId,
      field,
      cachedAt: new Date().toISOString(),
      data,
    };

    return this.connection.set(this.keys.guild(guildId, field), JSON.stringify(envelope), ttlMs);
  }

  public async getOrLoad<T>(
    guildId: string,
    field: string,
    loader: () => Promise<T>,
    ttlSeconds?: number,
  ): Promise<T> {
    const cached = await this.get<T>(guildId, field);
    if (cached !== null) {
      return cached;
    }

    const loaded = await loader();
    await this.set(guildId, field, loaded, ttlSeconds);
    return loaded;
  }

  public async invalidateField(guildId: string, field: string): Promise<number> {
    return this.connection.delete([this.keys.guild(guildId, field)]);
  }

  /** Removes every cached projection for one guild only. */
  public async invalidateGuild(guildId: string): Promise<number> {
    const keys = await this.connection.scan(this.keys.guildPattern(guildId));

    let deleted = 0;
    for (let index = 0; index < keys.length; index += 100) {
      const batch = keys.slice(index, index + 100);
      deleted += await this.connection.delete(batch);
    }

    return deleted;
  }
}

function parseEnvelope(raw: string): z.infer<typeof cacheEnvelopeSchema> | null {
  try {
    const result = cacheEnvelopeSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
