import { describe, expect, it } from 'vitest';

import {
  backupRequestChannel,
  createRequestId,
  decodeBackupRequest,
  encodeBackupRequest,
  type BackupRequest,
} from '../../src/backup/requests.js';

const GUILD = '111111111111111111';
const NOW = '2026-01-01T00:00:00.000Z';

describe('backup request protocol', () => {
  it('round-trips a scheduled backup request', () => {
    const request: BackupRequest = {
      version: 1,
      type: 'scheduled-backup',
      guildId: GUILD,
      retentionDays: 30,
      requestId: 'req-1',
      requestedAt: NOW,
    };

    expect(decodeBackupRequest(encodeBackupRequest(request))).toEqual(request);
  });

  it('round-trips a retention sweep request', () => {
    const request: BackupRequest = {
      version: 1,
      type: 'retention-sweep',
      requestId: 'req-2',
      requestedAt: NOW,
    };

    expect(decodeBackupRequest(encodeBackupRequest(request))).toEqual(request);
  });

  it('rejects malformed, unknown, and cross-version requests', () => {
    expect(decodeBackupRequest('not json')).toBeNull();
    expect(decodeBackupRequest(JSON.stringify({ version: 2, type: 'retention-sweep' }))).toBeNull();
    expect(
      decodeBackupRequest(
        JSON.stringify({
          version: 1,
          type: 'scheduled-backup',
          guildId: 'bad',
          retentionDays: 30,
          requestId: 'req-1',
          requestedAt: NOW,
        }),
      ),
    ).toBeNull();
    expect(
      decodeBackupRequest(
        JSON.stringify({
          version: 1,
          type: 'scheduled-backup',
          guildId: GUILD,
          retentionDays: 0,
          requestId: 'req-1',
          requestedAt: NOW,
        }),
      ),
    ).toBeNull();
  });

  it('builds a namespaced channel with prefix validation', () => {
    expect(backupRequestChannel('t77')).toBe('t77:backup:requests');
    expect(backupRequestChannel('t77-staging')).toBe('t77-staging:backup:requests');
    expect(() => backupRequestChannel('Bad Prefix')).toThrow();
  });

  it('creates unique request IDs', () => {
    const date = new Date(NOW);
    expect(createRequestId(date)).toMatch(/^backup-/u);
    expect(createRequestId(date)).not.toBe(createRequestId(date));
  });
});
