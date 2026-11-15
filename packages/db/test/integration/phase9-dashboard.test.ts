import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  GuildServices,
  bootstrapGuild,
  claimNextDashboardAction,
  createTenantContext,
  failStaleDashboardActions,
  type Database,
} from '../../src/index.js';
import {
  ACTOR_ID,
  GUILD_A,
  GUILD_B,
  OWNER_ID,
  TARGET_ID,
  createTestDatabase,
  integrationEnabled,
  resetDatabase,
} from './helpers.js';

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration('phase 9 dashboard actions and whitelist updates', () => {
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
      name: 'Phase 9 Guild',
      ownerId: OWNER_ID,
    });
    services = new GuildServices(
      database,
      createTenantContext({ guildId: GUILD_A, actorId: ACTOR_ID }),
    );
  });

  it('updates a whitelist entry in place and records the change', async () => {
    const entry = await services.whitelist.add({
      targetType: 'USER',
      targetId: TARGET_ID,
      scope: 'GLOBAL',
      action: null,
      reason: 'initial reason',
      createdBy: ACTOR_ID,
    });

    const expiresAt = new Date(Date.now() + 3_600_000);
    const updated = await services.whitelist.update(
      entry.id,
      { reason: 'scoped after review', expiresAt },
      ACTOR_ID,
    );

    expect(updated.id).toBe(entry.id);
    expect(updated.reason).toBe('scoped after review');
    expect(updated.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
    expect(updated.targetId).toBe(TARGET_ID);
    await expect(services.audit.count('whitelist.updated')).resolves.toBe(1);
  });

  it('refuses to update an entry across tenants', async () => {
    await bootstrapGuild(database, {
      id: GUILD_B,
      name: 'Other Guild',
      ownerId: OWNER_ID,
    });
    const entry = await services.whitelist.add({
      targetType: 'ROLE',
      targetId: TARGET_ID,
      scope: 'ACTION',
      action: 'MEMBER_BAN',
      reason: 'trusted role',
      createdBy: ACTOR_ID,
    });

    const other = new GuildServices(
      database,
      createTenantContext({ guildId: GUILD_B, actorId: ACTOR_ID }),
    );
    await expect(
      other.whitelist.update(entry.id, { reason: 'hijacked' }, ACTOR_ID),
    ).rejects.toThrow();
  });

  it('queues, claims, and completes a dashboard action exactly once', async () => {
    const created = await services.dashboardActions.create({
      type: 'backup.create',
      actorId: ACTOR_ID,
      payload: { retentionDays: 14 },
    });

    expect(created.status).toBe('PENDING');
    await expect(services.audit.count('dashboard.action.requested')).resolves.toBe(1);

    const claimed = await claimNextDashboardAction(database);
    expect(claimed?.id).toBe(created.id);
    expect(claimed?.status).toBe('RUNNING');

    // A second worker cannot claim the same row.
    expect(await claimNextDashboardAction(database)).toBeNull();

    const completed = await services.dashboardActions.complete(created.id, ACTOR_ID, {
      backupId: 'backup-1',
    });
    expect(completed).toBe(true);
    expect(
      await services.dashboardActions.complete(created.id, ACTOR_ID, { backupId: 'again' }),
    ).toBe(false);

    const stored = await services.dashboardActions.getById(created.id);
    expect(stored?.status).toBe('COMPLETED');
    expect(stored?.result).toEqual({ backupId: 'backup-1' });
    await expect(services.audit.count('dashboard.action.completed')).resolves.toBe(1);
  });

  it('cancels only pending actions and records the cancellation', async () => {
    const first = await services.dashboardActions.create({
      type: 'backup.delete',
      actorId: ACTOR_ID,
      payload: { backupId: 'backup-1' },
    });
    const second = await services.dashboardActions.create({
      type: 'backup.preview',
      actorId: ACTOR_ID,
      payload: { backupId: 'backup-1', selection: { categories: ['roles'] } },
    });

    await database.client.dashboardAction.update({
      where: { id: first.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    await claimNextDashboardAction(database);
    expect(await services.dashboardActions.cancel(first.id, ACTOR_ID)).toBe(false);
    expect(await services.dashboardActions.cancel(second.id, ACTOR_ID)).toBe(true);
    await expect(services.audit.count('dashboard.action.cancelled')).resolves.toBe(1);
  });

  it('fails stale running actions left behind by a restart', async () => {
    const action = await services.dashboardActions.create({
      type: 'backup.create',
      actorId: ACTOR_ID,
      payload: {},
    });
    await claimNextDashboardAction(database);

    await database.client.dashboardAction.update({
      where: { id: action.id },
      data: { startedAt: new Date(Date.now() - 60 * 60_000) },
    });

    expect(await failStaleDashboardActions(database)).toBe(1);
    const stored = await services.dashboardActions.getById(action.id);
    expect(stored?.status).toBe('FAILED');
    expect(stored?.error).toContain('restarted');
  });

  it('keeps queued actions visible only inside their guild', async () => {
    await bootstrapGuild(database, {
      id: GUILD_B,
      name: 'Other Guild',
      ownerId: OWNER_ID,
    });
    const action = await services.dashboardActions.create({
      type: 'backup.create',
      actorId: ACTOR_ID,
      payload: {},
    });

    const other = new GuildServices(
      database,
      createTenantContext({ guildId: GUILD_B, actorId: ACTOR_ID }),
    );
    expect(await other.dashboardActions.getById(action.id)).toBeNull();
    expect(await other.dashboardActions.list(10)).toHaveLength(0);
  });
});
