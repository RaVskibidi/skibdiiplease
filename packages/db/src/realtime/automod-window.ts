import type { AutomodPriorMessage } from '@t77/security-core';

import type { RedisConnection } from '../redis.js';
import type { SecurityStateKeys } from './keys.js';

/** Hard cap on retained messages per member; spam cannot exhaust Redis memory. */
const MAX_RETAINED_MESSAGES = 100;

const RECORD_SCRIPT = `
local key = KEYS[1]
local cutoff = tonumber(ARGV[1])
local score = tonumber(ARGV[2])
local member = ARGV[3]
local ttl = tonumber(ARGV[4])
local max = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
redis.call('ZADD', key, score, member)
redis.call('PEXPIRE', key, ttl)

local count = redis.call('ZCARD', key)
if count > max then
  redis.call('ZREMRANGEBYRANK', key, 0, count - max - 1)
end

return redis.call('ZRANGE', key, 0, -1)
`;

const WARNING_SCRIPT = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local count = redis.call('INCR', key)
redis.call('PEXPIRE', key, ttl)
return count
`;

export interface AutomodWindowEntry {
  readonly id: string;
  readonly content: string;
  readonly createdAt: Date;
}

/**
 * Redis-backed per-member message window for AutoMod.
 *
 * Only bounded, short-lived evidence is retained: the message ID, normalised
 * text used for duplicate comparison, and its timestamp. Full message content is
 * never persisted here, and every write prunes expired entries and enforces a
 * hard cap so a spam burst cannot grow memory without bound.
 */
export class AutomodWindowStore {
  private readonly redis: RedisConnection;
  private readonly keys: SecurityStateKeys;

  public constructor(redis: RedisConnection, keys: SecurityStateKeys) {
    this.redis = redis;
    this.keys = keys;
  }

  /**
   * Records the current message and returns the retained window, oldest first.
   *
   * `retentionSeconds` should cover the largest configured flood or duplicate
   * window plus a small buffer so the engine always observes complete evidence.
   */
  public async record(input: {
    readonly guildId: string;
    readonly userId: string;
    readonly message: AutomodWindowEntry;
    readonly retentionSeconds: number;
  }): Promise<AutomodWindowEntry[]> {
    const key = this.keys.automodWindow(input.guildId, input.userId);
    const now = input.message.createdAt.getTime();
    const retentionMs = Math.max(input.retentionSeconds, 10) * 1_000;
    const cutoff = now - retentionMs;
    const payload = JSON.stringify({
      id: input.message.id,
      content: input.message.content.slice(0, 500),
      at: input.message.createdAt.toISOString(),
    });

    const raw = await this.redis.eval(
      RECORD_SCRIPT,
      [key],
      [cutoff, now, payload, retentionMs, MAX_RETAINED_MESSAGES],
    );

    return parseEntries(raw).filter((entry) => entry.id !== input.message.id);
  }

  /** Reads the current window without adding a message. */
  public async read(input: {
    readonly guildId: string;
    readonly userId: string;
    readonly since: Date;
  }): Promise<AutomodPriorMessage[]> {
    const key = this.keys.automodWindow(input.guildId, input.userId);
    const raw = await this.redis.zrangeByScore(key, input.since.getTime(), Number.MAX_SAFE_INTEGER);

    return parseEntries(raw).map((entry) => ({
      id: entry.id,
      content: entry.content,
      createdAt: entry.createdAt,
    }));
  }

  /** Clears one member's window, e.g. after a successful verification. */
  public async clear(guildId: string, userId: string): Promise<void> {
    await this.redis.delete([this.keys.automodWindow(guildId, userId)]);
  }

  /** Current AutoMod warning count inside the configured policy window. */
  public async warningCount(guildId: string, userId: string): Promise<number> {
    const raw = await this.redis.get(this.keys.automodWarnings(guildId, userId));
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  /** Increments the warning counter and refreshes its TTL atomically. */
  public async recordWarning(input: {
    readonly guildId: string;
    readonly userId: string;
    readonly windowSeconds: number;
  }): Promise<number> {
    const key = this.keys.automodWarnings(input.guildId, input.userId);
    const ttlMs = Math.max(input.windowSeconds, 10) * 1_000;
    const raw = await this.redis.eval(WARNING_SCRIPT, [key], [ttlMs]);
    const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  public async clearWarnings(guildId: string, userId: string): Promise<void> {
    await this.redis.delete([this.keys.automodWarnings(guildId, userId)]);
  }
}

function parseEntries(raw: unknown): AutomodWindowEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const entries: AutomodWindowEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }
    try {
      const parsed = JSON.parse(item) as { id?: unknown; content?: unknown; at?: unknown };
      if (
        typeof parsed.id !== 'string' ||
        typeof parsed.content !== 'string' ||
        typeof parsed.at !== 'string'
      ) {
        continue;
      }
      entries.push({
        id: parsed.id,
        content: parsed.content,
        createdAt: new Date(parsed.at),
      });
    } catch {
      // A malformed entry is ignored rather than breaking detection.
    }
  }

  return entries;
}
