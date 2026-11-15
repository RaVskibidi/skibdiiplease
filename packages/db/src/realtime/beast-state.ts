import type { BeastRiskContribution, BeastStateSnapshot } from '@t77/security-core';

import type { RedisConnection } from '../redis.js';
import type { SecurityStateKeys } from './keys.js';

const MAX_CONTRIBUTIONS = 5_000;

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
 * Redis-backed Beast Mode inputs.
 *
 * Contributions are short-lived scoring evidence; the Beast state itself is a
 * small TTL-bound JSON projection. PostgreSQL remains the durable record of
 * activation and deactivation.
 */
export class BeastStateStore {
  private readonly redis: RedisConnection;
  private readonly keys: SecurityStateKeys;

  public constructor(redis: RedisConnection, keys: SecurityStateKeys) {
    this.redis = redis;
    this.keys = keys;
  }

  public async recordContribution(input: {
    readonly guildId: string;
    readonly contribution: BeastRiskContribution;
    readonly riskWindowSeconds: number;
    readonly now: Date;
  }): Promise<BeastRiskContribution[]> {
    const windowMs = Math.max(input.riskWindowSeconds, 1) * 1_000;
    const cutoff = input.now.getTime() - windowMs;

    const raw = await this.redis.eval(
      RECORD_SCRIPT,
      [this.keys.beastContributions(input.guildId)],
      [
        cutoff,
        input.contribution.at.getTime(),
        JSON.stringify(serializeContribution(input.contribution)),
        windowMs + 60_000,
        MAX_CONTRIBUTIONS,
      ],
    );

    if (!Array.isArray(raw)) {
      throw new Error('T77 Beast Mode counter script returned an unexpected shape.');
    }

    return raw
      .map((entry) => parseContribution(String(entry)))
      .filter((entry): entry is BeastRiskContribution => entry !== null);
  }

  public async listContributions(
    guildId: string,
    riskWindowSeconds: number,
    now: Date,
  ): Promise<BeastRiskContribution[]> {
    const cutoff = now.getTime() - Math.max(riskWindowSeconds, 1) * 1_000;
    const members = await this.redis.zrangeByScore(
      this.keys.beastContributions(guildId),
      cutoff,
      now.getTime(),
    );

    return members
      .map((entry) => parseContribution(entry))
      .filter((entry): entry is BeastRiskContribution => entry !== null);
  }

  public async getState(guildId: string): Promise<BeastStateSnapshot | null> {
    const raw = await this.redis.get(this.keys.beastState(guildId));
    if (raw === null) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        active: parsed.active === true,
        score: typeof parsed.score === 'number' ? parsed.score : 0,
        activatedAt: typeof parsed.activatedAt === 'string' ? new Date(parsed.activatedAt) : null,
        expiresAt: typeof parsed.expiresAt === 'string' ? new Date(parsed.expiresAt) : null,
      };
    } catch {
      return null;
    }
  }

  public async setState(
    guildId: string,
    state: BeastStateSnapshot,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.set(
      this.keys.beastState(guildId),
      JSON.stringify({
        active: state.active,
        score: state.score,
        activatedAt: state.activatedAt?.toISOString() ?? null,
        expiresAt: state.expiresAt?.toISOString() ?? null,
      }),
      Math.max(ttlSeconds, 1) * 1_000,
    );
  }

  public async clear(guildId: string): Promise<void> {
    await this.redis.delete([this.keys.beastContributions(guildId), this.keys.beastState(guildId)]);
  }
}

function serializeContribution(contribution: BeastRiskContribution): Record<string, unknown> {
  return {
    eventId: contribution.eventId,
    actorId: contribution.actorId,
    at: contribution.at.toISOString(),
    weight: contribution.weight,
    counted: contribution.counted,
    authorized: contribution.authorized,
    isOwner: contribution.isOwner,
    destructive: contribution.destructive,
  };
}

function parseContribution(value: string): BeastRiskContribution | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;

    if (
      typeof parsed.eventId !== 'string' ||
      typeof parsed.at !== 'string' ||
      typeof parsed.weight !== 'number' ||
      typeof parsed.counted !== 'boolean' ||
      typeof parsed.authorized !== 'boolean' ||
      typeof parsed.isOwner !== 'boolean' ||
      typeof parsed.destructive !== 'boolean'
    ) {
      return null;
    }

    return {
      eventId: parsed.eventId,
      actorId: typeof parsed.actorId === 'string' ? parsed.actorId : null,
      at: new Date(parsed.at),
      weight: parsed.weight,
      counted: parsed.counted,
      authorized: parsed.authorized,
      isOwner: parsed.isOwner,
      destructive: parsed.destructive,
    };
  } catch {
    return null;
  }
}
