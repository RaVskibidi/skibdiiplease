import { Router } from 'express';
import { z } from 'zod';

import {
  ConfigVersionConflictError,
  guildConfigUpdateSchema,
  TenantRecordNotFoundError,
  type GuildConfig,
} from '@t77/db';
import { T77_PERMISSION_LABELS, T77_PERMISSION_KEYS } from '@t77/security-core';

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

export interface GuildRouteOptions extends RouteDependencies, AuthMiddlewareOptions {}

const approvalSchema = z
  .object({
    mode: z.enum(['ENFORCE_REVERSIBLE', 'ENFORCE_DESTRUCTIVE']),
    policyVersion: z.string().trim().min(1).max(64).default('dashboard-1'),
    confirm: z.literal(true),
  })
  .strict();

const staffGrantSchema = z
  .object({
    subjectType: z.enum(['USER', 'ROLE']),
    subjectId: z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake'),
    permissionKeys: z.array(z.string().trim().min(1)).min(1).max(32),
    duration: z.string().trim().min(1).max(16).optional(),
  })
  .strict();

const botProtectionSchema = z.object({ enabled: z.boolean() }).strict();

const botApprovalSchema = z
  .object({
    botId: z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake'),
    reason: z.string().trim().min(3).max(500),
    duration: z.string().trim().min(1).max(16).optional(),
  })
  .strict();

export function createGuildRouter(options: GuildRouteOptions): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/overview',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const guildId = guildIdOf(req);

      const [guild, config, cases, incidents, resources, events, actions] = await Promise.all([
        services.guild.get(),
        services.getConfig(),
        services.moderation.list({ limit: 6 }),
        services.incidents.list({ limit: 6 }),
        services.resources.list(),
        services.incidents.recentEvents(12),
        services.dashboardActions.list(5),
      ]);

      const openIncidents = incidents.filter(
        (incident) => incident.status === 'OPEN' || incident.status === 'MONITORING',
      );
      const counts = resources.reduce<Record<string, number>>((accumulator, resource) => {
        accumulator[resource.type] = (accumulator[resource.type] ?? 0) + 1;
        return accumulator;
      }, {});

      const logChannels = await services.security.listLogChannels();
      const score = securityScore({
        config,
        openIncidents: openIncidents.length,
        logChannelCount: logChannels.length,
      });

      res.json(
        jsonSafe({
          guild: {
            id: guild.id,
            name: guild.name,
            iconUrl: guild.iconUrl,
            memberCount: guild.memberCount,
            ownerId: guild.ownerId,
            botJoinedAt: guild.botJoinedAt,
          },
          security: { score, grade: gradeFor(score), openIncidents: openIncidents.length },
          modules: moduleStates(config),
          enforcement: {
            automationMode: config.automationMode,
            approvedAt: config.enforcementApprovedAt,
            approvedBy: config.enforcementApprovedBy,
          },
          incidents,
          cases: cases.cases,
          events,
          resources: counts,
          actions,
          generatedAt: new Date().toISOString(),
          guildId,
        }),
      );
    }),
  );

  router.get(
    '/config',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const config = await services.getConfig();
      const logChannels = await services.security.listLogChannels();
      res.json(jsonSafe({ config, logChannels }));
    }),
  );

  router.patch(
    '/config',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const actor = actorId(req);
      const body = req.body as Record<string, unknown>;
      const { confirm, ...rest } = body;
      const parsed = guildConfigUpdateSchema.parse(rest);

      if (parsed.automationMode !== undefined && parsed.automationMode !== 'OBSERVE') {
        const auth = req.t77;
        if (auth?.guild?.owner !== true) {
          throw forbidden('Only the server owner can change automation enforcement.');
        }
        if (confirm !== true) {
          throw forbidden('Confirm the enforcement change before saving.');
        }
      }

      try {
        let config = await services.updateConfig(parsed, actor);

        if (
          parsed.automationMode === 'ENFORCE_REVERSIBLE' ||
          parsed.automationMode === 'ENFORCE_DESTRUCTIVE'
        ) {
          config = await services.approveEnforcement({
            mode: parsed.automationMode,
            approvedBy: actor,
            policyVersion: 'dashboard-1',
          });
        } else if (parsed.automationMode === 'OBSERVE') {
          config = await services.revokeEnforcement(
            actor,
            'Dashboard returned T77 to observation mode.',
          );
        }

        res.json(jsonSafe({ config }));
      } catch (error) {
        if (error instanceof ConfigVersionConflictError) {
          throw error;
        }
        throw error;
      }
    }),
  );

  router.post(
    '/config/reset',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const actor = actorId(req);
      const schema = z.object({ confirm: z.literal(true) }).strict();
      schema.parse(req.body);
      const config = await services.resetConfig(actor);
      res.json(jsonSafe({ config }));
    }),
  );

  router.post(
    '/config/approval',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      const auth = req.t77;
      if (auth?.guild?.owner !== true) {
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

  router.post(
    '/config/revoke-enforcement',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      const schema = z.object({ reason: z.string().trim().max(500).optional() }).strict();
      const parsed = schema.parse(req.body ?? {});
      const services = servicesFor(options, req);
      const config = await services.revokeEnforcement(actorId(req), parsed.reason);
      res.json(jsonSafe({ config }));
    }),
  );

  router.get(
    '/security',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const [config, incidents, resources, logChannels, backups, botApprovals] = await Promise.all([
        services.getConfig(),
        services.incidents.list({ limit: 25 }),
        services.resources.list(),
        services.security.listLogChannels(),
        services.backups.list(5),
        services.security.listBotApprovals({ activeOnly: true }),
      ]);

      const counts = resources.reduce<Record<string, number>>((accumulator, resource) => {
        accumulator[resource.type] = (accumulator[resource.type] ?? 0) + 1;
        return accumulator;
      }, {});
      const openIncidents = incidents.filter(
        (incident) => incident.status === 'OPEN' || incident.status === 'MONITORING',
      );
      const score = securityScore({
        config,
        openIncidents: openIncidents.length,
        logChannelCount: logChannels.length,
      });

      const recommendations: Array<{ id: string; severity: string; message: string }> = [];
      if (logChannels.length === 0) {
        recommendations.push({
          id: 'logging',
          severity: 'HIGH',
          message: 'No log channel is configured. Use /t77 logs to route security events.',
        });
      }
      if (!config.verificationEnabled) {
        recommendations.push({
          id: 'verification',
          severity: 'MEDIUM',
          message: 'Verification is disabled. Enable it to gate new members.',
        });
      }
      if (!config.backupsEnabled) {
        recommendations.push({
          id: 'backups',
          severity: 'MEDIUM',
          message: 'Scheduled backups are disabled. Enable them before a destructive change.',
        });
      }
      if (config.automationMode === 'OBSERVE') {
        recommendations.push({
          id: 'enforcement',
          severity: 'INFO',
          message: 'T77 is in observation mode. Destructive enforcement is disabled.',
        });
      }

      res.json(
        jsonSafe({
          security: { score, grade: gradeFor(score), openIncidents: openIncidents.length },
          config,
          incidents,
          resources: counts,
          logChannels,
          botApprovals,
          backups,
          recommendations,
          unavailable: [
            {
              id: 'role-permissions',
              message:
                'Role permission bitfields are not stored in the dashboard database. Run /t77 scan in Discord for a live permission audit.',
            },
            {
              id: 'webhooks',
              message: 'Webhook inventory requires a live Discord scan. Run /t77 scan in Discord.',
            },
          ],
        }),
      );
    }),
  );

  router.get(
    '/audit-logs',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const action = typeof req.query.action === 'string' ? req.query.action : undefined;
      const actor = typeof req.query.actorId === 'string' ? req.query.actorId : undefined;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const result = await services.audit.list({
        limit: parseLimit(req.query.limit, 50, 200),
        ...(action === undefined ? {} : { action }),
        ...(actor === undefined ? {} : { actorId: actor }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      res.json(jsonSafe(result));
    }),
  );

  router.get(
    '/staff',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const [grants, logChannels] = await Promise.all([
        services.access.listActive(),
        services.security.listLogChannels(),
      ]);
      res.json(
        jsonSafe({
          grants,
          logChannels,
          catalogue: T77_PERMISSION_KEYS.map((key) => ({
            key,
            label: T77_PERMISSION_LABELS[key],
          })),
          actor: {
            id: actorId(req),
            owner: req.t77?.guild?.owner ?? false,
          },
        }),
      );
    }),
  );

  router.post(
    '/staff',
    requireOwnerOrGrant(options, 'staff.manage'),
    asyncHandler(async (req, res) => {
      const parsed = staffGrantSchema.parse(req.body);
      const permissions = parsed.permissionKeys.filter((key) =>
        (T77_PERMISSION_KEYS as readonly string[]).includes(key),
      );
      if (permissions.length === 0) {
        throw forbidden('At least one known T77 permission key is required.');
      }
      const expiresAt =
        parsed.duration === undefined
          ? null
          : new Date(Date.now() + parseDurationSeconds(parsed.duration) * 1_000);

      const services = servicesFor(options, req);
      const grant = await services.access.grant({
        subjectType: parsed.subjectType,
        subjectId: parsed.subjectId,
        permissionKeys: permissions,
        grantedBy: actorId(req),
        expiresAt,
      });
      res.status(201).json(jsonSafe({ grant }));
    }),
  );

  router.delete(
    '/staff/:grantId',
    requireOwnerOrGrant(options, 'staff.manage'),
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const grantId = param(req, 'grantId');
      const revoked = await services.access.revoke(grantId, actorId(req));
      if (!revoked) {
        throw new TenantRecordNotFoundError('access grant', grantId);
      }
      res.status(204).end();
    }),
  );

  router.get(
    '/bot-protection',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const [config, approvals] = await Promise.all([
        services.getConfig(),
        services.security.listBotApprovals({ activeOnly: false }),
      ]);
      res.json(
        jsonSafe({
          enabled: config.botProtectionEnabled,
          approvals,
          active: approvals.filter((approval) => approval.revokedAt === null),
        }),
      );
    }),
  );

  router.patch(
    '/bot-protection',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      const parsed = botProtectionSchema.parse(req.body);
      const services = servicesFor(options, req);
      const config = await services.updateConfig(
        { botProtectionEnabled: parsed.enabled },
        actorId(req),
      );
      res.json(jsonSafe({ enabled: config.botProtectionEnabled }));
    }),
  );

  router.post(
    '/bot-protection',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      const parsed = botApprovalSchema.parse(req.body);
      const expiresAt =
        parsed.duration === undefined
          ? null
          : new Date(Date.now() + parseDurationSeconds(parsed.duration) * 1_000);
      const services = servicesFor(options, req);
      const approval = await services.security.approveBot({
        botId: parsed.botId,
        approvedBy: actorId(req),
        reason: parsed.reason,
        expiresAt,
      });
      res.status(201).json(jsonSafe({ approval }));
    }),
  );

  router.delete(
    '/bot-protection/:botId',
    requireOwnerOrGrant(options, 'security.config'),
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const botId = param(req, 'botId');
      const revoked = await services.security.revokeBot(botId, actorId(req));
      if (!revoked) {
        throw notFound('That bot approval does not exist.');
      }
      res.status(204).end();
    }),
  );

  router.get(
    '/actions/:actionId',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const action = await services.dashboardActions.getById(param(req, 'actionId'));
      if (action === null) {
        throw notFound('Dashboard action not found.');
      }
      res.json(jsonSafe({ action }));
    }),
  );

  router.get(
    '/actions',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const actions = await services.dashboardActions.list(parseLimit(req.query.limit, 25, 100));
      res.json(jsonSafe({ actions }));
    }),
  );

  router.post(
    '/actions/:actionId/cancel',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const actionId = param(req, 'actionId');
      const cancelled = await services.dashboardActions.cancel(actionId, actorId(req));
      if (!cancelled) {
        throw notFound('That action is not pending or does not exist.');
      }
      res.json({ cancelled: true });
    }),
  );

  router.get(
    '/settings',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const [config, logChannels] = await Promise.all([
        services.getConfig(),
        services.security.listLogChannels(),
      ]);
      res.json(jsonSafe({ config, logChannels }));
    }),
  );

  return router;
}

export function moduleStates(config: GuildConfig): Array<{
  id: string;
  enabled: boolean;
  state: 'ACTIVE' | 'DISABLED';
}> {
  return [
    { id: 'anti-nuke', enabled: config.antiNukeEnabled },
    { id: 'anti-raid', enabled: config.antiRaidEnabled },
    { id: 'beast-mode', enabled: config.beastModeEnabled },
    { id: 'automod', enabled: config.automodEnabled },
    { id: 'verification', enabled: config.verificationEnabled },
    { id: 'bot-protection', enabled: config.botProtectionEnabled },
    { id: 'logging', enabled: config.loggingEnabled },
    { id: 'backups', enabled: config.backupsEnabled },
  ].map((module) => ({
    ...module,
    state: module.enabled ? ('ACTIVE' as const) : ('DISABLED' as const),
  }));
}

export function securityScore(input: {
  config: GuildConfig;
  openIncidents: number;
  logChannelCount: number;
}): number {
  let score = 100;
  score -= Math.min(40, input.openIncidents * 8);
  if (input.logChannelCount === 0) score -= 10;
  if (!input.config.verificationEnabled) score -= 8;
  if (!input.config.botProtectionEnabled) score -= 10;
  if (!input.config.backupsEnabled) score -= 6;
  if (!input.config.antiNukeEnabled) score -= 12;
  if (!input.config.antiRaidEnabled) score -= 12;
  return Math.max(0, Math.min(100, score));
}

export function gradeFor(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function parseDurationSeconds(input: string): number {
  const match = /^(\d{1,9})\s*([smhdw])?$/iu.exec(input.trim());
  if (match === null) {
    throw badRequest('Duration must look like 30m, 12h, 7d, or 2w.');
  }
  const unit = (match[2] ?? 's').toLowerCase();
  const factor =
    unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3_600 : unit === 'd' ? 86_400 : 604_800;
  const seconds = Number(match[1]) * factor;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw badRequest('Duration is out of range.');
  }
  return seconds;
}
