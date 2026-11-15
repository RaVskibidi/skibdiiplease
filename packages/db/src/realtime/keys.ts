import { validateGuildId } from '../cache/keys.js';

const ACTOR_PATTERN = /^\d{17,20}$/u;
const ACTION_PATTERN = /^[A-Z][A-Z_]{1,63}$/u;

/**
 * Redis keys for short-lived security state.
 *
 * Every key starts with the guild ID so a caller bug cannot read another
 * tenant's counters. Values are bounded by TTL and pruned on every write.
 */
export class SecurityStateKeys {
  private readonly prefix: string;

  public constructor(prefix = 't77') {
    if (!/^[a-z0-9][a-z0-9:-]{0,47}$/u.test(prefix)) {
      throw new Error(
        'T77 security state prefix must be lowercase alphanumeric, colon, or hyphen.',
      );
    }

    this.prefix = prefix;
  }

  public antiNukeWindow(guildId: string, actorId: string, action: string): string {
    return `${this.base(guildId)}:antinuke:window:${actor(actorId)}:${actionName(action)}`;
  }

  public antiNukeRisk(guildId: string, actorId: string): string {
    return `${this.base(guildId)}:antinuke:risk:${actor(actorId)}`;
  }

  public antiNukeCooldownAction(guildId: string, actorId: string, action: string): string {
    return `${this.base(guildId)}:antinuke:cooldown:${actor(actorId)}:${actionName(action)}`;
  }

  public antiNukeCooldownActor(guildId: string, actorId: string): string {
    return `${this.base(guildId)}:antinuke:cooldown:${actor(actorId)}`;
  }

  public raidJoins(guildId: string): string {
    return `${this.base(guildId)}:antiraid:joins`;
  }

  public raidIncident(guildId: string): string {
    return `${this.base(guildId)}:antiraid:incident`;
  }

  public beastContributions(guildId: string): string {
    return `${this.base(guildId)}:beast:contributions`;
  }

  public beastState(guildId: string): string {
    return `${this.base(guildId)}:beast:state`;
  }

  public automodWindow(guildId: string, userId: string): string {
    return `${this.base(guildId)}:automod:window:${actor(userId)}`;
  }

  public automodWarnings(guildId: string, userId: string): string {
    return `${this.base(guildId)}:automod:warnings:${actor(userId)}`;
  }

  private base(guildId: string): string {
    return `${this.prefix}:guild:${validateGuildId(guildId)}`;
  }
}

function actor(actorId: string): string {
  if (!ACTOR_PATTERN.test(actorId)) {
    throw new Error('T77 security state requires a valid Discord user snowflake.');
  }

  return actorId;
}

function actionName(action: string): string {
  if (!ACTION_PATTERN.test(action)) {
    throw new Error('T77 security state requires a normalized action name.');
  }

  return action;
}
