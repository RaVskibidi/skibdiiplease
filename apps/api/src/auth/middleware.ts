import type { RequestHandler } from 'express';

import { createTenantContext, GuildServices, type Database } from '@t77/db';

import type { ApiEnv } from '../env.js';
import { constantTimeEqual, parseCookies, sha256 } from '../crypto.js';
import { badRequest, forbidden, unauthorized, type GuildAccess } from '../http/errors.js';
import { param } from '../routes/helpers.js';
import type { AuthService } from './service.js';
import { CSRF_COOKIE, SESSION_COOKIE } from './service.js';

export interface AuthMiddlewareOptions {
  readonly env: ApiEnv;
  readonly auth: AuthService;
  readonly database: Database;
}

/** Resolves the opaque session cookie into `req.t77`. */
export function requireSession(options: AuthMiddlewareOptions): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token === undefined) {
        throw unauthorized();
      }
      const resolved = await options.auth.resolve(token);
      if (resolved === null) {
        throw unauthorized('Your session expired. Sign in again.');
      }
      req.t77 = { session: resolved.session, user: resolved.user };
      next();
    })().catch(next);
  };
}

/**
 * Double-submit CSRF check plus Origin validation. State-changing routes require
 * a header that matches the session-bound cookie and the stored hash.
 */
export function requireCsrf(options: AuthMiddlewareOptions): RequestHandler {
  return (req, _res, next) => {
    try {
      const auth = req.t77;
      if (auth === undefined) {
        throw unauthorized();
      }

      const header = req.get('x-csrf-token');
      const cookie = parseCookies(req.headers.cookie)[CSRF_COOKIE];
      if (header === undefined || cookie === undefined) {
        throw forbidden('Missing CSRF token.');
      }
      if (!constantTimeEqual(header, cookie)) {
        throw forbidden('CSRF token mismatch.');
      }
      if (!constantTimeEqual(sha256(cookie), auth.session.csrfHash)) {
        throw forbidden('CSRF token is not bound to this session.');
      }

      const origin = req.get('origin');
      const referer = req.get('referer');
      if (origin !== undefined) {
        if (origin !== options.env.WEB_ORIGIN) {
          throw forbidden('Request origin is not allowed.');
        }
      } else if (referer !== undefined) {
        if (!referer.startsWith(options.env.WEB_ORIGIN)) {
          throw forbidden('Request referer is not allowed.');
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Verifies guild membership, dashboard management permission, and bot presence.
 * Guilds the user cannot manage are hidden rather than merely disabled.
 */
export function requireGuild(options: AuthMiddlewareOptions): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      const auth = req.t77;
      if (auth === undefined) {
        throw unauthorized();
      }

      const guildId = param(req, 'guildId');
      if (!/^\d{17,20}$/u.test(guildId)) {
        throw badRequest('Invalid server identifier.');
      }

      const guilds = await options.auth.guildsFor(auth.session);
      const guild = guilds.find((item) => item.id === guildId);
      if (guild === undefined || !guild.canManage) {
        throw forbidden();
      }

      const present = await options.database.client.guild.findUnique({
        where: { id: guildId },
        select: { id: true, botLeftAt: true },
      });
      if (present === null || present.botLeftAt !== null) {
        throw forbidden('T77 is not present in this server.');
      }

      const access: GuildAccess = {
        guildId,
        canManage: guild.canManage,
        owner: guild.owner,
      };
      req.t77 = { ...auth, guild: access };
      next();
    })().catch(next);
  };
}

/** Requires the Discord guild owner or an explicit T77 staff grant. */
export function requireOwnerOrGrant(
  options: AuthMiddlewareOptions,
  permissionKey: string,
): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      const auth = req.t77;
      if (auth === undefined || auth.guild === undefined) {
        throw unauthorized();
      }
      if (auth.guild.owner) {
        next();
        return;
      }

      const services = new GuildServices(
        options.database,
        createTenantContext({ guildId: auth.guild.guildId, actorId: auth.user.id }),
      );
      const grant = await services.access.findForSubject('USER', auth.user.id);
      if (grant === null || !grant.permissionKeys.includes(permissionKey)) {
        throw forbidden('You need the guild owner or an explicit T77 grant.');
      }
      next();
    })().catch(next);
  };
}
