import type {
  AntiNukeCounterRecordInput,
  AntiNukeCounterSnapshot,
  AntiNukeCounterStore,
  AntiNukeEnforcementInput,
  AntiNukeRiskEntry,
} from '@t77/security-core';

import type { RedisConnection } from '../redis.js';
import type { SecurityStateKeys } from './keys.js';

/**
 * Atomic prune + record + read for one actor/action.
 *
 * Members are encoded so the engine can reconstruct exact timestamps:
 *   window: `<occurredAt>:<eventId>`
 *   risk:   `<occurredAt>:<weight>:<eventId>`
 * Event IDs keep two events in the same millisecond distinct.
 */
const RECORD_SCRIPT = `
local windowKey = KEYS[1]
local riskKey = KEYS[2]
local cooldownActionKey = KEYS[3]
local cooldownActorKey = KEYS[4]
local windowCutoff = tonumber(ARGV[1])
local occurredAt = tonumber(ARGV[2])
local riskCutoff = tonumber(ARGV[3])
local windowMember = ARGV[4]
local riskMember = ARGV[5]
local windowTtl = tonumber(ARGV[6])
local riskTtl = tonumber(ARGV[7])

redis.call('ZREMRANGEBYSCORE', windowKey, '-inf', windowCutoff)
if occurredAt >= windowCutoff then
  redis.call('ZADD', windowKey, occurredAt, windowMember)
  redis.call('PEXPIRE', windowKey, windowTtl)
end

redis.call('ZREMRANGEBYSCORE', riskKey, '-inf', riskCutoff)
if occurredAt >= riskCutoff then
  redis.call('ZADD', riskKey, occurredAt, riskMember)
  redis.call('PEXPIRE', riskKey, riskTtl)
end

local cooldown = 0
if redis.call('PTTL', cooldownActionKey) > 0 then cooldown = 1 end
if redis.call('PTTL', cooldownActorKey) > 0 then cooldown = 1 end

return {
  redis.call('ZRANGE', windowKey, 0, -1),
  redis.call('ZRANGE', riskKey, 0, -1),
  tostring(cooldown)
}
`;

/**
 * Redis-backed Anti-Nuke rolling windows.
 *
 * The counters are operational state with short TTLs; the PostgreSQL event
 * ledger remains the durable audit trail. A Redis outage degrades to the
 * engine's in-memory fallback rather than blocking security evaluation.
 */
export class RedisAntiNukeCounterStore implements AntiNukeCounterStore {
  private readonly redis: RedisConnection;
  private readonly keys: SecurityStateKeys;

  public constructor(redis: RedisConnection, keys: SecurityStateKeys) {
    this.redis = redis;
    this.keys = keys;
  }

  public async record(input: AntiNukeCounterRecordInput): Promise<AntiNukeCounterSnapshot> {
    const windowMs = Math.max(input.windowSeconds, 1) * 1_000;
    const riskMs = Math.max(input.riskWindowSeconds, 1) * 1_000;
    const windowCutoff = input.now - windowMs;
    const riskCutoff = input.now - riskMs;
    const occurredAt = input.occurredAt;

    const result = normalizeScriptResult(
      await this.redis.eval(
        RECORD_SCRIPT,
        [
          this.keys.antiNukeWindow(input.guildId, input.actorId, input.action),
          this.keys.antiNukeRisk(input.guildId, input.actorId),
          this.keys.antiNukeCooldownAction(input.guildId, input.actorId, input.action),
          this.keys.antiNukeCooldownActor(input.guildId, input.actorId),
        ],
        [
          windowCutoff,
          occurredAt,
          riskCutoff,
          `${occurredAt}:${input.eventId}`,
          `${occurredAt}:${Math.max(0, Math.round(input.riskWeight))}:${input.eventId}`,
          windowMs + 60_000,
          riskMs + 60_000,
        ],
      ),
    );

    return {
      windowTimestamps: result.window.map(parseTimestamp).filter(isFiniteNumber),
      riskEntries: result.risk.map(parseRiskEntry).filter(isRiskEntry),
      cooldownActive: result.cooldown,
    };
  }

  public async recordEnforcement(input: AntiNukeEnforcementInput): Promise<void> {
    const actionTtlMs = Math.max(input.cooldownSeconds, 0) * 1_000;
    const actorTtlMs = Math.max(input.actorCooldownSeconds, 0) * 1_000;
    const writes: Promise<unknown>[] = [];

    if (actionTtlMs > 0) {
      writes.push(
        this.redis.set(
          this.keys.antiNukeCooldownAction(input.guildId, input.actorId, input.action),
          String(input.now),
          actionTtlMs,
        ),
      );
    }

    if (actorTtlMs > 0) {
      writes.push(
        this.redis.set(
          this.keys.antiNukeCooldownActor(input.guildId, input.actorId),
          String(input.now),
          actorTtlMs,
        ),
      );
    }

    await Promise.all(writes);
  }
}

interface ScriptResult {
  window: string[];
  risk: string[];
  cooldown: boolean;
}

function normalizeScriptResult(raw: unknown): ScriptResult {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new Error('T77 Anti-Nuke counter script returned an unexpected shape.');
  }

  return {
    window: toStringArray(raw[0]),
    risk: toStringArray(raw[1]),
    cooldown: String(raw[2]) === '1',
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('T77 Anti-Nuke counter script returned a non-array range.');
  }

  return value.map((entry) => String(entry));
}

function parseTimestamp(member: string): number {
  return Number.parseInt(member.split(':', 1)[0] ?? '', 10);
}

function parseRiskEntry(member: string): AntiNukeRiskEntry {
  const [atRaw, weightRaw] = member.split(':', 3);
  return {
    at: Number.parseInt(atRaw ?? '', 10),
    weight: Number.parseInt(weightRaw ?? '', 10),
  };
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function isRiskEntry(value: AntiNukeRiskEntry): boolean {
  return Number.isFinite(value.at) && Number.isFinite(value.weight);
}
