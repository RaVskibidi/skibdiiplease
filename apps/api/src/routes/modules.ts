import { Router } from 'express';
import { z } from 'zod';

import {
  antiNukeActionSchema,
  antiRaidConfigUpdateSchema,
  automodConfigUpdateSchema,
  beastModeSettingsUpdateSchema,
  TenantRecordNotFoundError,
  verificationConfigUpdateSchema,
  whitelistUpdateSchema,
} from '@t77/db';

import { jsonSafe } from '../crypto.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../http/errors.js';
import { requireOwnerOrGrant } from '../auth/middleware.js';
import {
  actorId,
  guildIdOf,
  param,
  parseLimit,
  servicesFor,
  type RouteDependencies,
} from './helpers.js';
import type { AuthMiddlewareOptions } from '../auth/middleware.js';
import { parseDurationSeconds } from './guild.js';

export interface ModuleRouteOptions extends RouteDependencies, AuthMiddlewareOptions {}

const antiNukeRulePatchSchema = z
  .object({
    action: antiNukeActionSchema,
    enabled: z.boolean().optional(),
    threshold: z.number().int().min(1).max(10_000).optional(),
    windowSeconds: z.number().int().min(1).max(86_400).optional(),
    containment: z
      .enum(['ALERT', 'QUARANTINE', 'ROLE_REMOVAL', 'TIMEOUT', 'KICK', 'BAN'])
      .optional(),
    requiresDestructiveApproval: z.boolean().optional(),
    cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
  })
  .strict();

const antiNukePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    rules: z.array(antiNukeRulePatchSchema).max(64).optional(),
  })
  .strict()
  .refine(
    (value) => value.enabled !== undefined || value.rules !== undefined,
    'at least one Anti-Nuke field is required',
  );

const approvalSchema = z
  .object({
    mode: z.enum(['ENFORCE_REVERSIBLE', 'ENFORCE_DESTRUCTIVE']),
    policyVersion: z.string().trim().min(1).max(64).default('dashboard-1'),
    confirm: z.literal(true),
  })
  .strict();

const beastOverrideSchema = z
  .object({
    action: z.enum(['activate', 'calm']),
    reason: z.string().trim().min(3).max(500),
    confirmation: z.string().trim().min(6).max(128),
  })
  .strict();

const whitelistCreateBodySchema = z
  .object({
    targetType: z.enum(['USER', 'ROLE', 'CHANNEL']),
    targetId: z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake'),
    scope: z.enum(['GLOBAL', 'ACTION']).default('GLOBAL'),
    action: antiNukeActionSchema.nullable().optional(),
    reason: z.string().trim().min(3).max(500),
    duration: z.string().trim().min(1).max(16).optional(),
  })
  .strict();

const whitelistPatchBodySchema = z
  .object({
    scope: z.enum(['GLOBAL', 'ACTION']).optional(),
    action: antiNukeActionSchema.nullable().optional(),
    reason: z.string().trim().min(3).max(500).optional(),
    duration: z.string().trim().min(1).max(16).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export function createModuleRouter(options: ModuleRouteOptions): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/anti-nuke',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const [config, rules, punishments] = await Promise.all([
        services.getConfig(),
        services.security.listRules(),
        services.security.listPunishments(),
      ]);
      res.json(
        jsonSafe({
          enabled: config.antiNukeEnabled,
          automationMode: config.automationMode,
          approvedAt: config.enforcementApprovedAt,
          rules,
          punishments,
        }),
      );
    }),
  );

  router.patch(
    '/anti-nuke',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      const parsed = antiNukePatchSchema.parse(req.body);
      const services = servicesFor(options, req);
      const actor = actorId(req);

      let config = await services.getConfig();
      if (parsed.enabled !== undefined) {
        config = await services.updateConfig({ antiNukeEnabled: parsed.enabled }, actor);
      }

      const updatedRules = [];
      for (const rule of parsed.rules ?? []) {
        const { action, ...changes } = rule;
        updatedRules.push(await services.security.updateRule(action, changes, actor));
      }

      res.json(
        jsonSafe({
          enabled: config.antiNukeEnabled,
          rules: updatedRules,
        }),
      );
    }),
  );

  router.post(
    '/anti-nuke/approval',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      if (req.t77?.guild?.owner !== true) {
        throw forbidden('Only the Discord server owner can approve enforcement.');
      }
      const parsed = approvalSchema.parse(req.body);
      const services = servicesFor(options, req);
      const config = await services.approveEnforcement({
        mode: parsed.mode,
        approvedBy: actorId(req),
        policyVersion: parsed.policyVersion,
      });
      res.json(jsonSafe({ config }));
    }),
  );

  router.get(
    '/anti-raid',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const [config, state, quarantined] = await Promise.all([
        services.antiRaid.getOrCreate(),
        services.getConfig(),
        services.quarantine.listActive(100),
      ]);
      res.json(
        jsonSafe({
          config,
          automationMode: state.automationMode,
          approvedAt: state.enforcementApprovedAt,
          quarantined,
        }),
      );
    }),
  );

  router.patch(
    '/anti-raid',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const config = await services.antiRaid.update(
        antiRaidConfigUpdateSchema.parse(req.body),
        actorId(req),
      );
      res.json(jsonSafe({ config }));
    }),
  );

  router.get(
    '/beast-mode',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const [state, config, incidents] = await Promise.all([
        services.beastMode.getOrCreate(),
        services.getConfig(),
        services.incidents.list({ limit: 10 }),
      ]);
      res.json(
        jsonSafe({
          state,
          enabled: config.beastModeEnabled,
          incidents,
          owner: req.t77?.guild?.owner ?? false,
        }),
      );
    }),
  );

  router.patch(
    '/beast-mode',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const state = await services.beastMode.updateSettings(
        beastModeSettingsUpdateSchema.parse(req.body),
        actorId(req),
      );
      res.json(jsonSafe({ state }));
    }),
  );

  router.post(
    '/beast-mode/override',
    requireOwnerOrGrant(options, 'beast.override'),
    asyncHandler(async (req, res) => {
      if (req.t77?.guild?.owner !== true) {
        throw forbidden('Only the Discord server owner can override Beast Mode.');
      }
      const parsed = beastOverrideSchema.parse(req.body);
      const services = servicesFor(options, req);
      const action = await services.dashboardActions.create({
        type: 'beast.override',
        actorId: actorId(req),
        payload: { action: parsed.action, reason: parsed.reason },
        confirmationId: parsed.confirmation,
      });
      res.status(202).json(jsonSafe({ action }));
    }),
  );

  router.get(
    '/anti-spam',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const config = await services.automod.getOrCreate();
      res.json(jsonSafe({ config, section: antiSpamFields(config) }));
    }),
  );

  router.patch(
    '/anti-spam',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const config = await services.automod.update(
        automodConfigUpdateSchema.parse(req.body),
        actorId(req),
      );
      res.json(jsonSafe({ config, section: antiSpamFields(config) }));
    }),
  );

  router.get(
    '/automod',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const config = await services.automod.getOrCreate();
      res.json(jsonSafe({ config }));
    }),
  );

  router.patch(
    '/automod',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const config = await services.automod.update(
        automodConfigUpdateSchema.parse(req.body),
        actorId(req),
      );
      res.json(jsonSafe({ config }));
    }),
  );

  router.get(
    '/verification',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const [config, challenges, pending, passed, expired] = await Promise.all([
        services.verification.getOrCreate(),
        services.verification.listRecent(25),
        services.verification.countByStatus('PENDING'),
        services.verification.countByStatus('PASSED'),
        services.verification.countByStatus('EXPIRED'),
      ]);
      res.json(
        jsonSafe({
          config,
          challenges,
          counts: { pending, passed, expired },
        }),
      );
    }),
  );

  router.patch(
    '/verification',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const config = await services.verification.update(
        verificationConfigUpdateSchema.parse(req.body),
        actorId(req),
      );
      res.json(jsonSafe({ config }));
    }),
  );

  router.get(
    '/whitelist',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const includeRevoked = req.query.includeRevoked === 'true';
      const entries = await services.whitelist.list({
        activeOnly: !includeRevoked,
        limit: parseLimit(req.query.limit, 100, 500),
      });
      res.json(jsonSafe({ entries, includeRevoked }));
    }),
  );

  router.post(
    '/whitelist',
    requireOwnerOrGrant(options, 'whitelist.manage'),
    asyncHandler(async (req, res) => {
      const parsed = whitelistCreateBodySchema.parse(req.body);
      const services = servicesFor(options, req);
      const entry = await services.whitelist.add({
        targetType: parsed.targetType,
        targetId: parsed.targetId,
        scope: parsed.scope,
        action: parsed.action ?? null,
        reason: parsed.reason,
        createdBy: actorId(req),
        expiresAt:
          parsed.duration === undefined
            ? null
            : new Date(Date.now() + parseDurationSeconds(parsed.duration) * 1_000),
      });
      res.status(201).json(jsonSafe({ entry }));
    }),
  );

  router.patch(
    '/whitelist/:entryId',
    requireOwnerOrGrant(options, 'whitelist.manage'),
    asyncHandler(async (req, res) => {
      const parsed = whitelistPatchBodySchema.parse(req.body);
      const services = servicesFor(options, req);
      const update = whitelistUpdateSchema.parse({
        ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
        ...(parsed.action === undefined ? {} : { action: parsed.action }),
        ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
        ...(parsed.duration === undefined
          ? {}
          : {
              expiresAt:
                parsed.duration === null
                  ? null
                  : new Date(Date.now() + parseDurationSeconds(parsed.duration) * 1_000),
            }),
      });
      const entry = await services.whitelist.update(param(req, 'entryId'), update, actorId(req));
      res.json(jsonSafe({ entry }));
    }),
  );

  router.delete(
    '/whitelist/:entryId',
    requireOwnerOrGrant(options, 'whitelist.manage'),
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const entryId = param(req, 'entryId');
      const revoked = await services.whitelist.revoke(entryId, actorId(req));
      if (!revoked) {
        throw new TenantRecordNotFoundError('whitelist entry', entryId);
      }
      res.status(204).end();
    }),
  );

  router.get(
    '/moderation/cases',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const type = typeof req.query.type === 'string' ? req.query.type : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const targetId = typeof req.query.targetId === 'string' ? req.query.targetId : undefined;
      const moderatorId =
        typeof req.query.moderatorId === 'string' ? req.query.moderatorId : undefined;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

      const page = await services.moderation.list({
        limit: parseLimit(req.query.limit, 50, 200),
        ...(type === undefined ? {} : { type: type as never }),
        ...(status === undefined ? {} : { status: status as never }),
        ...(targetId === undefined ? {} : { targetId }),
        ...(moderatorId === undefined ? {} : { moderatorId }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      res.json(jsonSafe(page));
    }),
  );

  router.get(
    '/moderation/cases/:caseId',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const caseId = param(req, 'caseId');
      const record = /^\d+$/u.test(caseId)
        ? await services.moderation.findByNumber(Number(caseId))
        : await services.moderation.getById(caseId);
      if (record === null) {
        throw notFound('Moderation case not found.');
      }
      const warnings = /^\d{17,20}$/u.test(record.targetId)
        ? await services.moderation.listWarnings(record.targetId, {
            activeOnly: false,
            limit: 100,
          })
        : [];
      res.json(jsonSafe({ case: record, warnings }));
    }),
  );

  router.get(
    '/moderation/warnings',
    asyncHandler(async (req, res) => {
      const targetId = typeof req.query.targetId === 'string' ? req.query.targetId : '';
      if (!/^\d{17,20}$/u.test(targetId)) {
        throw badRequest('targetId must be a Discord snowflake.');
      }
      const services = servicesFor(options, req);
      const [warnings, summary] = await Promise.all([
        services.moderation.listWarnings(targetId, {
          activeOnly: req.query.activeOnly !== 'false',
          limit: parseLimit(req.query.limit, 50, 200),
        }),
        services.moderation.warningSummary(targetId),
      ]);
      res.json(jsonSafe({ warnings, summary }));
    }),
  );

  router.get(
    '/quarantine',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const entries = await services.quarantine.listActive(parseLimit(req.query.limit, 100, 500));
      res.json(jsonSafe({ entries, guildId: guildIdOf(req) }));
    }),
  );

  return router;
}

function antiSpamFields(config: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'enabled',
    'floodMessages',
    'floodWindowSeconds',
    'duplicateWindowSeconds',
    'duplicateThreshold',
    'mentionLimit',
    'capsPercentage',
    'capsMinimumLength',
    'inviteLinksBlocked',
    'ignoreStaff',
    'warnEnabled',
    'timeoutEnabled',
    'timeoutAfterWarnings',
    'deleteOffendingMessage',
    'timeoutSeconds',
  ];
  return Object.fromEntries(keys.map((key) => [key, config[key]]));
}
