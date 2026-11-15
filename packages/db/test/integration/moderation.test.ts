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
  TARGET_B_ID,
  TARGET_ID,
  createTestDatabase,
  integrationEnabled,
  resetDatabase,
} from './helpers.js';

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration('moderation and incident persistence', () => {
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
      name: 'Moderation Guild',
      ownerId: OWNER_ID,
    });
    services = new GuildServices(database, createTenantContext({ guildId: GUILD_A }));
  });

  it('allocates gap-free case numbers under concurrent writers', async () => {
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        services.moderation.create({
          type: 'WARN',
          targetId: TARGET_ID,
          moderatorId: ACTOR_ID,
          reason: `concurrent warning ${index}`,
        }),
      ),
    );

    const numbers = created.map((entry) => entry.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(created.map((entry) => entry.id)).size).toBe(8);
  });

  it('closes a case once and records it', async () => {
    const moderationCase = await services.moderation.create({
      type: 'TIMEOUT',
      targetId: TARGET_ID,
      moderatorId: ACTOR_ID,
      reason: 'repeated flooding',
      durationSeconds: 600,
    });

    expect(moderationCase.expiresAt).not.toBeNull();
    await expect(services.moderation.close(moderationCase.id, ACTOR_ID)).resolves.toBe(true);
    await expect(services.moderation.close(moderationCase.id, ACTOR_ID)).resolves.toBe(false);

    const stored = await services.moderation.getById(moderationCase.id);
    expect(stored?.status).toBe('CLOSED');
    expect(stored?.closedAt).not.toBeNull();
    await expect(services.audit.count('moderation.case.closed')).resolves.toBe(1);
  });

  it('paginates cases with a stable cursor', async () => {
    for (let index = 0; index < 5; index += 1) {
      await services.moderation.create({
        type: 'WARN',
        targetId: TARGET_ID,
        moderatorId: ACTOR_ID,
        reason: `page case ${index}`,
      });
    }

    const first = await services.moderation.list({ limit: 2 });
    expect(first.cases).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await services.moderation.list({
      limit: 2,
      ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
    });
    expect(second.cases).toHaveLength(2);
    expect(second.cases[0]?.id).not.toBe(first.cases[0]?.id);
  });

  it('deduplicates replayed security events', async () => {
    const incident = await services.incidents.open({
      type: 'SPAM',
      severity: 'HIGH',
      score: 40,
      actorId: TARGET_ID,
    });

    const first = await services.incidents.recordEvent({
      source: 'AUDIT_LOG',
      externalEventId: 'audit-event-1',
      action: 'message.delete',
      actorId: TARGET_ID,
      riskScore: 25,
      incidentId: incident.id,
    });
    const replay = await services.incidents.recordEvent({
      source: 'AUDIT_LOG',
      externalEventId: 'audit-event-1',
      action: 'message.delete',
      actorId: TARGET_ID,
      riskScore: 25,
      incidentId: incident.id,
    });

    expect(replay.id).toBe(first.id);
    await expect(services.incidents.recentEvents()).resolves.toHaveLength(1);
  });

  it('creates, summarises, and revokes warnings with audit history', async () => {
    const created = await services.moderation.warn({
      targetId: TARGET_ID,
      moderatorId: ACTOR_ID,
      reason: 'first warning',
    });

    expect(created.case.type).toBe('WARN');
    expect(created.case.number).toBe(1);
    expect(created.warning.caseId).toBe(created.case.id);

    await services.moderation.warn({
      targetId: TARGET_ID,
      moderatorId: ACTOR_ID,
      reason: 'second warning',
    });

    await expect(services.moderation.warningSummary(TARGET_ID)).resolves.toEqual({
      total: 2,
      active: 2,
    });

    const revoked = await services.moderation.revokeWarning(
      created.warning.id,
      ACTOR_ID,
      'warning issued in error',
    );
    expect(revoked?.case.type).toBe('UNWARN');
    expect(revoked?.warning.active).toBe(false);

    await expect(services.moderation.warningSummary(TARGET_ID)).resolves.toEqual({
      total: 2,
      active: 1,
    });
    await expect(
      services.moderation.revokeWarning(created.warning.id, ACTOR_ID, 'again'),
    ).resolves.toBeNull();

    await expect(services.audit.count('moderation.warning.created')).resolves.toBe(2);
    await expect(services.audit.count('moderation.warning.revoked')).resolves.toBe(1);
  });

  it('filters warning history and case lists', async () => {
    await services.moderation.warn({
      targetId: TARGET_ID,
      moderatorId: ACTOR_ID,
      reason: 'filtered warning',
    });
    await services.moderation.create({
      type: 'KICK',
      targetId: TARGET_ID,
      moderatorId: ACTOR_ID,
      reason: 'filtered kick',
    });
    await services.moderation.create({
      type: 'BAN',
      targetId: TARGET_B_ID,
      moderatorId: ACTOR_ID,
      reason: 'other target',
    });

    await expect(services.moderation.listWarnings(TARGET_ID)).resolves.toHaveLength(1);
    await expect(services.moderation.list({ type: 'KICK' })).resolves.toMatchObject({
      cases: [expect.objectContaining({ type: 'KICK' })],
    });
    const byTarget = await services.moderation.list({ targetId: TARGET_ID });
    expect(byTarget.cases).toHaveLength(2);
    expect(byTarget.cases.every((entry) => entry.targetId === TARGET_ID)).toBe(true);
    await expect(services.moderation.list({ status: 'OPEN' })).resolves.toMatchObject({
      cases: expect.any(Array),
    });
  });

  it('excludes expired temporary whitelist entries from active lookups', async () => {
    const active = await services.whitelist.add({
      targetType: 'USER',
      targetId: TARGET_ID,
      reason: 'temporary staff coverage',
      createdBy: ACTOR_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const expired = await services.whitelist.add({
      targetType: 'USER',
      targetId: TARGET_B_ID,
      reason: 'expired coverage',
      createdBy: ACTOR_ID,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const activeEntries = await services.whitelist.list({ activeOnly: true });
    expect(activeEntries.map((entry) => entry.id)).toContain(active.id);
    expect(activeEntries.map((entry) => entry.id)).not.toContain(expired.id);

    await expect(services.whitelist.findActive('USER', TARGET_ID)).resolves.toHaveLength(1);
    await expect(services.whitelist.findActive('USER', TARGET_B_ID)).resolves.toHaveLength(0);

    await expect(services.whitelist.revoke(active.id, ACTOR_ID, 'coverage ended')).resolves.toBe(
      true,
    );
    await expect(services.whitelist.revoke(active.id, ACTOR_ID)).resolves.toBe(false);
    await expect(services.audit.count('whitelist.revoked')).resolves.toBe(1);
  });

  it('excludes expired staff grants from active lookups', async () => {
    const active = await services.access.grant({
      subjectType: 'USER',
      subjectId: ACTOR_ID,
      permissionKeys: ['moderation.warn', 'moderation.timeout'],
      grantedBy: OWNER_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await services.access.grant({
      subjectType: 'ROLE',
      subjectId: TARGET_B_ID,
      permissionKeys: ['moderation.kick'],
      grantedBy: OWNER_ID,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const grants = await services.access.listActive();
    expect(grants.map((grant) => grant.id)).toEqual([active.id]);

    await expect(services.access.findForSubject('USER', ACTOR_ID)).resolves.toMatchObject({
      permissionKeys: ['moderation.warn', 'moderation.timeout'],
    });
    await expect(services.access.findForSubject('ROLE', TARGET_B_ID)).resolves.toBeNull();

    await expect(services.access.revoke(active.id, OWNER_ID)).resolves.toBe(true);
    await expect(services.access.listActive()).resolves.toHaveLength(0);
  });

  it('keeps moderation, whitelist, and grants isolated per guild', async () => {
    await bootstrapGuild(database, {
      id: GUILD_B,
      name: 'Other Guild',
      ownerId: TARGET_B_ID,
    });

    const caseA = await services.moderation.create({
      type: 'WARN',
      targetId: TARGET_ID,
      moderatorId: ACTOR_ID,
      reason: 'guild A case',
    });
    const entryA = await services.whitelist.add({
      targetType: 'USER',
      targetId: TARGET_ID,
      reason: 'guild A trust',
      createdBy: ACTOR_ID,
    });
    const grantA = await services.access.grant({
      subjectType: 'USER',
      subjectId: ACTOR_ID,
      permissionKeys: ['moderation.warn'],
      grantedBy: OWNER_ID,
    });

    const guildB = new GuildServices(database, createTenantContext({ guildId: GUILD_B }));

    await expect(guildB.moderation.list()).resolves.toMatchObject({ cases: [] });
    await expect(guildB.moderation.findByNumber(caseA.number)).resolves.toBeNull();
    await expect(guildB.moderation.listWarnings(TARGET_ID)).resolves.toHaveLength(0);
    await expect(guildB.whitelist.list({ activeOnly: false })).resolves.toHaveLength(0);
    await expect(guildB.access.listActive()).resolves.toHaveLength(0);

    await expect(guildB.moderation.close(caseA.id, OWNER_ID)).rejects.toThrow();
    await expect(guildB.whitelist.revoke(entryA.id, OWNER_ID)).rejects.toThrow();
    await expect(guildB.access.revoke(grantA.id, OWNER_ID)).rejects.toThrow();

    // The original guild still sees its own data.
    await expect(services.moderation.findByNumber(caseA.number)).resolves.toMatchObject({
      id: caseA.id,
    });
    await expect(services.whitelist.list({ activeOnly: true })).resolves.toHaveLength(1);
    await expect(services.access.listActive()).resolves.toHaveLength(1);
  });
});
