import type { T77Permission } from './permissions.js';

/**
 * Discord permission bits required for a moderation action.
 *
 * The numbers match discord.js `PermissionFlagsBits`; the pure package has no
 * Discord.js dependency, so the caller supplies the actor's and bot's bitfields.
 */
export const DISCORD_PERMISSION_BITS = {
  ManageGuild: 32n,
  ModerateMembers: 1n << 40n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  ManageMessages: 1n << 13n,
  ManageChannels: 1n << 4n,
  ManageRoles: 1n << 28n,
} as const;

export type ModerationAction = 'BAN' | 'KICK' | 'TIMEOUT' | 'WARN' | 'UNBAN' | 'PURGE';

export interface ModerationActor {
  readonly userId: string;
  readonly isOwner: boolean;
  /** Highest role position, or 0 when the member has no roles. */
  readonly highestRolePosition: number;
  /** Combined Discord permission bitfield as a bigint. */
  readonly permissions: bigint;
  /** T77 grants resolved by the adapter. */
  readonly grantedPermissions: readonly T77Permission[];
}

export interface ModerationTarget {
  readonly userId: string;
  readonly isOwner: boolean;
  /** Highest role position, or 0 when the member has no roles. */
  readonly highestRolePosition: number;
  readonly isBot: boolean;
}

export interface ModerationBot {
  readonly userId: string;
  readonly highestRolePosition: number;
  readonly permissions: bigint;
}

export type ModerationDenyReason =
  | 'SELF_TARGET'
  | 'TARGET_IS_OWNER'
  | 'TARGET_IS_BOT'
  | 'ACTOR_BELOW_TARGET'
  | 'BOT_BELOW_TARGET'
  | 'MISSING_DISCORD_PERMISSION'
  | 'MISSING_T77_PERMISSION'
  | 'MISSING_BOT_PERMISSION';

export interface ModerationAuthorizationInput {
  readonly action: ModerationAction;
  readonly actor: ModerationActor;
  readonly target: ModerationTarget;
  readonly bot: ModerationBot;
}

export type ModerationAuthorization =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: ModerationDenyReason };

const ACTION_REQUIREMENTS: Readonly<
  Record<
    ModerationAction,
    { discord: bigint; t77: T77Permission; bot: bigint; allowBotTarget: boolean }
  >
> = {
  BAN: {
    discord: DISCORD_PERMISSION_BITS.BanMembers,
    t77: 'moderation.ban',
    bot: DISCORD_PERMISSION_BITS.BanMembers,
    allowBotTarget: false,
  },
  KICK: {
    discord: DISCORD_PERMISSION_BITS.KickMembers,
    t77: 'moderation.kick',
    bot: DISCORD_PERMISSION_BITS.KickMembers,
    allowBotTarget: false,
  },
  TIMEOUT: {
    discord: DISCORD_PERMISSION_BITS.ModerateMembers,
    t77: 'moderation.timeout',
    bot: DISCORD_PERMISSION_BITS.ModerateMembers,
    allowBotTarget: false,
  },
  WARN: {
    discord: DISCORD_PERMISSION_BITS.ModerateMembers,
    t77: 'moderation.warn',
    bot: 0n,
    allowBotTarget: true,
  },
  UNBAN: {
    discord: DISCORD_PERMISSION_BITS.BanMembers,
    t77: 'moderation.unban',
    bot: DISCORD_PERMISSION_BITS.BanMembers,
    allowBotTarget: true,
  },
  PURGE: {
    discord: DISCORD_PERMISSION_BITS.ManageMessages,
    t77: 'moderation.purge',
    bot: DISCORD_PERMISSION_BITS.ManageMessages,
    allowBotTarget: true,
  },
};

function hasBit(value: bigint, bit: bigint): boolean {
  return (value & bit) === bit;
}

function canUse(actor: ModerationActor, requirement: T77Permission, discord: bigint): boolean {
  if (actor.isOwner) {
    return true;
  }
  return hasBit(actor.permissions, discord) || actor.grantedPermissions.includes(requirement);
}

/**
 * Final authorization gate before any Discord action.
 *
 * Ordering matters:
 *  1. self-target and bot-target refusals;
 *  2. guild owner immunity;
 *  3. actor hierarchy strictly above the target;
 *  4. T77 bot hierarchy strictly above the target;
 *  5. Discord permission or explicit T77 grant;
 *  6. T77 bot permissions for actions that require an API call.
 */
export function authorizeModeration(input: ModerationAuthorizationInput): ModerationAuthorization {
  const { action, actor, target, bot } = input;
  const requirement = ACTION_REQUIREMENTS[action];

  if (actor.userId === target.userId) {
    return { allowed: false, reason: 'SELF_TARGET' };
  }

  if (target.isOwner) {
    return { allowed: false, reason: 'TARGET_IS_OWNER' };
  }

  if (target.isBot && !requirement.allowBotTarget) {
    return { allowed: false, reason: 'TARGET_IS_BOT' };
  }

  if (!actor.isOwner) {
    if (actor.highestRolePosition <= target.highestRolePosition) {
      return { allowed: false, reason: 'ACTOR_BELOW_TARGET' };
    }

    if (bot.highestRolePosition <= target.highestRolePosition) {
      return { allowed: false, reason: 'BOT_BELOW_TARGET' };
    }

    if (!canUse(actor, requirement.t77, requirement.discord)) {
      return { allowed: false, reason: 'MISSING_T77_PERMISSION' };
    }
  } else if (bot.highestRolePosition <= target.highestRolePosition) {
    // The owner outranks everyone, but T77 may still be unable to act.
    return { allowed: false, reason: 'BOT_BELOW_TARGET' };
  }

  if (requirement.bot !== 0n && !hasBit(bot.permissions, requirement.bot)) {
    return { allowed: false, reason: 'MISSING_BOT_PERMISSION' };
  }

  return { allowed: true };
}

/** Staff console visibility: owner, Manage Server, or an explicit moderation grant. */
export function canViewModeration(input: {
  readonly isOwner: boolean;
  readonly permissions: bigint;
  readonly grantedPermissions: readonly T77Permission[];
}): boolean {
  return (
    input.isOwner ||
    hasBit(input.permissions, DISCORD_PERMISSION_BITS.ManageGuild) ||
    hasBit(input.permissions, DISCORD_PERMISSION_BITS.ModerateMembers) ||
    input.grantedPermissions.includes('moderation.view')
  );
}

export function deniedReasonMessage(reason: ModerationDenyReason): string {
  switch (reason) {
    case 'SELF_TARGET':
      return 'You cannot moderate yourself.';
    case 'TARGET_IS_OWNER':
      return 'The server owner is immune to T77 moderation.';
    case 'TARGET_IS_BOT':
      return 'T77 does not apply this action to bot accounts.';
    case 'ACTOR_BELOW_TARGET':
      return 'Your highest role must be above the target member.';
    case 'BOT_BELOW_TARGET':
      return "T77's role must be above the target member. Move the T77 role higher.";
    case 'MISSING_DISCORD_PERMISSION':
      return 'You lack the Discord permission required for this action.';
    case 'MISSING_T77_PERMISSION':
      return 'You lack the Discord permission or T77 staff grant required for this action.';
    case 'MISSING_BOT_PERMISSION':
      return 'T77 lacks the Discord permission required for this action.';
  }
}
