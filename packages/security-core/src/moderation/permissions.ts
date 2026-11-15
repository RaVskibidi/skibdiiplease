/**
 * T77 staff permission catalogue.
 *
 * These keys are stored in `AccessGrant.permissionKeys`. They never replace
 * Discord permissions and never bypass role hierarchy. A grant only widens what
 * a member may ask T77 to do when the member already passes the hierarchy gate.
 */
export const T77_PERMISSIONS = {
  MODERATION_VIEW: 'moderation.view',
  MODERATION_WARN: 'moderation.warn',
  MODERATION_TIMEOUT: 'moderation.timeout',
  MODERATION_KICK: 'moderation.kick',
  MODERATION_BAN: 'moderation.ban',
  MODERATION_UNBAN: 'moderation.unban',
  MODERATION_PURGE: 'moderation.purge',
  WHITELIST_MANAGE: 'whitelist.manage',
  STAFF_MANAGE: 'staff.manage',
  SECURITY_CONFIG: 'security.config',
  SECURITY_EXEMPT: 'security.exempt',
  BEAST_OVERRIDE: 'beast.override',
  BACKUP_MANAGE: 'backup.manage',
  BACKUP_RESTORE: 'backup.restore',
} as const;

export type T77Permission = (typeof T77_PERMISSIONS)[keyof typeof T77_PERMISSIONS];

export const T77_PERMISSION_KEYS: readonly T77Permission[] = Object.values(T77_PERMISSIONS);

export const T77_PERMISSION_LABELS: Readonly<Record<T77Permission, string>> = {
  'moderation.view': 'View moderation cases',
  'moderation.warn': 'Issue and revoke warnings',
  'moderation.timeout': 'Timeout members',
  'moderation.kick': 'Kick members',
  'moderation.ban': 'Ban members',
  'moderation.unban': 'Remove bans',
  'moderation.purge': 'Bulk delete messages',
  'whitelist.manage': 'Manage trust and whitelist entries',
  'staff.manage': 'Manage T77 staff grants',
  'security.config': 'Change security configuration',
  'security.exempt': 'Exempt from Anti-Nuke, Anti-Raid, and AutoMod enforcement',
  'beast.override': 'Activate or calm Beast Mode',
  'backup.manage': 'Create and delete backups',
  'backup.restore': 'Preview and run restores',
};

export function isT77Permission(value: string): value is T77Permission {
  return (T77_PERMISSION_KEYS as readonly string[]).includes(value);
}

/** Normalises stored keys, rejects unknown values, and removes duplicates. */
export function normalizePermissionKeys(keys: readonly string[]): T77Permission[] {
  const output = new Set<T77Permission>();
  for (const key of keys) {
    if (!isT77Permission(key)) {
      throw new Error(`Unknown T77 permission key: ${key}`);
    }
    output.add(key);
  }
  return [...output];
}
