import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigVersionConflictError,
  GuildServices,
  bootstrapGuild,
  createTenantContext,
  type Database,
} from '../../src/index.js';
import {
  ACTOR_ID,
  GUILD_A,
  OWNER_ID,
  TARGET_ID,
  createTestDatabase,
  integrationEnabled,
  resetDatabase,
} from './helpers.js';

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration('guild configuration persistence', () => {
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
      name: 'Config Guild',
      ownerId: OWNER_ID,
    });
    services = new GuildServices(database, createTenantContext({ guildId: GUILD_A }));
  });

  it('creates complete defaults on bootstrap', async () => {
    const config = await services.config.getOrCreate(ACTOR_ID);

    expect(config.automationMode).toBe('OBSERVE');
    expect(config.version).toBe(1);
    expect(config.locale).toBe('en');
    expect(config.timezone).toBe('UTC');
    expect(config.antiNukeEnabled).toBe(true);
    expect(config.antiRaidEnabled).toBe(true);
    expect(config.beastModeEnabled).toBe(true);
    expect(config.botProtectionEnabled).toBe(true);
    expect(config.loggingEnabled).toBe(true);
    expect(config.automodEnabled).toBe(false);
    expect(config.verificationEnabled).toBe(false);
    expect(config.backupsEnabled).toBe(false);
  });

  it('increments the version and appends an audit diff', async () => {
    const updated = await services.updateConfig(
      { locale: 'de', automodEnabled: true, expectedVersion: 1 },
      ACTOR_ID,
    );

    expect(updated.version).toBe(2);
    expect(updated.locale).toBe('de');
    expect(updated.automodEnabled).toBe(true);
    expect(updated.updatedBy).toBe(ACTOR_ID);

    const audit = await services.audit.list({ action: 'config.updated', limit: 10 });
    const entry = audit.entries[0];

    expect(entry).toBeDefined();
    expect(entry?.actorId).toBe(ACTOR_ID);
    expect(entry?.diff).toMatchObject({
      locale: { before: 'en', after: 'de' },
      automodEnabled: { before: false, after: true },
    });
  });

  it('rejects a stale expected version without writing or auditing', async () => {
    await services.updateConfig({ locale: 'fr' }, ACTOR_ID);
    const auditBefore = await services.audit.count('config.updated');

    await expect(
      services.updateConfig({ locale: 'es', expectedVersion: 1 }, ACTOR_ID),
    ).rejects.toBeInstanceOf(ConfigVersionConflictError);

    expect((await services.getConfig()).locale).toBe('fr');
    await expect(services.audit.count('config.updated')).resolves.toBe(auditBefore);
  });

  it('resets to observation defaults and audits the reset', async () => {
    await services.updateConfig(
      { locale: 'de', automationMode: 'ENFORCE_REVERSIBLE', automodEnabled: true },
      ACTOR_ID,
    );

    const reset = await services.resetConfig(ACTOR_ID);

    expect(reset.automationMode).toBe('OBSERVE');
    expect(reset.locale).toBe('en');
    expect(reset.version).toBe(3);
    await expect(services.audit.count('config.reset')).resolves.toBe(1);
  });

  it('rolls back every write when a transaction fails', async () => {
    const before = await services.audit.count();

    await expect(
      database.transaction(async (transaction) => {
        await transaction.whitelistEntry.create({
          data: {
            guildId: GUILD_A,
            targetType: 'USER',
            targetId: TARGET_ID,
            reason: 'will roll back',
            createdBy: ACTOR_ID,
          },
        });
        await transaction.auditEntry.create({
          data: { guildId: GUILD_A, actorType: 'SYSTEM', action: 'rollback.test' },
        });
        throw new Error('simulated failure');
      }),
    ).rejects.toThrow('simulated failure');

    await expect(services.whitelist.list({ activeOnly: false })).resolves.toEqual([]);
    await expect(services.audit.count()).resolves.toBe(before);
  });
});
