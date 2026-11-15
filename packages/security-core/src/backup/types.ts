/**
 * Backup snapshot format.
 *
 * Only guild configuration Discord exposes through the API is captured. T77
 * never claims that messages, members, invites, audit logs, webhook tokens, or
 * other non-exportable data can be restored.
 */

export const BACKUP_SCHEMA_VERSION = 1 as const;

export interface SnapshotGuildSettings {
  readonly name: string;
  readonly iconUrl: string | null;
  readonly verificationLevel: number;
  readonly defaultMessageNotifications: number;
  readonly explicitContentFilter: number;
  readonly preferredLocale: string | null;
  readonly afkTimeout: number | null;
}

export interface SnapshotRole {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  readonly hoist: boolean;
  readonly mentionable: boolean;
  /** Permission bitfield serialised as a decimal string. */
  readonly permissions: string;
  readonly position: number;
  readonly managed: boolean;
  readonly iconUrl: string | null;
  readonly unicodeEmoji: string | null;
}

export interface SnapshotPermissionOverwrite {
  readonly id: string;
  /** 0 = role, 1 = member. */
  readonly type: number;
  readonly allow: string;
  readonly deny: string;
}

export interface SnapshotChannel {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly position: number;
  readonly parentId: string | null;
  readonly topic: string | null;
  readonly nsfw: boolean;
  readonly rateLimitPerUser: number;
  readonly bitrate: number | null;
  readonly userLimit: number | null;
  readonly permissionOverwrites: readonly SnapshotPermissionOverwrite[];
}

export interface SnapshotEmoji {
  readonly id: string;
  readonly name: string | null;
  readonly animated: boolean;
  readonly url: string | null;
}

export interface SnapshotSticker {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly tags: string;
  readonly format: number;
  readonly url: string | null;
}

export interface GuildSnapshot {
  readonly schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  readonly guildId: string;
  readonly capturedAt: string;
  readonly guild: SnapshotGuildSettings;
  readonly roles: readonly SnapshotRole[];
  readonly channels: readonly SnapshotChannel[];
  readonly emojis: readonly SnapshotEmoji[];
  readonly stickers: readonly SnapshotSticker[];
  readonly limitations: readonly string[];
}

export const UNSUPPORTED_SNAPSHOT_DATA: readonly string[] = [
  'Messages and attachments are not captured and cannot be restored.',
  'Members and their join history are not captured.',
  'Bans, invites, audit logs, and scheduled events are not captured.',
  'Webhook URLs and tokens are not captured; deleted webhooks must be recreated.',
  'Integrations, application commands, and OAuth connections are not captured.',
  'Threads and their message history are not captured.',
  'Emoji, sticker, and icon URLs may expire; re-upload from your own source if they fail.',
  'Deleted roles and channels can be recreated, but their original IDs are not recoverable.',
];

export type RestoreCategory =
  'roles' | 'channels' | 'permissions' | 'emojis' | 'stickers' | 'guildSettings';

export const RESTORE_CATEGORIES: readonly RestoreCategory[] = [
  'roles',
  'channels',
  'permissions',
  'emojis',
  'stickers',
  'guildSettings',
];

export interface RestoreSelection {
  readonly categories: readonly RestoreCategory[];
  readonly roleIds?: readonly string[];
  readonly channelIds?: readonly string[];
  /** Deletions are opt-in and are never implied by another category. */
  readonly deleteMissing?: boolean;
}

export type RestoreAction =
  'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE_PERMISSIONS' | 'RESTORE_GUILD_SETTINGS';

export type RestoreRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RestorePlanItem {
  readonly category: RestoreCategory;
  readonly action: RestoreAction;
  readonly id: string;
  readonly name: string;
  readonly risk: RestoreRisk;
  readonly fields: readonly string[];
}

export interface RestorePreview {
  readonly items: readonly RestorePlanItem[];
  readonly warnings: readonly string[];
  readonly unsupported: readonly string[];
  readonly counts: Readonly<Record<RestoreAction, number>>;
}

const ACTION_ORDER: readonly RestoreAction[] = [
  'CREATE',
  'UPDATE',
  'RESTORE_PERMISSIONS',
  'RESTORE_GUILD_SETTINGS',
  'DELETE',
];

export function emptyCounts(): Record<RestoreAction, number> {
  return {
    CREATE: 0,
    UPDATE: 0,
    DELETE: 0,
    RESTORE_PERMISSIONS: 0,
    RESTORE_GUILD_SETTINGS: 0,
  };
}

/** Rejects structurally invalid snapshots before any Discord action is planned. */
export function validateSnapshot(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return ['Snapshot is not an object.'];
  }
  const snapshot = input as Partial<GuildSnapshot>;

  if (snapshot.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    errors.push(`Unsupported snapshot schema version: ${String(snapshot.schemaVersion)}.`);
  }
  if (typeof snapshot.guildId !== 'string' || !/^\d{17,20}$/u.test(snapshot.guildId)) {
    errors.push('Snapshot guild ID is invalid.');
  }
  if (typeof snapshot.capturedAt !== 'string' || Number.isNaN(Date.parse(snapshot.capturedAt))) {
    errors.push('Snapshot capture timestamp is invalid.');
  }
  if (typeof snapshot.guild !== 'object' || snapshot.guild === null) {
    errors.push('Snapshot guild settings are missing.');
  }
  if (!Array.isArray(snapshot.roles)) {
    errors.push('Snapshot roles are missing.');
  }
  if (!Array.isArray(snapshot.channels)) {
    errors.push('Snapshot channels are missing.');
  }
  if (!Array.isArray(snapshot.emojis)) {
    errors.push('Snapshot emojis are missing.');
  }
  if (!Array.isArray(snapshot.stickers)) {
    errors.push('Snapshot stickers are missing.');
  }

  return errors;
}

export interface SnapshotSummary {
  readonly roles: number;
  readonly channels: number;
  readonly emojis: number;
  readonly stickers: number;
  readonly permissionOverwrites: number;
}

export function summarizeSnapshot(snapshot: GuildSnapshot): SnapshotSummary {
  return {
    roles: snapshot.roles.length,
    channels: snapshot.channels.length,
    emojis: snapshot.emojis.length,
    stickers: snapshot.stickers.length,
    permissionOverwrites: snapshot.channels.reduce(
      (total, channel) => total + channel.permissionOverwrites.length,
      0,
    ),
  };
}

export interface BuildRestorePreviewInput {
  readonly snapshot: GuildSnapshot;
  readonly current: GuildSnapshot;
  readonly selection: RestoreSelection;
}

function sameRole(a: SnapshotRole, b: SnapshotRole): boolean {
  return (
    a.name === b.name &&
    a.color === b.color &&
    a.hoist === b.hoist &&
    a.mentionable === b.mentionable &&
    a.permissions === b.permissions &&
    a.position === b.position &&
    a.iconUrl === b.iconUrl &&
    a.unicodeEmoji === b.unicodeEmoji
  );
}

function sameOverwrites(
  a: readonly SnapshotPermissionOverwrite[],
  b: readonly SnapshotPermissionOverwrite[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const map = new Map(b.map((entry) => [`${entry.id}:${entry.type}`, entry]));
  return a.every((entry) => {
    const other = map.get(`${entry.id}:${entry.type}`);
    return other !== undefined && other.allow === entry.allow && other.deny === entry.deny;
  });
}

function sameChannel(a: SnapshotChannel, b: SnapshotChannel): boolean {
  return (
    a.name === b.name &&
    a.type === b.type &&
    a.position === b.position &&
    a.parentId === b.parentId &&
    a.topic === b.topic &&
    a.nsfw === b.nsfw &&
    a.rateLimitPerUser === b.rateLimitPerUser &&
    a.bitrate === b.bitrate &&
    a.userLimit === b.userLimit &&
    sameOverwrites(a.permissionOverwrites, b.permissionOverwrites)
  );
}

/**
 * Computes one deterministic diff. The caller still revalidates Discord
 * hierarchy and permissions before applying anything.
 */
export function buildRestorePreview(input: BuildRestorePreviewInput): RestorePreview {
  const { snapshot, current, selection } = input;
  const categories = new Set(selection.categories);
  const items: RestorePlanItem[] = [];
  const warnings: string[] = [];
  const counts = emptyCounts();

  const roleFilter = selection.roleIds === undefined ? null : new Set(selection.roleIds);
  const channelFilter = selection.channelIds === undefined ? null : new Set(selection.channelIds);

  if (categories.has('roles')) {
    const currentRoles = new Map(current.roles.map((role) => [role.id, role]));
    for (const role of snapshot.roles) {
      if (role.managed || role.id === snapshot.guildId) {
        continue;
      }
      if (roleFilter !== null && !roleFilter.has(role.id)) {
        continue;
      }
      const existing = currentRoles.get(role.id);
      if (existing === undefined) {
        items.push({
          category: 'roles',
          action: 'CREATE',
          id: role.id,
          name: role.name,
          risk: 'MEDIUM',
          fields: ['name', 'color', 'hoist', 'mentionable', 'permissions', 'position'],
        });
      } else if (!sameRole(role, existing)) {
        const fields: string[] = [];
        if (role.name !== existing.name) fields.push('name');
        if (role.color !== existing.color) fields.push('color');
        if (role.hoist !== existing.hoist) fields.push('hoist');
        if (role.mentionable !== existing.mentionable) fields.push('mentionable');
        if (role.permissions !== existing.permissions) fields.push('permissions');
        if (role.position !== existing.position) fields.push('position');
        if (role.iconUrl !== existing.iconUrl) fields.push('icon');
        if (role.unicodeEmoji !== existing.unicodeEmoji) fields.push('unicodeEmoji');
        items.push({
          category: 'roles',
          action: 'UPDATE',
          id: role.id,
          name: role.name,
          risk: fields.includes('permissions') ? 'HIGH' : 'MEDIUM',
          fields,
        });
      }
    }

    if (selection.deleteMissing === true) {
      const snapshotIds = new Set(snapshot.roles.map((role) => role.id));
      for (const role of current.roles) {
        if (
          role.managed ||
          role.id === current.guildId ||
          snapshotIds.has(role.id) ||
          (roleFilter !== null && !roleFilter.has(role.id))
        ) {
          continue;
        }
        items.push({
          category: 'roles',
          action: 'DELETE',
          id: role.id,
          name: role.name,
          risk: 'HIGH',
          fields: ['role'],
        });
      }
      warnings.push(
        'Deleting roles that are absent from the backup is irreversible. T77 skips @everyone and managed roles.',
      );
    }
  }

  if (categories.has('channels') || categories.has('permissions')) {
    const currentChannels = new Map(current.channels.map((channel) => [channel.id, channel]));

    if (categories.has('channels')) {
      for (const channel of snapshot.channels) {
        if (channelFilter !== null && !channelFilter.has(channel.id)) {
          continue;
        }
        const existing = currentChannels.get(channel.id);
        if (existing === undefined) {
          items.push({
            category: 'channels',
            action: 'CREATE',
            id: channel.id,
            name: channel.name,
            risk: 'MEDIUM',
            fields: ['name', 'type', 'parent', 'topic', 'position'],
          });
        } else if (!sameChannel(channel, existing)) {
          const fields: string[] = [];
          if (channel.name !== existing.name) fields.push('name');
          if (channel.type !== existing.type) fields.push('type');
          if (channel.position !== existing.position) fields.push('position');
          if (channel.parentId !== existing.parentId) fields.push('parent');
          if (channel.topic !== existing.topic) fields.push('topic');
          if (channel.nsfw !== existing.nsfw) fields.push('nsfw');
          if (channel.rateLimitPerUser !== existing.rateLimitPerUser) fields.push('slowmode');
          if (channel.bitrate !== existing.bitrate) fields.push('bitrate');
          if (channel.userLimit !== existing.userLimit) fields.push('userLimit');
          if (fields.length > 0) {
            items.push({
              category: 'channels',
              action: 'UPDATE',
              id: channel.id,
              name: channel.name,
              risk: 'MEDIUM',
              fields,
            });
          }
        }
      }

      if (selection.deleteMissing === true) {
        const snapshotIds = new Set(snapshot.channels.map((channel) => channel.id));
        for (const channel of current.channels) {
          if (
            snapshotIds.has(channel.id) ||
            (channelFilter !== null && !channelFilter.has(channel.id))
          ) {
            continue;
          }
          items.push({
            category: 'channels',
            action: 'DELETE',
            id: channel.id,
            name: channel.name,
            risk: 'HIGH',
            fields: ['channel'],
          });
        }
        warnings.push(
          'Deleting channels that are absent from the backup is irreversible and removes their message history.',
        );
      }
    }

    if (categories.has('permissions')) {
      for (const channel of snapshot.channels) {
        if (channelFilter !== null && !channelFilter.has(channel.id)) {
          continue;
        }
        const existing = currentChannels.get(channel.id);
        if (
          existing !== undefined &&
          !sameOverwrites(channel.permissionOverwrites, existing.permissionOverwrites)
        ) {
          items.push({
            category: 'permissions',
            action: 'RESTORE_PERMISSIONS',
            id: channel.id,
            name: channel.name,
            risk: 'HIGH',
            fields: ['permissionOverwrites'],
          });
        }
      }
    }
  }

  if (categories.has('emojis')) {
    const currentIds = new Set(current.emojis.map((emoji) => emoji.id));
    for (const emoji of snapshot.emojis) {
      if (!currentIds.has(emoji.id)) {
        items.push({
          category: 'emojis',
          action: 'CREATE',
          id: emoji.id,
          name: emoji.name ?? emoji.id,
          risk: 'LOW',
          fields: ['name', 'image'],
        });
      }
    }
    if (snapshot.emojis.length > 0) {
      warnings.push(
        'Emoji restoration depends on a still-accessible source URL. If the URL expired, T77 reports the emoji as unrestored instead of inventing an image.',
      );
    }
  }

  if (categories.has('stickers')) {
    const currentIds = new Set(current.stickers.map((sticker) => sticker.id));
    for (const sticker of snapshot.stickers) {
      if (!currentIds.has(sticker.id)) {
        items.push({
          category: 'stickers',
          action: 'CREATE',
          id: sticker.id,
          name: sticker.name,
          risk: 'LOW',
          fields: ['name', 'description', 'tags', 'file'],
        });
      }
    }
    if (snapshot.stickers.length > 0) {
      warnings.push(
        'Sticker restoration depends on a still-accessible source URL. Discord may reject unsupported formats or expired assets.',
      );
    }
  }

  if (categories.has('guildSettings')) {
    if (snapshot.guild.name !== current.guild.name) {
      items.push({
        category: 'guildSettings',
        action: 'RESTORE_GUILD_SETTINGS',
        id: snapshot.guildId,
        name: 'Server name',
        risk: 'MEDIUM',
        fields: ['name'],
      });
    }
    if (
      snapshot.guild.verificationLevel !== current.guild.verificationLevel ||
      snapshot.guild.defaultMessageNotifications !== current.guild.defaultMessageNotifications ||
      snapshot.guild.explicitContentFilter !== current.guild.explicitContentFilter
    ) {
      items.push({
        category: 'guildSettings',
        action: 'RESTORE_GUILD_SETTINGS',
        id: snapshot.guildId,
        name: 'Server moderation settings',
        risk: 'MEDIUM',
        fields: ['verificationLevel', 'notifications', 'explicitContentFilter'],
      });
    }
  }

  items.sort((a, b) => {
    const order = ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action);
    return order !== 0 ? order : a.category.localeCompare(b.category);
  });
  for (const item of items) {
    counts[item.action] += 1;
  }

  return {
    items,
    warnings,
    unsupported: [...UNSUPPORTED_SNAPSHOT_DATA],
    counts,
  };
}

export function normalizeRestoreSelection(selection: RestoreSelection): RestoreSelection {
  const categories = [...new Set(selection.categories)].filter((category) =>
    RESTORE_CATEGORIES.includes(category),
  );
  return {
    categories,
    ...(selection.roleIds === undefined ? {} : { roleIds: [...new Set(selection.roleIds)] }),
    ...(selection.channelIds === undefined
      ? {}
      : { channelIds: [...new Set(selection.channelIds)] }),
    deleteMissing: selection.deleteMissing === true,
  };
}
