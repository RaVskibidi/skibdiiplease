import { describe, expect, it } from 'vitest';

import {
  buildRestorePreview,
  emptyCounts,
  normalizeRestoreSelection,
  summarizeSnapshot,
  UNSUPPORTED_SNAPSHOT_DATA,
  validateSnapshot,
  type GuildSnapshot,
  type RestoreSelection,
} from '../../src/backup/types.js';

const GUILD_ID = '111111111111111111';

function makeSnapshot(overrides: Partial<GuildSnapshot> = {}): GuildSnapshot {
  return {
    schemaVersion: 1,
    guildId: GUILD_ID,
    capturedAt: '2026-01-01T00:00:00.000Z',
    guild: {
      name: 'T77 Test',
      iconUrl: null,
      verificationLevel: 1,
      defaultMessageNotifications: 0,
      explicitContentFilter: 0,
      preferredLocale: 'en-US',
      afkTimeout: null,
    },
    roles: [
      {
        id: GUILD_ID,
        name: '@everyone',
        color: 0,
        hoist: false,
        mentionable: false,
        permissions: '104324673',
        position: 0,
        managed: false,
        iconUrl: null,
        unicodeEmoji: null,
      },
      {
        id: '222222222222222222',
        name: 'Staff',
        color: 255,
        hoist: true,
        mentionable: false,
        permissions: '8',
        position: 5,
        managed: false,
        iconUrl: null,
        unicodeEmoji: null,
      },
    ],
    channels: [
      {
        id: '333333333333333333',
        name: 'general',
        type: 0,
        position: 0,
        parentId: null,
        topic: 'Talk',
        nsfw: false,
        rateLimitPerUser: 0,
        bitrate: null,
        userLimit: null,
        permissionOverwrites: [{ id: '222222222222222222', type: 0, allow: '2048', deny: '0' }],
      },
    ],
    emojis: [
      {
        id: '444444444444444444',
        name: 't77',
        animated: false,
        url: 'https://cdn.example/t77.png',
      },
    ],
    stickers: [],
    limitations: [],
    ...overrides,
  };
}

const SELECT_ALL: RestoreSelection = {
  categories: ['roles', 'channels', 'permissions', 'emojis', 'stickers', 'guildSettings'],
};

describe('backup snapshot validation', () => {
  it('accepts a complete snapshot', () => {
    expect(validateSnapshot(makeSnapshot())).toEqual([]);
  });

  it('rejects malformed snapshots', () => {
    expect(validateSnapshot(null)).toEqual(['Snapshot is not an object.']);
    const errors = validateSnapshot({ schemaVersion: 99, guildId: 'bad', roles: [] });
    expect(errors.join(' ')).toMatch(/schema version/u);
    expect(errors.join(' ')).toMatch(/guild ID/u);
  });

  it('summarises captured resources', () => {
    expect(summarizeSnapshot(makeSnapshot())).toEqual({
      roles: 2,
      channels: 1,
      emojis: 1,
      stickers: 0,
      permissionOverwrites: 1,
    });
  });
});

describe('restore preview', () => {
  it('plans creates for resources missing from the current guild', () => {
    const current = makeSnapshot({
      roles: [],
      channels: [],
      emojis: [],
      guild: { ...makeSnapshot().guild, name: 'T77 Test' },
    });

    const preview = buildRestorePreview({
      snapshot: makeSnapshot(),
      current,
      selection: { categories: ['roles', 'channels', 'emojis'] },
    });

    const actions = preview.items.map((item) => `${item.action}:${item.category}:${item.id}`);
    expect(actions).toContain('CREATE:roles:222222222222222222');
    expect(actions).toContain('CREATE:channels:333333333333333333');
    expect(actions).toContain('CREATE:emojis:444444444444444444');
    // @everyone is never recreated or deleted.
    expect(actions).not.toContain('CREATE:roles:111111111111111111');
    expect(preview.counts.CREATE).toBe(3);
    expect(preview.counts.DELETE).toBe(0);
  });

  it('plans permission-only restoration for an existing channel', () => {
    const current = makeSnapshot();
    const drifted: GuildSnapshot = {
      ...current,
      channels: [
        {
          ...current.channels[0]!,
          permissionOverwrites: [],
        },
      ],
    };

    const preview = buildRestorePreview({
      snapshot: makeSnapshot(),
      current: drifted,
      selection: { categories: ['permissions'] },
    });

    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({
      action: 'RESTORE_PERMISSIONS',
      category: 'permissions',
      id: '333333333333333333',
      risk: 'HIGH',
    });
  });

  it('plans role and channel updates with risky fields called out', () => {
    const current = makeSnapshot({
      roles: [
        makeSnapshot().roles[0]!,
        { ...makeSnapshot().roles[1]!, permissions: '0', name: 'Old Staff' },
      ],
      channels: [{ ...makeSnapshot().channels[0]!, name: 'old-general' }],
    });

    const preview = buildRestorePreview({
      snapshot: makeSnapshot(),
      current,
      selection: { categories: ['roles', 'channels'] },
    });

    const role = preview.items.find((item) => item.category === 'roles');
    expect(role).toMatchObject({ action: 'UPDATE', risk: 'HIGH' });
    expect(role?.fields).toEqual(expect.arrayContaining(['name', 'permissions']));

    const channel = preview.items.find((item) => item.category === 'channels');
    expect(channel).toMatchObject({ action: 'UPDATE' });
    expect(channel?.fields).toContain('name');
  });

  it('never plans deletions unless explicitly requested', () => {
    const current = makeSnapshot({
      roles: [
        ...makeSnapshot().roles,
        {
          id: '555555555555555555',
          name: 'Extra',
          color: 0,
          hoist: false,
          mentionable: false,
          permissions: '0',
          position: 1,
          managed: false,
          iconUrl: null,
          unicodeEmoji: null,
        },
      ],
    });

    const noDelete = buildRestorePreview({
      snapshot: makeSnapshot(),
      current,
      selection: { categories: ['roles'] },
    });
    expect(noDelete.items.filter((item) => item.action === 'DELETE')).toHaveLength(0);

    const withDelete = buildRestorePreview({
      snapshot: makeSnapshot(),
      current,
      selection: { categories: ['roles'], deleteMissing: true },
    });
    expect(withDelete.items).toContainEqual(
      expect.objectContaining({ action: 'DELETE', id: '555555555555555555', risk: 'HIGH' }),
    );
    expect(withDelete.warnings.join(' ')).toMatch(/irreversible/u);
  });

  it('filters by explicit role and channel IDs', () => {
    const preview = buildRestorePreview({
      snapshot: makeSnapshot(),
      current: makeSnapshot({ roles: [], channels: [] }),
      selection: {
        categories: ['roles', 'channels'],
        roleIds: ['222222222222222222'],
        channelIds: ['999999999999999999'],
      },
    });

    expect(preview.items.map((item) => item.id)).toEqual(['222222222222222222']);
  });

  it('reports unsupported Discord data instead of pretending it is recoverable', () => {
    const preview = buildRestorePreview({
      snapshot: makeSnapshot(),
      current: makeSnapshot(),
      selection: SELECT_ALL,
    });

    expect(preview.unsupported).toEqual([...UNSUPPORTED_SNAPSHOT_DATA]);
    expect(preview.unsupported.join(' ')).toMatch(/Messages/u);
    expect(preview.unsupported.join(' ')).toMatch(/Webhook/u);
  });

  it('counts guild setting changes separately', () => {
    const current = makeSnapshot({
      guild: { ...makeSnapshot().guild, name: 'Renamed' },
    });
    const preview = buildRestorePreview({
      snapshot: makeSnapshot(),
      current,
      selection: { categories: ['guildSettings'] },
    });

    expect(preview.items).toContainEqual(
      expect.objectContaining({ action: 'RESTORE_GUILD_SETTINGS', name: 'Server name' }),
    );
    expect(preview.counts.RESTORE_GUILD_SETTINGS).toBe(1);
  });

  it('starts from zero counts for every action', () => {
    expect(emptyCounts()).toEqual({
      CREATE: 0,
      UPDATE: 0,
      DELETE: 0,
      RESTORE_PERMISSIONS: 0,
      RESTORE_GUILD_SETTINGS: 0,
    });
  });
});

describe('restore selection', () => {
  it('deduplicates categories and IDs and preserves the delete opt-in', () => {
    expect(
      normalizeRestoreSelection({
        categories: ['roles', 'roles', 'channels'],
        roleIds: ['222222222222222222', '222222222222222222'],
        deleteMissing: true,
      }),
    ).toEqual({
      categories: ['roles', 'channels'],
      roleIds: ['222222222222222222'],
      deleteMissing: true,
    });
  });
});
