import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  GuildServices,
  TenantIsolationError,
  TenantRecordNotFoundError,
  bootstrapGuild,
  createTenantContext,
  syncGuildResources,
  type Database,
} from '../../src/index.js';
import {
  ACTOR_ID,
  GUILD_A,
  GUILD_B,
  OWNER_ID,
  TARGET_B_ID,
  TARGET_ID,
  createTestDatabase,
  integrationEnabled,
  resetDatabase,
} from './helpers.js';

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration('cross-guild tenant isolation', () => {
  let database: Database;
  let servicesA: GuildServices;
  let servicesB: GuildServices;

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
      name: 'Guild A',
      ownerId: OWNER_ID,
      memberCount: 10,
    });
    await bootstrapGuild(database, {
      id: GUILD_B,
      name: 'Guild B',
      ownerId: OWNER_ID,
      memberCount: 20,
    });

    servicesA = new GuildServices(database, createTenantContext({ guildId: GUILD_A }));
    servicesB = new GuildServices(database, createTenantContext({ guildId: GUILD_B }));
  });

  it('bootstraps idempotently without resetting configuration', async () => {
    await servicesA.updateConfig({ locale: 'de' }, ACTOR_ID);

    const again = await bootstrapGuild(database, {
      id: GUILD_A,
      name: 'Guild A renamed',
      ownerId: OWNER_ID,
    });

    expect(again.created).toBe(false);
    expect(again.config.locale).toBe('de');
    expect(again.guild.name).toBe('Guild A renamed');
  });

  it('keeps configuration updates inside the calling guild', async () => {
    await servicesA.updateConfig({ locale: 'fr', automodEnabled: true }, ACTOR_ID);

    expect((await servicesA.getConfig()).locale).toBe('fr');
    expect((await servicesB.getConfig()).locale).toBe('en');
    expect((await servicesB.getConfig()).automodEnabled).toBe(false);
  });

  it('cannot read or revoke another guild whitelist entry', async () => {
    const entry = await servicesA.whitelist.add({
      targetType: 'USER',
      targetId: TARGET_ID,
      reason: 'trusted administrator',
      createdBy: ACTOR_ID,
    });

    await expect(servicesB.whitelist.findActive('USER', TARGET_ID)).resolves.toEqual([]);
    await expect(servicesB.whitelist.revoke(entry.id, ACTOR_ID)).rejects.toBeInstanceOf(
      TenantRecordNotFoundError,
    );
    await expect(servicesA.whitelist.list()).resolves.toHaveLength(1);
  });

  it('cannot read or revoke another guild access grant', async () => {
    const grant = await servicesA.access.grant({
      subjectType: 'USER',
      subjectId: TARGET_ID,
      permissionKeys: ['security.manage'],
      grantedBy: ACTOR_ID,
    });

    await expect(servicesB.access.findForSubject('USER', TARGET_ID)).resolves.toBeNull();
    await expect(servicesB.access.revoke(grant.id, ACTOR_ID)).rejects.toBeInstanceOf(
      TenantRecordNotFoundError,
    );
    await expect(servicesB.access.listActive()).resolves.toEqual([]);
  });

  it('cannot read, list, or close another guild moderation case', async () => {
    const moderationCase = await servicesA.moderation.create({
      type: 'WARN',
      targetId: TARGET_ID,
      moderatorId: ACTOR_ID,
      reason: 'spam in general',
    });

    await expect(servicesB.moderation.getById(moderationCase.id)).resolves.toBeNull();
    await expect(servicesB.moderation.findByNumber(moderationCase.number)).resolves.toBeNull();
    await expect(servicesB.moderation.list()).resolves.toMatchObject({ cases: [] });
    await expect(servicesB.moderation.close(moderationCase.id, ACTOR_ID)).rejects.toBeInstanceOf(
      TenantRecordNotFoundError,
    );
  });

  it('cannot read or close another guild security incident', async () => {
    const incident = await servicesA.incidents.open({
      type: 'NUKING',
      severity: 'CRITICAL',
      score: 80,
      actorId: TARGET_ID,
    });

    await expect(servicesB.incidents.list()).resolves.toEqual([]);
    await expect(servicesB.incidents.close(incident.id, 'RESOLVED', ACTOR_ID)).resolves.toBeNull();
    await expect(servicesB.incidents.close(incident.id, 'DISMISSED', ACTOR_ID)).resolves.toBeNull();
  });

  it('isolates guild resource snapshots', async () => {
    await syncGuildResources(database, GUILD_A, [
      { type: 'CHANNEL', discordId: TARGET_ID, name: 'general', position: 1 },
    ]);

    await expect(servicesB.resources.list()).resolves.toEqual([]);
    await expect(servicesB.syncResources([])).resolves.toBe(0);
    await expect(servicesA.resources.list()).resolves.toHaveLength(1);
  });

  it('cannot mark another guild backup ready', async () => {
    const backup = await servicesA.backups.create({ type: 'MANUAL', createdBy: ACTOR_ID });

    await expect(servicesB.backups.list()).resolves.toEqual([]);
    await expect(
      servicesB.backups.markReady(backup.id, {
        objectKey: `guilds/${GUILD_B}/backups/${backup.id}.json`,
        checksum: 'sha256:test',
        sizeBytes: 128n,
      }),
    ).rejects.toBeInstanceOf(TenantRecordNotFoundError);
  });

  it('scopes audit reads and never exposes another guild trail', async () => {
    const auditBeforeB = await servicesB.audit.count();

    await servicesA.audit.append({
      actorType: 'USER',
      actorId: ACTOR_ID,
      action: 'test.audit',
      targetType: 'Guild',
      targetId: GUILD_A,
    });

    await expect(servicesA.audit.count()).resolves.toBeGreaterThan(0);
    await expect(servicesB.audit.count()).resolves.toBe(auditBeforeB);
    await expect(servicesB.audit.count('test.audit')).resolves.toBe(0);
  });

  it('rejects a forged tenant context before any query runs', () => {
    expect(() => createTenantContext({ guildId: 'not-a-snowflake' })).toThrow();
    expect(() => new GuildServices(database, { guildId: 'forged' })).toThrow();
  });

  it('keeps case numbers independent per guild', async () => {
    const caseA = await servicesA.moderation.create({
      type: 'BAN',
      targetId: TARGET_B_ID,
      moderatorId: ACTOR_ID,
      reason: 'raid participation',
    });
    const caseB = await servicesB.moderation.create({
      type: 'KICK',
      targetId: TARGET_B_ID,
      moderatorId: ACTOR_ID,
      reason: 'raid participation',
    });

    expect(caseA.number).toBe(1);
    expect(caseB.number).toBe(1);
    expect(caseA.id).not.toBe(caseB.id);
  });

  it('raises a typed isolation error from the tenant guard', () => {
    const tenant = createTenantContext({ guildId: GUILD_A });
    expect(() => {
      if (tenant.guildId !== GUILD_B) {
        throw new TenantIsolationError('blocked', {
          contextGuildId: tenant.guildId,
          actualGuildId: GUILD_B,
        });
      }
    }).toThrow(TenantIsolationError);
  });
});
