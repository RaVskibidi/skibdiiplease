/**
 * Complete Anti-Nuke action catalog.
 *
 * These strings are the stable contract shared by the pure engine, the Prisma
 * enum, and the Discord audit-log normalizer. Keeping them in one package
 * prevents the bot from silently monitoring an action the engine cannot score.
 */
export const ANTI_NUKE_ACTIONS = [
  'MEMBER_BAN',
  'MEMBER_KICK',
  'MEMBER_PRUNE',
  'MEMBER_ROLE_UPDATE',
  'CHANNEL_CREATE',
  'CHANNEL_DELETE',
  'CHANNEL_UPDATE',
  'CHANNEL_PERMISSION_UPDATE',
  'ROLE_CREATE',
  'ROLE_DELETE',
  'ROLE_UPDATE',
  'ROLE_PERMISSION_UPDATE',
  'ADMINISTRATOR_GRANT',
  'DANGEROUS_ROLE_ASSIGN',
  'MASS_ROLE_ASSIGN',
  'BOT_ADD',
  'WEBHOOK_CREATE',
  'WEBHOOK_UPDATE',
  'WEBHOOK_DELETE',
  'GUILD_UPDATE',
  'VANITY_URL_UPDATE',
  'INVITE_DELETE',
  'EMOJI_UPDATE',
  'STICKER_UPDATE',
  'INTEGRATION_CREATE',
  'INTEGRATION_UPDATE',
  'INTEGRATION_DELETE',
] as const;

export type AntiNukeAction = (typeof ANTI_NUKE_ACTIONS)[number];

export const PUNISHMENT_TYPES = [
  'ALERT',
  'QUARANTINE',
  'ROLE_REMOVAL',
  'TIMEOUT',
  'KICK',
  'BAN',
] as const;

export type PunishmentType = (typeof PUNISHMENT_TYPES)[number];

export const DESTRUCTIVE_PUNISHMENTS: ReadonlySet<PunishmentType> = new Set(['KICK', 'BAN']);

export const REVERSIBLE_PUNISHMENTS: ReadonlySet<PunishmentType> = new Set([
  'QUARANTINE',
  'ROLE_REMOVAL',
  'TIMEOUT',
]);

export const AUTOMATION_MODES = ['OBSERVE', 'ENFORCE_REVERSIBLE', 'ENFORCE_DESTRUCTIVE'] as const;

export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_TYPES = [
  'NUKING',
  'MASS_JOIN',
  'RAID',
  'BEAST_MODE',
  'SPAM',
  'AUTOMOD',
  'VERIFICATION_ABUSE',
  'SUSPICIOUS_BOT',
  'DANGEROUS_PERMISSION',
  'MANUAL',
] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const SECURITY_EVENT_SOURCES = [
  'AUDIT_LOG',
  'GATEWAY',
  'MESSAGE',
  'COMMAND',
  'DASHBOARD',
  'SYSTEM',
] as const;

export type SecurityEventSource = (typeof SECURITY_EVENT_SOURCES)[number];

export type AttributionConfidence = 'CERTAIN' | 'UNCERTAIN';

export const ACTION_CATEGORIES = [
  'MEMBERS',
  'CHANNELS',
  'ROLES',
  'PERMISSIONS',
  'BOTS',
  'WEBHOOKS',
  'SERVER',
  'INTEGRATIONS',
] as const;

export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

export function isAntiNukeAction(value: string): value is AntiNukeAction {
  return (ANTI_NUKE_ACTIONS as readonly string[]).includes(value);
}

export function isPunishmentType(value: string): value is PunishmentType {
  return (PUNISHMENT_TYPES as readonly string[]).includes(value);
}

export function isAutomationMode(value: string): value is AutomationMode {
  return (AUTOMATION_MODES as readonly string[]).includes(value);
}
