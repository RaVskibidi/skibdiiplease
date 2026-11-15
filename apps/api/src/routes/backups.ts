import { Router } from 'express';
import { z } from 'zod';

import {
  DASHBOARD_ACTION_TYPES,
  restoreSelectionPayloadSchema,
  TenantRecordNotFoundError,
} from '@t77/db';

import { jsonSafe } from '../crypto.js';
import { asyncHandler, badRequest, notFound } from '../http/errors.js';
import { requireOwnerOrGrant } from '../auth/middleware.js';
import { actorId, param, parseLimit, servicesFor, type RouteDependencies } from './helpers.js';
import type { AuthMiddlewareOptions } from '../auth/middleware.js';

export interface BackupRouteOptions extends RouteDependencies, AuthMiddlewareOptions {}

const createSchema = z
  .object({
    retentionDays: z.number().int().min(1).max(3_650).optional(),
    confirm: z.literal(true),
  })
  .strict();

const previewSchema = z
  .object({
    selection: restoreSelectionPayloadSchema,
    confirm: z.literal(true),
  })
  .strict();

const restoreSchema = z
  .object({
    jobId: z.string().trim().min(1),
    confirmationId: z.string().trim().min(6).max(128),
    confirm: z.literal(true),
  })
  .strict();

const deleteSchema = z.object({ confirm: z.literal(true) }).strict();

export function createBackupRouter(options: BackupRouteOptions): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const [backups, restores, config] = await Promise.all([
        services.backups.list(parseLimit(req.query.limit, 50, 200)),
        services.restores.list(parseLimit(req.query.limit, 25, 100)),
        services.getConfig(),
      ]);
      res.json(
        jsonSafe({
          backups,
          restores,
          schedule: {
            enabled: config.backupsEnabled,
            intervalHours: config.backupIntervalHours,
            retentionDays: config.backupRetentionDays,
            lastScheduledBackupAt: config.lastScheduledBackupAt,
          },
          unsupported: [
            'T77 captures only Discord configuration exposed by the API: roles, channels, permission overwrites, emojis, stickers, and guild settings.',
            'Messages, members, bans, invites, audit logs, webhooks, and integrations are never captured and cannot be restored.',
            'Recreated roles and channels receive new Discord IDs.',
          ],
        }),
      );
    }),
  );

  router.post(
    '/',
    requireOwnerOrGrant(options, 'backup.manage'),
    asyncHandler(async (req, res) => {
      const parsed = createSchema.parse(req.body ?? {});
      const services = servicesFor(options, req);
      const action = await services.dashboardActions.create({
        type: DASHBOARD_ACTION_TYPES.BACKUP_CREATE,
        actorId: actorId(req),
        payload: parsed.retentionDays === undefined ? {} : { retentionDays: parsed.retentionDays },
      });
      res.status(202).json(jsonSafe({ action }));
    }),
  );

  router.get(
    '/jobs',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const jobs = await services.restores.list(parseLimit(req.query.limit, 25, 100));
      res.json(jsonSafe({ jobs }));
    }),
  );

  router.get(
    '/:backupId',
    asyncHandler(async (req, res) => {
      const services = servicesFor(options, req);
      const backupId = param(req, 'backupId');
      const backup = await services.backups.getById(backupId);
      if (backup === null) {
        throw notFound('Backup not found.');
      }
      const restores = await services.restores.list(100);
      res.json(
        jsonSafe({
          backup,
          restores: restores.filter((job) => job.backupId === backupId),
        }),
      );
    }),
  );

  router.post(
    '/:backupId/preview',
    requireOwnerOrGrant(options, 'backup.restore'),
    asyncHandler(async (req, res) => {
      const parsed = previewSchema.parse(req.body);
      const services = servicesFor(options, req);
      const backupId = param(req, 'backupId');
      const backup = await services.backups.findReady(backupId);
      if (backup === null) {
        throw new TenantRecordNotFoundError('ready backup', backupId);
      }
      const action = await services.dashboardActions.create({
        type: DASHBOARD_ACTION_TYPES.BACKUP_PREVIEW,
        actorId: actorId(req),
        payload: { backupId, selection: parsed.selection },
      });
      res.status(202).json(jsonSafe({ action }));
    }),
  );

  router.post(
    '/:backupId/restore',
    requireOwnerOrGrant(options, 'backup.restore'),
    asyncHandler(async (req, res) => {
      const parsed = restoreSchema.parse(req.body);
      const services = servicesFor(options, req);
      const backupId = param(req, 'backupId');
      const job = await services.restores.getById(parsed.jobId);
      if (job === null || job.backupId !== backupId) {
        throw notFound('Restore preview not found for that backup.');
      }
      if (job.status !== 'PREVIEWED') {
        throw badRequest('Preview the restore again before executing it.');
      }

      const action = await services.dashboardActions.create({
        type: DASHBOARD_ACTION_TYPES.BACKUP_RESTORE,
        actorId: actorId(req),
        payload: {
          backupId,
          jobId: parsed.jobId,
          confirmationId: parsed.confirmationId,
        },
        confirmationId: parsed.confirmationId,
      });
      res.status(202).json(jsonSafe({ action }));
    }),
  );

  router.delete(
    '/:backupId',
    requireOwnerOrGrant(options, 'backup.manage'),
    asyncHandler(async (req, res) => {
      deleteSchema.parse(req.body ?? {});
      const services = servicesFor(options, req);
      const backupId = param(req, 'backupId');
      const backup = await services.backups.getById(backupId);
      if (backup === null) {
        throw notFound('Backup not found.');
      }
      if (backup.status === 'DELETED') {
        throw badRequest('That backup is already deleted.');
      }

      const action = await services.dashboardActions.create({
        type: DASHBOARD_ACTION_TYPES.BACKUP_DELETE,
        actorId: actorId(req),
        payload: { backupId },
        confirmationId: 'DELETE',
      });
      res.status(202).json(jsonSafe({ action }));
    }),
  );

  return router;
}
