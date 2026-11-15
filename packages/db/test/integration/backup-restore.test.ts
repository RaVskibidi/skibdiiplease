import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  GuildServices,
  bootstrapGuild,
  createTenantContext,
  listGuildsDueForBackup,
  markScheduledBackupAt,
  type Database,
} from '../../src/index.js';
import {
  ACTOR_ID,
  GUILD_A,
  GUILD_B,
  OWNER_ID,
  createTestDatabase,
  integrationEnabled,
  resetDatabase,
} from './helpers.js';

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration('backup and restore persistence', () => {
  let database: Database;
  let services: GuildServices;

  beforeAll(async () => {
    database = createTestDatabase();
    await database.connect();
  });

  afterAll(async () => {
    await database.disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(database);
    await bootstrapGuild(database, {
      id: GUILD_A,
      name: 'Backup Guild',
      ownerId: OWNER_ID,
    });
    services = new GuildServices(database, createTenantContext({ guildId: GUILD_A }));
  });

  async function readyBackup(overrides: { retentionUntil?: Date | null } = {}) {
    const backup = await services.backups.create({
      type: 'MANUAL',
      createdBy: ACTOR_ID,
      retentionUntil:
        overrides.retentionUntil === undefined
          ? new Date(Date.now() + 30 * 86_400_000)
          : overrides.retentionUntil,
    });
    await services.backups.markCapturing(backup.id);
    await services.backups.markReady(backup.id, {
      objectKey: `guilds/${GUILD_A}/backups/${backup.id}.json.gz`,
      checksum: 'a'.repeat(64),
      sizeBytes: 1_024n,
      schemaVersion: 1,
    });
    const stored = await services.backups.getById(backup.id);
    if (stored === null) {
      throw new Error('backup was not stored');
    }
    return stored;
  }

  it('tracks backup metadata lifecycle and audits every transition', async () => {
    const backup = await services.backups.create({
      type: 'MANUAL',
      createdBy: ACTOR_ID,
      retentionUntil: new Date(Date.now() + 86_400_000),
    });

    expect(backup.status).toBe('PENDING');
    await expect(services.backups.markCapturing(backup.id)).resolves.toBe(true);
    await expect(services.backups.markCapturing(backup.id)).resolves.toBe(false);

    await expect(
      services.backups.markReady(backup.id, {
        objectKey: `guilds/${GUILD_A}/backups/${backup.id}.json.gz`,
        checksum: 'b'.repeat(64),
        sizeBytes: 2_048n,
      }),
    ).resolves.toBe(true);

    const ready = await services.backups.findReady(backup.id);
    expect(ready).toMatchObject({ status: 'READY', schemaVersion: 1 });
    expect(ready?.sizeBytes).toBe(2_048n);
    await expect(services.backups.listReadyWithObject()).resolves.toHaveLength(1);
    await expect(services.backups.list()).resolves.toHaveLength(1);

    await expect(services.audit.count('backup.created')).resolves.toBe(1);
    await expect(services.audit.count('backup.updated')).resolves.toBe(1);
  });

  it('records a failed capture without pretending it is ready', async () => {
    const backup = await services.backups.create({ type: 'SCHEDULED', createdBy: ACTOR_ID });
    await services.backups.markCapturing(backup.id);

    await expect(services.backups.markFailed(backup.id, 'storage offline')).resolves.toBe(true);

    const stored = await services.backups.getById(backup.id);
    expect(stored?.status).toBe('FAILED');
    expect(stored?.error).toBe('storage offline');
    await expect(services.backups.findReady(backup.id)).resolves.toBeNull();
  });

  it('lists only expired backups and soft-deletes them idempotently', async () => {
    const expired = await readyBackup({ retentionUntil: new Date(Date.now() - 60_000) });
    const active = await readyBackup();

    const expiredRows = await services.backups.listExpired();
    expect(expiredRows.map((row) => row.id)).toEqual([expired.id]);
    expect(expiredRows.map((row) => row.id)).not.toContain(active.id);

    await expect(services.backups.markDeleted(expired.id, null, 'retention policy')).resolves.toBe(
      true,
    );
    await expect(services.backups.markDeleted(expired.id, null, 'again')).resolves.toBe(false);
    await expect(services.backups.listExpired()).resolves.toHaveLength(0);
    await expect(services.audit.count('backup.deleted')).resolves.toBe(1);
  });

  it('runs the restore job state machine and audits each step', async () => {
    const backup = await readyBackup();

    const job = await services.restores.create({
      backupId: backup.id,
      requestedBy: ACTOR_ID,
      confirmationId: 'preview-token-1',
      selection: { categories: ['roles', 'permissions'], deleteMissing: false },
    });
    expect(job.status).toBe('PENDING');

    await expect(services.restores.markPreviewed(job.id, ACTOR_ID)).resolves.toBe(true);
    await expect(services.restores.attachConfirmation(job.id, 'RESTORE', ACTOR_ID)).resolves.toBe(
      true,
    );
    await expect(services.restores.markRunning(job.id, ACTOR_ID)).resolves.toBe(true);
    await expect(services.restores.updateProgress(job.id, 55)).resolves.toBe(true);
    await expect(services.restores.complete(job.id, ACTOR_ID, [])).resolves.toBe(true);
    await expect(services.restores.complete(job.id, ACTOR_ID, [])).resolves.toBe(false);

    const finished = await services.restores.getById(job.id);
    expect(finished).toMatchObject({ status: 'COMPLETED', progress: 100 });
    expect(finished?.startedAt).not.toBeNull();
    expect(finished?.completedAt).not.toBeNull();

    await expect(services.audit.count('backup.restore.requested')).resolves.toBeGreaterThanOrEqual(
      1,
    );
    await expect(services.audit.count('backup.restore.previewed')).resolves.toBeGreaterThanOrEqual(
      1,
    );
    await expect(services.audit.count('backup.restore.completed')).resolves.toBe(1);
    await expect(services.restores.list()).resolves.toHaveLength(1);
  });

  it('supports failing and cancelling restore jobs with recorded errors', async () => {
    const backup = await readyBackup();
    const failing = await services.restores.create({
      backupId: backup.id,
      requestedBy: ACTOR_ID,
      confirmationId: 'preview-token-2',
      selection: { categories: ['roles'] },
    });
    await services.restores.markRunning(failing.id, ACTOR_ID);
    await expect(
      services.restores.fail(failing.id, ACTOR_ID, [
        { item: 'roles:1', reason: 'Missing Manage Roles' },
      ]),
    ).resolves.toBe(true);

    const failed = await services.restores.getById(failing.id);
    expect(failed?.status).toBe('FAILED');
    expect(Array.isArray(failed?.errors)).toBe(true);

    const cancelling = await services.restores.create({
      backupId: backup.id,
      requestedBy: ACTOR_ID,
      confirmationId: 'preview-token-3',
      selection: { categories: ['channels'] },
    });
    await expect(services.restores.cancel(cancelling.id, ACTOR_ID)).resolves.toBe(true);
    expect((await services.restores.getById(cancelling.id))?.status).toBe('CANCELLED');
    await expect(services.audit.count('backup.restore.failed')).resolves.toBe(1);
    await expect(services.audit.count('backup.restore.cancelled')).resolves.toBe(1);
  });

  it('rejects restore jobs that reference another guild backup', async () => {
    await bootstrapGuild(database, {
      id: GUILD_B,
      name: 'Other Guild',
      ownerId: OWNER_ID,
    });
    const other = new GuildServices(database, createTenantContext({ guildId: GUILD_B }));
    const foreign = await other.backups.create({ type: 'MANUAL', createdBy: ACTOR_ID });

    await expect(
      services.restores.create({
        backupId: foreign.id,
        requestedBy: ACTOR_ID,
        confirmationId: 'preview-token-4',
        selection: { categories: ['roles'] },
      }),
    ).rejects.toThrow();
  });

  it('isolates backups and restore jobs per guild', async () => {
    await bootstrapGuild(database, {
      id: GUILD_B,
      name: 'Other Guild',
      ownerId: OWNER_ID,
    });
    const backup = await readyBackup();
    const job = await services.restores.create({
      backupId: backup.id,
      requestedBy: ACTOR_ID,
      confirmationId: 'preview-token-5',
      selection: { categories: ['roles'] },
    });

    const guildB = new GuildServices(database, createTenantContext({ guildId: GUILD_B }));
    await expect(guildB.backups.list()).resolves.toHaveLength(0);
    await expect(guildB.backups.getById(backup.id)).resolves.toBeNull();
    await expect(guildB.restores.list()).resolves.toHaveLength(0);
    await expect(guildB.restores.getById(job.id)).resolves.toBeNull();
    await expect(guildB.backups.markDeleted(backup.id, OWNER_ID, 'cross-tenant')).rejects.toThrow();

    await expect(services.backups.list()).resolves.toHaveLength(1);
  });

  it('schedules due backups and records the last request time', async () => {
    await services.config.update(
      {
        backupsEnabled: true,
        backupIntervalHours: 6,
        backupRetentionDays: 14,
      },
      OWNER_ID,
    );

    const now = new Date();
    const due = await listGuildsDueForBackup(database, now);
    expect(due).toEqual([
      {
        guildId: GUILD_A,
        intervalHours: 6,
        retentionDays: 14,
        lastScheduledBackupAt: null,
      },
    ]);

    await expect(markScheduledBackupAt(database, GUILD_A, now)).resolves.toBe(true);
    await expect(
      listGuildsDueForBackup(database, new Date(now.getTime() + 60_000)),
    ).resolves.toEqual([]);
    await expect(
      listGuildsDueForBackup(database, new Date(now.getTime() + 7 * 3_600_000)),
    ).resolves.toHaveLength(1);
  });

  it('excludes guilds with scheduled backups disabled or removed', async () => {
    await bootstrapGuild(database, {
      id: GUILD_B,
      name: 'Other Guild',
      ownerId: OWNER_ID,
    });
    const other = new GuildServices(database, createTenantContext({ guildId: GUILD_B }));
    await other.config.update({ backupsEnabled: true, backupIntervalHours: 1 }, OWNER_ID);
    await services.config.update({ backupsEnabled: false }, OWNER_ID);

    const due = await listGuildsDueForBackup(database);
    expect(due.map((row) => row.guildId)).toEqual([GUILD_B]);

    await database.client.guild.update({
      where: { id: GUILD_B },
      data: { botLeftAt: new Date() },
    });
    await expect(listGuildsDueForBackup(database)).resolves.toHaveLength(0);
  });
});
