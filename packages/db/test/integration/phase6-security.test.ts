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

describeIntegration('Phase 6 AutoMod and verification persistence', () => {
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

  it('creates observation-safe AutoMod defaults', async () => {
    const config = await services.automod.getOrCreate();

    expect(config.enabled).toBe(false);
    expect(config.floodMessages).toBe(8);
    expect(config.duplicateThreshold).toBe(3);
    expect(config.timeoutAfterWarnings).toBe(3);
    expect(config.timeoutEnabled).toBe(true);
    expect(config.warnEnabled).toBe(true);
    expect(config.highConfidenceRules).toEqual([]);
    expect(config.exemptUserIds).toEqual([]);
  });

  it('persists a policy edit and writes an audit entry', async () => {
    const updated = await services.automod.update(
      {
        enabled: true,
        floodMessages: 5,
        bannedWords: ['badword'],
        blockedDomains: ['example.com'],
        exemptUserIds: [TARGET_ID],
        highConfidenceRules: ['BLOCKED_WORD'],
        timeoutAfterWarnings: 2,
      },
      ACTOR_ID,
    );

    expect(updated.enabled).toBe(true);
    expect(updated.floodMessages).toBe(5);
    expect(updated.bannedWords).toEqual(['badword']);
    expect(updated.highConfidenceRules).toEqual(['BLOCKED_WORD']);

    const audit = await services.audit.list({ action: 'automod.config.updated', limit: 5 });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.actorId).toBe(ACTOR_ID);
  });

  it('rejects invalid AutoMod configuration instead of silently persisting it', async () => {
    await expect(services.automod.update({}, ACTOR_ID)).rejects.toThrow();
    await expect(services.automod.update({ floodMessages: 1 }, ACTOR_ID)).rejects.toThrow();
    await expect(
      services.automod.update({ exemptChannelIds: ['not-a-snowflake'] }, ACTOR_ID),
    ).rejects.toThrow();
    await expect(
      services.automod.update({ highConfidenceRules: ['NOT_A_RULE' as never] }, ACTOR_ID),
    ).rejects.toThrow();
    await expect(
      services.automod.update({ unexpectedField: true } as never, ACTOR_ID),
    ).rejects.toThrow();
  });

  it('keeps AutoMod policy private to the owning guild', async () => {
    await services.automod.update({ enabled: true, floodMessages: 3 }, ACTOR_ID);

    const other = new GuildServices(database, createTenantContext({ guildId: GUILD_B }));
    const defaults = await other.automod.getOrCreate();

    expect(defaults.enabled).toBe(false);
    expect(defaults.floodMessages).toBe(8);
  });

  it('creates a disabled button verification configuration by default', async () => {
    const config = await services.verification.getOrCreate();

    expect(config.enabled).toBe(false);
    expect(config.mode).toBe('BUTTON');
    expect(config.challengeLength).toBe(6);
    expect(config.timeoutSeconds).toBe(300);
    expect(config.maxAttempts).toBe(3);
    expect(config.releaseQuarantineOnPass).toBe(true);
    expect(config.buttonFallbackEnabled).toBe(false);
  });

  it('validates verification configuration and audits updates', async () => {
    const updated = await services.verification.update(
      {
        enabled: true,
        mode: 'CAPTCHA',
        verifiedRoleId: TARGET_ID,
        channelId: GUILD_A,
        maxAttempts: 5,
      },
      ACTOR_ID,
    );

    expect(updated.enabled).toBe(true);
    expect(updated.mode).toBe('CAPTCHA');
    expect(updated.maxAttempts).toBe(5);

    await expect(services.verification.update({ challengeLength: 2 }, ACTOR_ID)).rejects.toThrow();
    await expect(
      services.verification.update({ mode: 'SMS' as never }, ACTOR_ID),
    ).rejects.toThrow();
    await expect(services.verification.update({}, ACTOR_ID)).rejects.toThrow();

    const audit = await services.audit.list({
      action: 'verification.config.updated',
      limit: 5,
    });
    expect(audit.entries).toHaveLength(1);
  });

  it('supersedes a pending challenge when a new one is issued', async () => {
    const first = await services.verification.createChallenge({
      userId: TARGET_ID,
      mode: 'CAPTCHA',
      answerHash: 'hash-one',
      maxAttempts: 3,
      expiresAt: new Date(Date.now() + 300_000),
    });

    const second = await services.verification.createChallenge({
      userId: TARGET_ID,
      mode: 'CAPTCHA',
      answerHash: 'hash-two',
      maxAttempts: 3,
      expiresAt: new Date(Date.now() + 300_000),
    });

    const pending = await services.verification.findPendingForUser(TARGET_ID);
    expect(pending?.id).toBe(second.id);

    const firstReloaded = await services.verification.findById(first.id);
    expect(firstReloaded?.status).toBe('INVALIDATED');

    const audit = await services.audit.list({
      action: 'verification.challenge.issued',
      limit: 10,
    });
    expect(audit.entries).toHaveLength(2);
  });

  it('records a failed attempt and then a pass with distinct audit actions', async () => {
    const challenge = await services.verification.createChallenge({
      userId: TARGET_ID,
      mode: 'CAPTCHA',
      answerHash: 'hash',
      maxAttempts: 3,
      expiresAt: new Date(Date.now() + 300_000),
    });

    const afterFailure = await services.verification.recordFailedAttempt({
      challengeId: challenge.id,
      attempts: 1,
      status: 'PENDING',
      failureReason: 'incorrect answer',
      attemptedAt: new Date(),
    });

    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.status).toBe('PENDING');
    expect(afterFailure.lastAttemptAt).not.toBeNull();

    const passed = await services.verification.markPassed(challenge.id);
    expect(passed.status).toBe('PASSED');
    expect(passed.completedAt).not.toBeNull();

    const failedAudit = await services.audit.list({
      action: 'verification.challenge.failed',
      limit: 5,
    });
    const passedAudit = await services.audit.list({
      action: 'verification.challenge.passed',
      limit: 5,
    });
    expect(failedAudit.entries).toHaveLength(1);
    expect(passedAudit.entries).toHaveLength(1);
  });

  it('lists only overdue pending challenges for the sweeper', async () => {
    const overdue = await services.verification.createChallenge({
      userId: TARGET_ID,
      mode: 'BUTTON',
      answerHash: 'hash',
      maxAttempts: 1,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await services.verification.createChallenge({
      userId: OWNER_ID,
      mode: 'BUTTON',
      answerHash: 'hash',
      maxAttempts: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const expired = await services.verification.listExpired(new Date());
    expect(expired.map((entry) => entry.id)).toEqual([overdue.id]);

    await services.verification.markExpired(overdue.id);
    expect(await services.verification.listExpired(new Date())).toHaveLength(0);
    expect(await services.verification.countByStatus('EXPIRED')).toBe(1);
  });

  it('keeps verification challenges private to the owning guild', async () => {
    const challenge = await services.verification.createChallenge({
      userId: TARGET_ID,
      mode: 'BUTTON',
      answerHash: 'hash',
      maxAttempts: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const other = new GuildServices(database, createTenantContext({ guildId: GUILD_B }));
    expect(await other.verification.findById(challenge.id)).toBeNull();
    expect(await other.verification.findPendingForUser(TARGET_ID)).toBeNull();
    expect(await other.verification.countByStatus('PENDING')).toBe(0);
  });
});
