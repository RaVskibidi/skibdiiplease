import type { RaidJoinRecord } from '@t77/security-core';

import type { RedisConnection } from '../redis.js';
import type { SecurityStateKeys } from './keys.js';

/** Hard cap on retained join records; a raid cannot exhaust bot memory. */
const MAX_RETAINED_JOINS = 2_000;

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

/**
 * Redis-backed join velocity window.
 *
 * Storing joins centrally means every shard observes the same burst. Records
 * expire automatically, so the window cannot grow without bound.
 */
export class RaidJoinWindowStore {
  private readonly redis: RedisConnection;
  private readonly keys: SecurityStateKeys;

  public constructor(redis: RedisConnection, keys: SecurityStateKeys) {
    this.redis = redis;
    this.keys = keys;
  }

  public async record(input: {
    readonly guildId: string;
    readonly join: RaidJoinRecord;
    readonly windowSeconds: number;
    readonly now: Date;
  }): Promise<RaidJoinRecord[]> {
    const windowMs = Math.max(input.windowSeconds, 1) * 1_000;
    const cutoff = input.now.getTime() - windowMs;
    const score = input.join.joinedAt.getTime();
    const member = JSON.stringify({
      userId: input.join.userId,
      joinedAt: input.join.joinedAt.toISOString(),
      accountCreatedAt: input.join.accountCreatedAt.toISOString(),
      hasAvatar: input.join.hasAvatar,
      isBot: input.join.isBot,
      ...(input.join.username === undefined ? {} : { username: input.join.username }),
    });

    const raw = await this.redis.eval(
      RECORD_SCRIPT,
      [this.keys.raidJoins(input.guildId)],
      [cutoff, score, member, windowMs + 60_000, MAX_RETAINED_JOINS],
    );

    if (!Array.isArray(raw)) {
      throw new Error('T77 raid window script returned an unexpected shape.');
    }

    return raw
      .map((entry) => parseJoin(String(entry)))
      .filter((join): join is RaidJoinRecord => join !== null);
  }

  /** Lists retained joins without recording a new one, for status commands. */
  public async recent(
    guildId: string,
    windowSeconds: number,
    now: Date,
  ): Promise<RaidJoinRecord[]> {
    const cutoff = now.getTime() - Math.max(windowSeconds, 1) * 1_000;
    const members = await this.redis.zrangeByScore(
      this.keys.raidJoins(guildId),
      cutoff,
      now.getTime(),
    );

    return members
      .map((entry) => parseJoin(entry))
      .filter((join): join is RaidJoinRecord => join !== null);
  }
}

function parseJoin(value: string): RaidJoinRecord | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;

    if (
      typeof parsed.userId !== 'string' ||
      typeof parsed.joinedAt !== 'string' ||
      typeof parsed.accountCreatedAt !== 'string' ||
      typeof parsed.hasAvatar !== 'boolean' ||
      typeof parsed.isBot !== 'boolean'
    ) {
      return null;
    }

    return {
      userId: parsed.userId,
      joinedAt: new Date(parsed.joinedAt),
      accountCreatedAt: new Date(parsed.accountCreatedAt),
      hasAvatar: parsed.hasAvatar,
      isBot: parsed.isBot,
      ...(typeof parsed.username === 'string' ? { username: parsed.username } : {}),
    };
  } catch {
    return null;
  }
}
