import { Router } from 'express';

import type { ApiEnv } from '../env.js';
import { parseCookies, serializeCookie } from '../crypto.js';
import { asyncHandler, unauthorized } from '../http/errors.js';
import type { AuthService } from '../auth/service.js';
import {
  CSRF_COOKIE,
  OAUTH_COOKIE,
  OAUTH_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE,
} from '../auth/service.js';
import { requireCsrf, requireSession, type AuthMiddlewareOptions } from '../auth/middleware.js';
import type { Database } from '@t77/db';

export interface AuthRouteOptions extends AuthMiddlewareOptions {
  readonly env: ApiEnv;
  readonly auth: AuthService;
  readonly database: Database;
}

function baseCookieOptions(env: ApiEnv): {
  secure: boolean;
  domain?: string;
  sameSite: 'Lax';
} {
  return {
    secure: env.COOKIE_SECURE,
    sameSite: 'Lax',
    ...(env.COOKIE_DOMAIN === undefined ? {} : { domain: env.COOKIE_DOMAIN }),
  };
}

export function createAuthRouter(options: AuthRouteOptions): Router {
  const router = Router();
  const session = requireSession(options);
  const csrf = requireCsrf(options);

  // Starts the OAuth2 transaction. Browsers follow the redirect directly.
  router.get('/discord', (req, res) => {
    const { url, cookie } = options.auth.begin();
    res.append(
      'Set-Cookie',
      serializeCookie(OAUTH_COOKIE, cookie, {
        ...baseCookieOptions(options.env),
        maxAgeSeconds: OAUTH_COOKIE_MAX_AGE_SECONDS,
      }),
    );

    if (req.accepts(['html', 'json']) === 'json') {
      res.json({ url });
      return;
    }
    res.redirect(url);
  });

  router.get(
    '/discord/callback',
    asyncHandler(async (req, res) => {
      const error = typeof req.query.error === 'string' ? req.query.error : null;
      if (error !== null) {
        res.redirect(`${options.env.WEB_ORIGIN}/?authError=${encodeURIComponent(error)}`);
        return;
      }

      const code = typeof req.query.code === 'string' ? req.query.code : null;
      const state = typeof req.query.state === 'string' ? req.query.state : null;
      const transaction = options.auth.readTransaction(
        parseCookies(req.headers.cookie)[OAUTH_COOKIE],
      );

      if (code === null || state === null || transaction === null) {
        res.redirect(`${options.env.WEB_ORIGIN}/?authError=invalid_transaction`);
        return;
      }

      try {
        const completed = await options.auth.complete({ code, state, transaction });
        const cookieOptions = baseCookieOptions(options.env);
        res.append(
          'Set-Cookie',
          serializeCookie(SESSION_COOKIE, completed.created.token, {
            ...cookieOptions,
            maxAgeSeconds: options.env.SESSION_TTL_SECONDS,
          }),
        );
        res.append(
          'Set-Cookie',
          serializeCookie(CSRF_COOKIE, completed.created.csrfToken, {
            ...cookieOptions,
            maxAgeSeconds: options.env.SESSION_TTL_SECONDS,
            httpOnly: false,
          }),
        );
        res.append(
          'Set-Cookie',
          serializeCookie(OAUTH_COOKIE, '', {
            ...cookieOptions,
            maxAgeSeconds: 0,
          }),
        );

        const first = completed.guilds.find((guild) => guild.canManage);
        res.redirect(
          first === undefined
            ? `${options.env.WEB_ORIGIN}/`
            : `${options.env.WEB_ORIGIN}/servers/${first.id}/security`,
        );
      } catch {
        res.redirect(`${options.env.WEB_ORIGIN}/?authError=exchange_failed`);
      }
    }),
  );

  router.get(
    '/session',
    session,
    asyncHandler(async (req, res) => {
      const auth = req.t77;
      if (auth === undefined) {
        throw unauthorized();
      }

      const guilds = (await options.auth.guildsFor(auth.session)).filter(
        (guild) => guild.canManage,
      );
      const installed = await options.database.client.guild.findMany({
        where: { id: { in: guilds.map((guild) => guild.id) }, botLeftAt: null },
        select: { id: true },
      });
      const installedIds = new Set(installed.map((guild) => guild.id));

      res.json({
        user: auth.user,
        csrfToken: parseCookies(req.headers.cookie)[CSRF_COOKIE] ?? null,
        expiresAt: auth.session.expiresAt.toISOString(),
        guilds: guilds.map((guild) => ({
          id: guild.id,
          name: guild.name,
          iconUrl: guild.iconUrl,
          owner: guild.owner,
          botPresent: installedIds.has(guild.id),
        })),
      });
    }),
  );

  router.post(
    '/logout',
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token !== undefined) {
        await options.auth.logout(token);
      }
      const cookieOptions = baseCookieOptions(options.env);
      for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
        res.append(
          'Set-Cookie',
          serializeCookie(name, '', {
            ...cookieOptions,
            maxAgeSeconds: 0,
            ...(name === CSRF_COOKIE ? { httpOnly: false } : {}),
          }),
        );
      }
      res.status(204).end();
    }),
  );

  return router;
}
