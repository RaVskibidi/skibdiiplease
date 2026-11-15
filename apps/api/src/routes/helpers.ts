import type { Request } from 'express';
import {
  createTenantContext,
  GuildServices,
  type Database,
  type GuildCache,
  type GuildEventBus,
} from '@t77/db';

import type { Logger } from '../logger.js';
import { createDbLogger } from '../infrastructure.js';
import { unauthorized } from '../http/errors.js';

export interface RouteDependencies {
  readonly database: Database;
  readonly cache?: GuildCache;
  readonly events?: GuildEventBus;
  readonly logger: Logger;
}

export function servicesFor(deps: RouteDependencies, req: Request): GuildServices {
  const auth = req.t77;
  if (auth === undefined || auth.guild === undefined) {
    throw unauthorized();
  }

  return new GuildServices(
    deps.database,
    createTenantContext({
      guildId: auth.guild.guildId,
      actorId: auth.user.id,
      requestId: req.get('x-request-id') ?? 'http',
    }),
    {
      logger: createDbLogger(deps.logger),
      ...(deps.cache === undefined ? {} : { cache: deps.cache }),
      ...(deps.events === undefined ? {} : { events: deps.events }),
    },
  );
}

export function actorId(req: Request): string {
  const auth = req.t77;
  if (auth === undefined) {
    throw unauthorized();
  }
  return auth.user.id;
}

export function guildIdOf(req: Request): string {
  const auth = req.t77;
  if (auth === undefined || auth.guild === undefined) {
    throw unauthorized();
  }
  return auth.guild.guildId;
}

export function parseLimit(value: unknown, fallback = 50, max = 200): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

/** Express 5 types route params as `string | string[]`; routes expect one value. */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}
