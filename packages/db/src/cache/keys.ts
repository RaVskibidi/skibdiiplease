import { isDiscordSnowflake } from '../tenant.js';

const PREFIX_PATTERN = /^[a-z0-9][a-z0-9:-]{0,47}$/u;
const FIELD_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/u;

export interface GuildCacheKeyOptions {
  /** Deployment namespace, e.g. `t77` or `t77-staging`. */
  prefix?: string;
}

/**
 * Deterministic cache keys with hard tenant boundaries.
 *
 * Every key includes the guild ID before any caller-provided field, so a bug in
 * a caller cannot address another guild's namespace. Prefixes and fields are
 * validated to prevent glob injection during invalidation scans.
 */
export class GuildCacheKeys {
  private readonly prefix: string;

  public constructor(options: GuildCacheKeyOptions = {}) {
    const prefix = options.prefix ?? 't77';

    if (!PREFIX_PATTERN.test(prefix)) {
      throw new Error(
        'T77 cache prefix must be 1-48 lowercase alphanumeric, colon, or hyphen characters.',
      );
    }

    this.prefix = prefix;
  }

  public guild(guildId: string, field: string): string {
    validateGuildId(guildId);
    validateField(field);
    return `${this.prefix}:guild:${guildId}:cache:${field}`;
  }

  public guildPattern(guildId: string): string {
    validateGuildId(guildId);
    return `${this.prefix}:guild:${guildId}:cache:*`;
  }

  public pubSubChannel(guildId: string): string {
    validateGuildId(guildId);
    return `${this.prefix}:guild:${guildId}:events`;
  }
}

export function validateGuildId(guildId: string): string {
  if (!isDiscordSnowflake(guildId)) {
    throw new Error('T77 cache keys require a valid Discord guild snowflake.');
  }

  return guildId;
}

function validateField(field: string): void {
  if (!FIELD_PATTERN.test(field)) {
    throw new Error(
      'T77 cache field must be 1-64 alphanumeric, underscore, dot, or hyphen characters.',
    );
  }
}
