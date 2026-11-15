import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import type { Database, GuildEventBus } from '@t77/db';

import type { ApiEnv } from './env.js';
import type { Logger } from './logger.js';
import type { AuthService } from './auth/service.js';
import {
  requireCsrf,
  requireGuild,
  requireSession,
  type AuthMiddlewareOptions,
} from './auth/middleware.js';
import { createAuthRouter } from './routes/auth.js';
import { createGuildRouter } from './routes/guild.js';
import { createModuleRouter } from './routes/modules.js';
import { createBackupRouter } from './routes/backups.js';
import { createEventsRouter } from './routes/events.js';
import { asyncHandler, createErrorHandler, unauthorized } from './http/errors.js';

export interface AppOptions {
  readonly env: ApiEnv;
  readonly logger: Logger;
  readonly database: Database;
  readonly auth: AuthService;
  readonly events?: GuildEventBus;
  readonly readiness?: () => Promise<{ database: boolean; redis: boolean }>;
}

export function createApp(options: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  if (options.env.TRUST_PROXY) {
    app.set('trust proxy', 1);
  }

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (options.env.COOKIE_SECURE) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    res.setHeader(
      'x-request-id',
      typeof _req.headers['x-request-id'] === 'string'
        ? _req.headers['x-request-id']
        : cryptoRandomId(),
    );
    next();
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && origin === options.env.WEB_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'content-type, x-csrf-token, x-request-id, last-event-id',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 't77-api', timestamp: new Date().toISOString() });
  });

  app.get(
    '/readyz',
    asyncHandler(async (_req, res) => {
      const readiness =
        options.readiness ??
        (async () => ({
          database: await options.database.ping(),
          redis: true,
        }));
      const result = await readiness();
      const ready = result.database && result.redis;
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'degraded',
        checks: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  app.use(
    '/api/auth',
    createAuthRouter({
      env: options.env,
      auth: options.auth,
      database: options.database,
    }),
  );

  const middlewareOptions: AuthMiddlewareOptions = {
    env: options.env,
    auth: options.auth,
    database: options.database,
  };

  const session = requireSession(middlewareOptions);
  const guild = requireGuild(middlewareOptions);
  const csrf = requireCsrf(middlewareOptions);

  app.get(
    '/api/guilds',
    session,
    asyncHandler(async (req, res) => {
      const auth = req.t77;
      if (auth === undefined) {
        throw unauthorized();
      }
      const guilds = (await options.auth.guildsFor(auth.session)).filter((item) => item.canManage);
      const installed = await options.database.client.guild.findMany({
        where: { id: { in: guilds.map((item) => item.id) }, botLeftAt: null },
        select: { id: true, memberCount: true },
      });
      const installedIds = new Map(installed.map((item) => [item.id, item.memberCount]));
      res.json({
        guilds: guilds.map((item) => ({
          id: item.id,
          name: item.name,
          iconUrl: item.iconUrl,
          owner: item.owner,
          botPresent: installedIds.has(item.id),
          memberCount: installedIds.get(item.id) ?? null,
        })),
      });
    }),
  );

  const guildOptions = {
    ...middlewareOptions,
    database: options.database,
    logger: options.logger,
    ...(options.events === undefined ? {} : { events: options.events }),
  };

  const guildRouter = createGuildRouter(guildOptions);
  const moduleRouter = createModuleRouter(guildOptions);
  const backupRouter = createBackupRouter(guildOptions);
  const eventsRouter = createEventsRouter(guildOptions);

  // Configuration, security status, staff, audit, and action polling.
  app.use(
    '/api/guilds/:guildId',
    session,
    guild,
    (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        csrf(req, res, next);
        return;
      }
      next();
    },
  );
  app.use('/api/guilds/:guildId', guildRouter);
  app.use('/api/guilds/:guildId', moduleRouter);
  app.use('/api/guilds/:guildId/backups', backupRouter);
  app.use('/api/guilds/:guildId/events', eventsRouter);

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: 'T77_NOT_FOUND', message: 'API route not found.', details: null },
    });
  });

  app.use(createErrorHandler(options.logger));

  return app;
}

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
