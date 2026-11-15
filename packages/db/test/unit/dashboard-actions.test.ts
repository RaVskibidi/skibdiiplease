import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_ACTION_TYPES,
  parseDashboardActionPayload,
  restoreSelectionPayloadSchema,
} from '../../src/dashboard/actions.js';

describe('dashboard action protocol', () => {
  it('accepts a minimal backup create payload', () => {
    const result = parseDashboardActionPayload(DASHBOARD_ACTION_TYPES.BACKUP_CREATE, {});
    expect(result).toEqual({
      ok: true,
      type: 'backup.create',
      payload: {},
    });
  });

  it('rejects an out-of-range retention value', () => {
    const result = parseDashboardActionPayload('backup.create', { retentionDays: 0 });
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('message');
  });

  it('requires a backup identifier for delete and preview', () => {
    expect(parseDashboardActionPayload('backup.delete', {}).ok).toBe(false);
    expect(parseDashboardActionPayload('backup.preview', { backupId: 'backup-1' }).ok).toBe(false);
  });

  it('accepts a restore preview with categories only', () => {
    const result = parseDashboardActionPayload('backup.preview', {
      backupId: 'backup-1',
      selection: { categories: ['roles', 'channels'] },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown restore categories and deletion-less empty selections', () => {
    expect(
      parseDashboardActionPayload('backup.preview', {
        backupId: 'backup-1',
        selection: { categories: ['everyone'] },
      }).ok,
    ).toBe(false);

    expect(restoreSelectionPayloadSchema.safeParse({ categories: [] }).success).toBe(false);
  });

  it('requires a confirmation identifier for restore', () => {
    expect(
      parseDashboardActionPayload('backup.restore', {
        backupId: 'backup-1',
        jobId: 'job-1',
      }).ok,
    ).toBe(false);

    const result = parseDashboardActionPayload('backup.restore', {
      backupId: 'backup-1',
      jobId: 'job-1',
      confirmationId: 'RESTORE',
    });
    expect(result.ok).toBe(true);
  });

  it('validates Beast override actions', () => {
    expect(
      parseDashboardActionPayload('beast.override', {
        action: 'activate',
        reason: 'Raid',
      }).ok,
    ).toBe(true);
    expect(
      parseDashboardActionPayload('beast.override', {
        action: 'explode',
        reason: 'Raid',
      }).ok,
    ).toBe(false);
  });

  it('refuses unknown action types', () => {
    const result = parseDashboardActionPayload('guild.delete', {});
    expect(result).toEqual({
      ok: false,
      message: 'Unsupported dashboard action type: guild.delete',
    });
  });

  it('rejects extra fields rather than silently dropping them', () => {
    expect(
      parseDashboardActionPayload('backup.create', { retentionDays: 10, destructive: true }).ok,
    ).toBe(false);
  });
});
