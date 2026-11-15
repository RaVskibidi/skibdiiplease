import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { defaultAntiNukeRules } from '@t77/security-core';

import {
  GuildServices,
  OwnerApprovalRequiredError,
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

describeIntegration('Phase 4 security persistence', () => {
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

  it('seeds every default rule once and keeps owner edits', async () => {
    const seeds = defaultAntiNukeRules();
    const first = await services.security.ensureRules(seeds);

    expect(first).toHaveLength(27);
    expect(new Set(first.map((rule) => rule.action)).size).toBe(27);
    expect(first.every((rule) => rule.containment === 'ALERT')).toBe(true);

    await services.security.updateRule(
      'MEMBER_BAN',
      { threshold: 7, containment: 'TIMEOUT' },
      ACTOR_ID,
    );

    const second = await services.security.ensureRules(seeds);
    const ban = second.find((rule) => rule.action === 'MEMBER_BAN');

    expect(second).toHaveLength(27);
    expect(ban?.threshold).toBe(7);
    expect(ban?.containment).toBe('TIMEOUT');

    const audit = await services.audit.list({ action: 'antinuke.rules.seeded', limit: 10 });
    expect(audit.entries).toHaveLength(1);
  });

  it('records events idempotently and stores engine metadata without rewriting identity', async () => {
    const occurredAt = new Date('2026-01-01T00:00:00.000Z');
    const input = {
      source: 'AUDIT_LOG' as const,
      externalEventId: 'audit:1',
      action: 'MEMBER_BAN',
      actorId: ACTOR_ID,
      targetId: TARGET_ID,
      riskScore: 0,
      payload: { attribution: 'CERTAIN' },
      occurredAt,
    };

    const first = await services.incidents.recordEventOnce(input);
    const second = await services.incidents.recordEventOnce({ ...input, riskScore: 99 });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(second.event.actorId).toBe(ACTOR_ID);
    expect(second.event.externalEventId).toBe('audit:1');
    expect(second.event.occurredAt.toISOString()).toBe(occurredAt.toISOString());

    await services.incidents.updateEvent(first.event.id, { riskScore: 45 });
    const updated = await services.incidents.recentEvents(1);

    expect(updated[0]?.riskScore).toBe(45);
  });

  it('opens one incident per actor/type, updates severity, and links events', async () => {
    const event = await services.incidents.recordEventOnce({
      source: 'AUDIT_LOG',
      externalEventId: 'audit:2',
      action: 'CHANNEL_DELETE',
      actorId: ACTOR_ID,
      targetId: TARGET_ID,
      riskScore: 20,
      occurredAt: new Date(),
    });

    const opened = await services.incidents.open({
      type: 'NUKING',
      severity: 'MEDIUM',
      score: 20,
      actorId: ACTOR_ID,
      actorSummary: 'Actor test',
      metadata: { automationMode: 'OBSERVE' },
    });

    expect(await services.incidents.findOpenForActor(ACTOR_ID, 'NUKING')).not.toBeNull();

    await services.incidents.updateScore(opened.id, {
      score: 60,
      severity: 'HIGH',
      status: 'MONITORING',
      metadata: { blockedReason: 'OBSERVE_MODE' },
    });

    await services.incidents.attachEvent(event.event.id, opened.id);

    const linked = await services.incidents.recentEvents(1);
    expect(linked[0]?.incidentId).toBe(opened.id);

    const incident = await services.incidents.getById(opened.id);
    expect(incident?.score).toBe(60);
    expect(incident?.severity).toBe('HIGH');
    expect(incident?.status).toBe('MONITORING');
  });

  it('creates punishments once per idempotency key and tracks status transitions', async () => {
    const first = await services.security.createPunishment({
      actorId: ACTOR_ID,
      type: 'TIMEOUT',
      status: 'PROPOSED',
      idempotencyKey: 'antinuke:inc-1:actor:timeout',
      reason: 'Threshold exceeded',
    });

    const duplicate = await services.security.createPunishment({
      actorId: ACTOR_ID,
      type: 'TIMEOUT',
      status: 'PROPOSED',
      idempotencyKey: 'antinuke:inc-1:actor:timeout',
      reason: 'Threshold exceeded',
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.punishment.id).toBe(first.punishment.id);

    await services.security.updatePunishment(first.punishment.id, { status: 'APPLIED' });
    const applied = await services.security.listPunishments({ status: 'APPLIED' });

    expect(applied).toHaveLength(1);
    expect(applied[0]?.appliedAt).not.toBeNull();

    const audit = await services.audit.list({ action: 'security.punishment.applied', limit: 5 });
    expect(audit.entries).toHaveLength(1);
  });

  it('approves and revokes bots with an auditable lifecycle', async () => {
    await services.security.approveBot({
      botId: TARGET_ID,
      approvedBy: OWNER_ID,
      reason: 'Verified moderation bot',
    });

    expect(await services.security.isBotApproved(TARGET_ID)).toBe(true);
    expect(await services.security.listBotApprovals()).toHaveLength(1);

    expect(await services.security.revokeBot(TARGET_ID, OWNER_ID)).toBe(true);
    expect(await services.security.isBotApproved(TARGET_ID)).toBe(false);
    expect(await services.security.revokeBot(TARGET_ID, OWNER_ID)).toBe(false);
  });

  it('routes log categories per guild', async () => {
    await services.security.setLogChannel({
      category: 'ANTI_NUKE',
      channelId: TARGET_ID,
      updatedBy: ACTOR_ID,
    });
    await services.security.setLogChannel({
      category: 'SECURITY',
      channelId: GUILD_A,
      updatedBy: ACTOR_ID,
    });

    const channels = await services.security.listLogChannels();
    expect(channels).toHaveLength(2);
    expect((await services.security.getLogChannel('ANTI_NUKE'))?.channelId).toBe(TARGET_ID);

    const otherServices = new GuildServices(database, createTenantContext({ guildId: GUILD_B }));
    expect(await otherServices.security.listLogChannels()).toHaveLength(0);
  });

  it('requires the recorded guild owner to approve enforcement', async () => {
    await expect(
      services.approveEnforcement({
        mode: 'ENFORCE_REVERSIBLE',
        approvedBy: ACTOR_ID,
        policyVersion: 'phase4-anti-nuke-v1',
      }),
    ).rejects.toBeInstanceOf(OwnerApprovalRequiredError);

    const config = await services.approveEnforcement({
      mode: 'ENFORCE_DESTRUCTIVE',
      approvedBy: OWNER_ID,
      policyVersion: 'phase4-anti-nuke-v1',
    });

    expect(config.automationMode).toBe('ENFORCE_DESTRUCTIVE');
    expect(config.enforcementApprovedBy).toBe(OWNER_ID);
    expect(config.enforcementApprovedAt).not.toBeNull();
    expect(config.enforcementPolicyVersion).toBe('phase4-anti-nuke-v1');

    const revoked = await services.revokeEnforcement(OWNER_ID, 'Drill complete');
    expect(revoked.automationMode).toBe('OBSERVE');
    expect(revoked.enforcementApprovedAt).toBeNull();
    expect(revoked.enforcementApprovedBy).toBeNull();

    const audit = await services.audit.list({ action: 'config.enforcement.approved', limit: 5 });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.actorId).toBe(OWNER_ID);
  });

  it('does not expose another guild’s rules through the tenant scope', async () => {
    await services.security.ensureRules(defaultAntiNukeRules());

    const otherServices = new GuildServices(database, createTenantContext({ guildId: GUILD_B }));
    expect(await otherServices.security.listRules()).toHaveLength(0);
  });
});
