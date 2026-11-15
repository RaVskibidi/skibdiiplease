import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  GuildServices,
  bootstrapGuild,
  createTenantContext,
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

describeIntegration('Phase 5 Anti-Raid, Beast Mode, and quarantine persistence', () => {
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
    await bootstrapGuild(database, { id: GUILD_A, name: 'Security Guild', ownerId: OWNER_ID });
    await bootstrapGuild(database, { id: GUILD_B, name: 'Other Guild', ownerId: TARGET_ID });
    services = new GuildServices(database, createTenantContext({ guildId: GUILD_A }));
  });

  it('creates observation-safe Anti-Raid defaults and audits policy edits', async () => {
    const initial = await services.antiRaid.getOrCreate();

    expect(initial.enabled).toBe(true);
    expect(initial.aggregateThreshold).toBe(10);
    expect(initial.minimumSignals).toBe(2);
    expect(initial.riskThreshold).toBe(60);
    expect(initial.quarantineEnabled).toBe(true);
    expect(initial.autoBanEnabled).toBe(false);
    expect(initial.lockdownEnabled).toBe(false);
    expect(initial.verificationRequired).toBe(true);

    const updated = await services.antiRaid.update(
      {
        aggregateThreshold: 6,
        minimumSignals: 3,
        riskThreshold: 55,
        quarantineRoleId: TARGET_ID,
        lockdownEnabled: true,
      },
      ACTOR_ID,
    );

    expect(updated.aggregateThreshold).toBe(6);
    expect(updated.quarantineRoleId).toBe(TARGET_ID);
    expect(updated.lockdownEnabled).toBe(true);

    const audit = await services.audit.list({ action: 'antiraid.config.updated', limit: 5 });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.actorId).toBe(ACTOR_ID);
  });

  it('rejects an Anti-Raid velocity threshold that could punish a single join', async () => {
    await expect(services.antiRaid.update({ aggregateThreshold: 1 }, ACTOR_ID)).rejects.toThrow();
    await expect(services.antiRaid.update({}, ACTOR_ID)).rejects.toThrow();
  });

  it('persists Beast Mode settings, activation, score, and deactivation', async () => {
    const initial = await services.beastMode.getOrCreate();
    expect(initial.active).toBe(false);
    expect(initial.emergencyLockdown).toBe(false);

    const settings = await services.beastMode.updateSettings(
      { threshold: 120, durationMinutes: 90, emergencyLockdown: true },
      ACTOR_ID,
    );
    expect(settings.threshold).toBe(120);
    expect(settings.durationMinutes).toBe(90);

    const expiresAt = new Date(Date.now() + 90 * 60_000);
    const active = await services.beastMode.activate({
      score: 120,
      expiresAt,
      incidentId: null,
      reason: 'Integration drill',
      activatedBy: ACTOR_ID,
    });

    expect(active.active).toBe(true);
    expect(active.activatedBy).toBe(ACTOR_ID);
    expect(active.expiresAt?.toISOString()).toBe(expiresAt.toISOString());

    const rescored = await services.beastMode.updateScore(75);
    expect(rescored.score).toBe(75);

    const deactivated = await services.beastMode.deactivate({
      actorId: OWNER_ID,
      reason: 'Drill complete',
    });
    expect(deactivated.active).toBe(false);
    expect(deactivated.score).toBe(0);
    expect(deactivated.overrideBy).toBe(OWNER_ID);

    const activatedAudit = await services.audit.list({ action: 'beast.activated', limit: 5 });
    const deactivatedAudit = await services.audit.list({ action: 'beast.deactivated', limit: 5 });
    expect(activatedAudit.entries).toHaveLength(1);
    expect(deactivatedAudit.entries).toHaveLength(1);
  });

  it('keeps Beast Mode settings private to the owning guild', async () => {
    await services.beastMode.updateSettings({ threshold: 250 }, ACTOR_ID);

    const other = new GuildServices(database, createTenantContext({ guildId: GUILD_B }));
    const defaults = await other.beastMode.getOrCreate();

    expect(defaults.threshold).not.toBe(250);
  });

  it('applies one active quarantine per member and releases it idempotently', async () => {
    const first = await services.quarantine.apply({
      userId: TARGET_ID,
      roleId: GUILD_A,
      reason: 'Raid burst',
      requiresVerification: true,
    });

    expect(first.status).toBe('ACTIVE');

    const refreshed = await services.quarantine.apply({
      userId: TARGET_ID,
      roleId: GUILD_A,
      reason: 'Updated reason',
      requiresVerification: false,
    });

    expect(refreshed.id).toBe(first.id);
    expect(refreshed.reason).toBe('Updated reason');
    expect(await services.quarantine.countActive()).toBe(1);
    expect(await services.quarantine.findActiveByUser(TARGET_ID)).not.toBeNull();
    expect(await services.quarantine.listActive()).toHaveLength(1);

    const released = await services.quarantine.release({
      entryId: first.id,
      releasedBy: ACTOR_ID,
      reason: 'Verified',
    });

    expect(released?.status).toBe('RELEASED');
    expect(released?.releasedBy).toBe(ACTOR_ID);
    expect(await services.quarantine.countActive()).toBe(0);

    const secondRelease = await services.quarantine.release({
      entryId: first.id,
      releasedBy: ACTOR_ID,
    });
    expect(secondRelease?.status).toBe('RELEASED');

    const audit = await services.audit.list({ action: 'quarantine.applied', limit: 5 });
    expect(audit.entries).toHaveLength(2);
  });

  it('does not expose another guild’s quarantines', async () => {
    await services.quarantine.apply({
      userId: TARGET_ID,
      roleId: GUILD_A,
      reason: 'Raid burst',
    });

    const other = new GuildServices(database, createTenantContext({ guildId: GUILD_B }));
    expect(await other.quarantine.countActive()).toBe(0);
    expect(await other.quarantine.findActiveByUser(TARGET_ID)).toBeNull();
  });

  it('coalesces an open raid incident by type and window', async () => {
    const opened = await services.incidents.open({
      type: 'RAID',
      severity: 'MEDIUM',
      score: 40,
      actorId: null,
      actorSummary: 'Join burst',
      metadata: { signals: ['JOIN_VELOCITY'] },
    });

    const found = await services.incidents.findOpenByTypeSince(
      'RAID',
      new Date(Date.now() - 10 * 60_000),
    );
    expect(found?.id).toBe(opened.id);

    const outsideWindow = await services.incidents.findOpenByTypeSince(
      'RAID',
      new Date(Date.now() + 60_000),
    );
    expect(outsideWindow).toBeNull();

    const beastIncident = await services.incidents.findOpenByTypeSince(
      'BEAST_MODE',
      new Date(Date.now() - 10 * 60_000),
    );
    expect(beastIncident).toBeNull();
  });
});
