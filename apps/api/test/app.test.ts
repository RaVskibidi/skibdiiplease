import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '@t77/db';

import { createApp } from '../src/app.js';
import type { AuthService } from '../src/auth/service.js';
import type { SessionRecord } from '../src/auth/session-store.js';
import { sha256 } from '../src/crypto.js';
import { parseApiEnv } from '../src/env.js';

const env = parseApiEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://t77@127.0.0.1:55432/t77_test',
  REDIS_URL: 'redis://127.0.0.1:56379/15',
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_CLIENT_SECRET: 'client-secret-value',
  DISCORD_REDIRECT_URI: 'http://127.0.0.1:4000/api/auth/discord/callback',
  SESSION_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
  WEB_ORIGIN: 'http://127.0.0.1:5173',
});

const GUILD = '111111111111111111';
const CSRF = 'csrf-raw-token';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

const session: SessionRecord = {
  id: 'session-1',
  identityId: 'identity-1',
  guildIds: [GUILD],
  csrfHash: sha256(CSRF),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date(Date.now() + 3_600_000),
  revokedAt: null,
};

function createHarness(options: { manageable?: boolean; present?: boolean } = {}) {
  const findUnique = vi.fn(async () => ({
    id: GUILD,
    botLeftAt: options.present === false ? new Date() : null,
  }));
  const findMany = vi.fn(async () => [{ id: GUILD, memberCount: 42 }]);
  const database = {
    client: {
      guild: { findUnique, findMany },
    },
    ping: vi.fn(async () => true),
  } as unknown as Database;

  const auth = {
    resolve: vi.fn(async () => ({
      session,
      user: { id: '999999999999999999', username: 'operator', globalName: null, avatarUrl: null },
    })),
    guildsFor: vi.fn(async () =>
      options.manageable === false
        ? []
        : [
            {
              id: GUILD,
              name: 'Test Guild',
              iconUrl: null,
              owner: true,
              permissions: String(0x20),
              canManage: true,
            },
          ],
    ),
    logout: vi.fn(async () => undefined),
    begin: vi.fn(() => ({ url: 'https://discord.com/oauth2/authorize', cookie: 'oauth-cookie' })),
    readTransaction: vi.fn(() => null),
    complete: vi.fn(),
  } as unknown as AuthService;

  const app = createApp({
    env,
    logger,
    database,
    auth,
    readiness: async () => ({ database: true, redis: true }),
  });

  return { app, auth, database };
}

describe('API surface', () => {
  it('reports liveness', async () => {
    const { app } = createHarness();
    const response = await request(app).get('/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', service: 't77-api' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('reports readiness from the injected check', async () => {
    const { app } = createHarness();
    const response = await request(app).get('/readyz');
    expect(response.status).toBe(200);
    expect(response.body.checks).toEqual({ database: true, redis: true });
  });

  it('reports degraded readiness as 503', async () => {
    const { database } = createHarness();
    const degraded = createApp({
      env,
      logger,
      database,
      auth: createHarness().auth,
      readiness: async () => ({ database: false, redis: false }),
    });

    const response = await request(degraded).get('/readyz');
    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
  });

  it('requires a session for guild routes', async () => {
    const { app } = createHarness();
    const response = await request(app).get(`/api/guilds/${GUILD}/security`);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('T77_UNAUTHORIZED');
  });

  it('returns session data with bot presence', async () => {
    const { app } = createHarness();
    const response = await request(app)
      .get('/api/auth/session')
      .set('cookie', `t77_session=token; t77_csrf=${CSRF}`);

    expect(response.status).toBe(200);
    expect(response.body.user.username).toBe('operator');
    expect(response.body.csrfToken).toBe(CSRF);
    expect(response.body.guilds).toEqual([
      { id: GUILD, name: 'Test Guild', iconUrl: null, owner: true, botPresent: true },
    ]);
  });

  it('hides guilds the caller cannot manage', async () => {
    const { app } = createHarness({ manageable: false });
    const response = await request(app)
      .get(`/api/guilds/${GUILD}/security`)
      .set('cookie', 't77_session=token');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('T77_FORBIDDEN');
  });

  it('rejects a guild where T77 is no longer installed', async () => {
    const { app } = createHarness({ present: false });
    const response = await request(app)
      .get(`/api/guilds/${GUILD}/security`)
      .set('cookie', 't77_session=token');

    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain('not present');
  });

  it('rejects malformed guild identifiers before querying', async () => {
    const { app, auth } = createHarness();
    const response = await request(app)
      .get('/api/guilds/not-a-guild/security')
      .set('cookie', 't77_session=token');

    expect(response.status).toBe(400);
    expect(auth.guildsFor).not.toHaveBeenCalled();
  });

  it('enforces CSRF on mutating guild routes', async () => {
    const { app } = createHarness();
    const response = await request(app)
      .patch(`/api/guilds/${GUILD}/bot-protection`)
      .set('cookie', 't77_session=token')
      .send({ enabled: false });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain('CSRF');
  });

  it('rejects a CSRF token that is not bound to the session', async () => {
    const { app } = createHarness();
    const response = await request(app)
      .patch(`/api/guilds/${GUILD}/bot-protection`)
      .set('cookie', `t77_session=token; t77_csrf=${CSRF}`)
      .set('x-csrf-token', 'different-token')
      .send({ enabled: false });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain('mismatch');
  });

  it('rejects a cross-origin mutation even with a valid CSRF token', async () => {
    const { app } = createHarness();
    const response = await request(app)
      .patch(`/api/guilds/${GUILD}/bot-protection`)
      .set('cookie', `t77_session=token; t77_csrf=${CSRF}`)
      .set('x-csrf-token', CSRF)
      .set('origin', 'https://evil.example')
      .send({ enabled: false });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain('origin');
  });

  it('returns a structured 404 for unknown API routes', async () => {
    const { app } = createHarness();
    const response = await request(app).get('/api/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('T77_NOT_FOUND');
  });
});
