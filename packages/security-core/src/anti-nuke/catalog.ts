import type {
  ActionCategory,
  AntiNukeAction,
  IncidentSeverity,
  PunishmentType,
} from './actions.js';
import type { RuleSeed } from './types.js';

export interface ActionDefinition {
  readonly action: AntiNukeAction;
  readonly label: string;
  readonly category: ActionCategory;
  /** Base risk contributed to the actor's decayed risk score. */
  readonly riskWeight: number;
  /** Inherently destructive actions are held to a stricter evidence gate. */
  readonly destructive: boolean;
  readonly defaultThreshold: number;
  readonly defaultWindowSeconds: number;
  readonly defaultContainment: PunishmentType;
  readonly defaultRequiresDestructiveApproval: boolean;
  readonly defaultCooldownSeconds: number;
}

const definition = (
  action: AntiNukeAction,
  label: string,
  category: ActionCategory,
  riskWeight: number,
  destructive: boolean,
  defaultThreshold: number,
  defaultWindowSeconds: number,
  defaultCooldownSeconds = 300,
): ActionDefinition => ({
  action,
  label,
  category,
  riskWeight,
  destructive,
  defaultThreshold,
  defaultWindowSeconds,
  // Observation is the only safe default. Owners must opt in to containment.
  defaultContainment: 'ALERT',
  defaultRequiresDestructiveApproval: true,
  defaultCooldownSeconds,
});

/**
 * Conservative defaults. Thresholds count individual events in the window;
 * the engine additionally requires at least two certain events before it will
 * ever recommend an automatic containment.
 */
export const ACTION_DEFINITIONS: Readonly<Record<AntiNukeAction, ActionDefinition>> = {
  MEMBER_BAN: definition('MEMBER_BAN', 'Member banned', 'MEMBERS', 30, true, 3, 60),
  MEMBER_KICK: definition('MEMBER_KICK', 'Member kicked', 'MEMBERS', 20, true, 3, 60),
  MEMBER_PRUNE: definition('MEMBER_PRUNE', 'Members pruned', 'MEMBERS', 25, true, 2, 300),
  MEMBER_ROLE_UPDATE: definition(
    'MEMBER_ROLE_UPDATE',
    'Member roles changed',
    'ROLES',
    8,
    false,
    10,
    60,
  ),
  CHANNEL_CREATE: definition('CHANNEL_CREATE', 'Channel created', 'CHANNELS', 5, false, 5, 60),
  CHANNEL_DELETE: definition('CHANNEL_DELETE', 'Channel deleted', 'CHANNELS', 20, true, 3, 60),
  CHANNEL_UPDATE: definition('CHANNEL_UPDATE', 'Channel updated', 'CHANNELS', 8, false, 10, 60),
  CHANNEL_PERMISSION_UPDATE: definition(
    'CHANNEL_PERMISSION_UPDATE',
    'Channel permissions changed',
    'PERMISSIONS',
    12,
    false,
    5,
    60,
  ),
  ROLE_CREATE: definition('ROLE_CREATE', 'Role created', 'ROLES', 5, false, 5, 60),
  ROLE_DELETE: definition('ROLE_DELETE', 'Role deleted', 'ROLES', 20, true, 3, 60),
  ROLE_UPDATE: definition('ROLE_UPDATE', 'Role updated', 'ROLES', 8, false, 10, 60),
  ROLE_PERMISSION_UPDATE: definition(
    'ROLE_PERMISSION_UPDATE',
    'Role permissions changed',
    'PERMISSIONS',
    18,
    false,
    3,
    60,
  ),
  ADMINISTRATOR_GRANT: definition(
    'ADMINISTRATOR_GRANT',
    'Administrator granted',
    'PERMISSIONS',
    45,
    true,
    1,
    300,
    600,
  ),
  DANGEROUS_ROLE_ASSIGN: definition(
    'DANGEROUS_ROLE_ASSIGN',
    'Dangerous role assigned',
    'PERMISSIONS',
    25,
    true,
    3,
    60,
  ),
  MASS_ROLE_ASSIGN: definition(
    'MASS_ROLE_ASSIGN',
    'Mass role assignment',
    'ROLES',
    20,
    true,
    5,
    60,
  ),
  BOT_ADD: definition('BOT_ADD', 'Bot added', 'BOTS', 35, true, 1, 600, 900),
  WEBHOOK_CREATE: definition('WEBHOOK_CREATE', 'Webhook created', 'WEBHOOKS', 20, true, 5, 60),
  WEBHOOK_UPDATE: definition('WEBHOOK_UPDATE', 'Webhook updated', 'WEBHOOKS', 15, false, 5, 60),
  WEBHOOK_DELETE: definition('WEBHOOK_DELETE', 'Webhook deleted', 'WEBHOOKS', 20, true, 3, 60),
  GUILD_UPDATE: definition('GUILD_UPDATE', 'Server settings changed', 'SERVER', 15, false, 5, 300),
  VANITY_URL_UPDATE: definition(
    'VANITY_URL_UPDATE',
    'Vanity URL changed',
    'SERVER',
    25,
    true,
    2,
    600,
    900,
  ),
  INVITE_DELETE: definition('INVITE_DELETE', 'Invite deleted', 'SERVER', 5, false, 5, 60),
  EMOJI_UPDATE: definition('EMOJI_UPDATE', 'Emoji changed', 'SERVER', 3, false, 5, 60),
  STICKER_UPDATE: definition('STICKER_UPDATE', 'Sticker changed', 'SERVER', 3, false, 5, 60),
  INTEGRATION_CREATE: definition(
    'INTEGRATION_CREATE',
    'Integration created',
    'INTEGRATIONS',
    15,
    false,
    3,
    300,
  ),
  INTEGRATION_UPDATE: definition(
    'INTEGRATION_UPDATE',
    'Integration updated',
    'INTEGRATIONS',
    15,
    false,
    3,
    300,
  ),
  INTEGRATION_DELETE: definition(
    'INTEGRATION_DELETE',
    'Integration deleted',
    'INTEGRATIONS',
    20,
    true,
    2,
    300,
  ),
};

export function actionDefinition(action: AntiNukeAction): ActionDefinition {
  return ACTION_DEFINITIONS[action];
}

/** Builds the complete default rule set stored for a new guild. */
export function defaultAntiNukeRules(): RuleSeed[] {
  return Object.values(ACTION_DEFINITIONS).map((definition) => ({
    action: definition.action,
    enabled: true,
    threshold: definition.defaultThreshold,
    windowSeconds: definition.defaultWindowSeconds,
    containment: definition.defaultContainment,
    requiresDestructiveApproval: definition.defaultRequiresDestructiveApproval,
    cooldownSeconds: definition.defaultCooldownSeconds,
  }));
}

export function isDestructiveAction(action: AntiNukeAction): boolean {
  return ACTION_DEFINITIONS[action].destructive;
}

/** Severity is intentionally score-based so one noisy event cannot look critical. */
export function severityForScore(
  score: number,
  options: { destructive?: boolean; thresholdExceeded?: boolean } = {},
): IncidentSeverity {
  const base: IncidentSeverity =
    score >= 100 ? 'CRITICAL' : score >= 50 ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'LOW';

  if (options.thresholdExceeded === true && options.destructive === true && base === 'MEDIUM') {
    return 'HIGH';
  }

  return base;
}

export function incidentTypeForAction(
  action: AntiNukeAction,
): 'NUKING' | 'SUSPICIOUS_BOT' | 'DANGEROUS_PERMISSION' {
  switch (action) {
    case 'BOT_ADD':
      return 'SUSPICIOUS_BOT';
    case 'ADMINISTRATOR_GRANT':
    case 'DANGEROUS_ROLE_ASSIGN':
    case 'ROLE_PERMISSION_UPDATE':
    case 'CHANNEL_PERMISSION_UPDATE':
    case 'WEBHOOK_CREATE':
    case 'WEBHOOK_UPDATE':
    case 'WEBHOOK_DELETE':
      return 'DANGEROUS_PERMISSION';
    default:
      return 'NUKING';
  }
}
