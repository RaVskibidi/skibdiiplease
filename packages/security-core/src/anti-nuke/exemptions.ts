import type { ActorAuthorization, ExemptionReason } from './types.js';

/**
 * Resolves the FIRST applicable exemption in the documented precedence order.
 *
 * Owner and trusted-actor exemptions are absolute for Anti-Nuke punishment.
 * They never hide events from the ledger and never grant Discord permissions.
 */
export function resolveExemption(
  ruleEnabled: boolean,
  authorization: ActorAuthorization,
): ExemptionReason | null {
  if (!ruleEnabled) {
    return 'RULE_DISABLED';
  }

  if (authorization.isSelf) {
    return 'SELF_ACTION';
  }

  if (authorization.isOwner) {
    return 'SERVER_OWNER';
  }

  if (authorization.whitelist.globalUser) {
    return 'GLOBAL_USER_WHITELIST';
  }

  if (authorization.whitelist.actionUser) {
    return 'ACTION_USER_WHITELIST';
  }

  if (authorization.whitelist.globalRole) {
    return 'GLOBAL_ROLE_WHITELIST';
  }

  if (authorization.whitelist.actionRole) {
    return 'ACTION_ROLE_WHITELIST';
  }

  if (authorization.whitelist.targetChannel) {
    return 'TARGET_CHANNEL_WHITELIST';
  }

  if (authorization.targetBotApproved) {
    return 'APPROVED_BOT';
  }

  if (authorization.isAuthorizedStaff) {
    return 'AUTHORIZED_STAFF';
  }

  return null;
}

/** True when the exemption is a trust decision rather than a disabled rule. */
export function isTrustExemption(reason: ExemptionReason | null): boolean {
  return reason !== null && reason !== 'RULE_DISABLED';
}
