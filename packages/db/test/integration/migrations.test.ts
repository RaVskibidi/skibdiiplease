import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, integrationEnabled, resetDatabase } from './helpers.js';
import type { Database } from '../../src/index.js';

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration('database migrations', () => {
  let database: Database;

  beforeAll(async () => {
    database = createTestDatabase();
    await database.connect();
  });

  afterAll(async () => {
    await database.disconnect();
  });

  it('applies every migration from a clean database', async () => {
    const rows = await database.client.$queryRaw<Array<{ name: string }>>`
      SELECT migration_name AS name FROM "_prisma_migrations" ORDER BY started_at
    `;

    expect(rows.map((row) => row.name)).toEqual([
      '20261114152901_init',
      '20261114153000_audit_append_only',
      '20261114160000_phase4_webhook_delete',
      '20261114185927_phase5_raid_beast',
      '20261114224000_phase6_automod_verification',
      '20261114230000_phase8_backup_retention',
      '20261115090000_phase9_dashboard_actions',
      '20261115091000_phase9_oauth_refresh_iv',
    ]);
  });

  it('creates every tenant table', async () => {
    const rows = await database.client.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const tables = new Set(rows.map((row) => row.table_name));

    for (const table of [
      'guilds',
      'guild_configs',
      'guild_resources',
      'anti_nuke_rules',
      'anti_raid_configs',
      'beast_mode_states',
      'automod_configs',
      'verification_configs',
      'log_channels',
      'whitelist_entries',
      'access_grants',
      'bot_approvals',
      'security_incidents',
      'security_events',
      'punishments',
      'moderation_cases',
      'warnings',
      'audit_entries',
      'critical_approvals',
      'verification_challenges',
      'backups',
      'restore_jobs',
      'oauth_identities',
      'oauth_credentials',
      'dashboard_sessions',
      'dashboard_actions',
    ]) {
      expect(tables.has(table), `missing table ${table}`).toBe(true);
    }
  });

  it('never stores Discord tokens in plaintext columns', async () => {
    const rows = await database.client.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('oauth_credentials', 'dashboard_sessions')
      ORDER BY column_name
    `;
    const columns = rows.map((row) => row.column_name);

    expect(columns).toContain('accessTokenCiphertext');
    expect(columns).toContain('refreshTokenCiphertext');
    expect(columns).not.toContain('accessToken');
    expect(columns).not.toContain('refreshToken');
  });

  it('enforces the append-only audit trail in PostgreSQL', async () => {
    await resetDatabase(database);

    await database.client.guild.create({
      data: { id: '111111111111111111', name: 'Audit Test', ownerId: '333333333333333333' },
    });

    const entry = await database.client.auditEntry.create({
      data: {
        guildId: '111111111111111111',
        actorType: 'SYSTEM',
        action: 'test.created',
      },
    });

    await expect(
      database.client.auditEntry.update({
        where: { id: entry.id },
        data: { action: 'test.tampered' },
      }),
    ).rejects.toThrow();

    await expect(database.client.auditEntry.delete({ where: { id: entry.id } })).rejects.toThrow();

    await expect(
      database.client.$executeRawUnsafe('TRUNCATE TABLE "audit_entries"'),
    ).rejects.toThrow();
  });
});
