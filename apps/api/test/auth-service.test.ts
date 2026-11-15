import { describe, expect, it, vi } from 'vitest';

import type { Database, OAuthIdentity } from '@t77/db';

import { AuthService, OAUTH_COOKIE_MAX_AGE_SECONDS } from '../src/auth/service.js';
import type {
  CreatedSession,
  CredentialRecord,
  DashboardSessionStore,
  SessionRecord,
} from '../src/auth/session-store.js';
import type { DiscordIdentity, DiscordOAuthProvider } from '../src/discord.js';
import { parseApiEnv } from '../src/env.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const env = parseApiEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://t77@127.0.0.1:55432/t77_test',
  REDIS_URL: 'redis://127.0.0.1:56379/15',
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_CLIENT_SECRET: 'client-secret-value',
  DISCORD_REDIRECT_URI: 'http://127.0.0.1:4000/api/auth/discord/callback',
  SESSION_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
});

const identity: OAuthIdentity = {
  id: 'identity-1',
  discordUserId: '999999999999999999',
  username: 'operator',
  globalName: 'Operator',
  avatarHash: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const discordIdentity: DiscordIdentity = {
  id: '999999999999999999',
  username: 'operator',
  globalName: 'Operator',
  avatarHash: null,
};

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    identityId: 'identity-1',
    guildIds: ['111111111111111111'],
    csrfHash: 'csrf-hash',
    createdAt: NOW,
    lastSeenAt: NOW,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    revokedAt: null,
    ...overrides,
  };
}

function createStore() {
  const created: CreatedSession = {
    session: sessionRecord(),
    token: 'session-token',
    csrfToken: 'csrf-token',
  };

  const store: DashboardSessionStore = {
    createSession: vi.fn(async () => created),
    findByToken: vi.fn(async () => sessionRecord()),
    touch: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
    updateGuildIds: vi.fn(async () => undefined),
    upsertIdentity: vi.fn(async () => identity),
    saveCredential: vi.fn(async (): Promise<CredentialRecord> => ({
      accessToken: 'access',
      refreshToken: 'refresh',
      scopes: ['identify', 'guilds'],
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    })),
    loadCredential: vi.fn(async () => ({
      accessToken: 'access',
      refreshToken: 'refresh',
      scopes: ['identify', 'guilds'],
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    })),
  };

  return store;
}

function createProvider() {
  const provider: DiscordOAuthProvider = {
    buildAuthorizeUrl: vi.fn(
      (input) =>
        `https://discord.com/oauth2/authorize?state=${input.state}&code_challenge=${input.codeChallenge}`,
    ),
    exchangeCode: vi.fn(async () => ({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresInSeconds: 604_800,
      scopes: ['identify', 'guilds'],
    })),
    refresh: vi.fn(async () => ({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresInSeconds: 604_800,
      scopes: ['identify', 'guilds'],
    })),
    fetchIdentity: vi.fn(async () => discordIdentity),
    fetchGuilds: vi.fn(async () => [
      {
        id: '111111111111111111',
        name: 'Managed',
        iconUrl: null,
        owner: false,
        permissions: String(0x20),
        canManage: true,
      },
      {
        id: '222222222222222222',
        name: 'Unmanaged',
        iconUrl: null,
        owner: false,
        permissions: '0',
        canManage: false,
      },
    ]),
  };
  return provider;
}

function createDatabase() {
  return {
    client: {
      oAuthIdentity: {
        findUnique: vi.fn(async () => identity),
      },
    },
  } as unknown as Database;
}

describe('AuthService', () => {
  it('creates a signed, short-lived OAuth transaction with PKCE', () => {
    const store = createStore();
    const service = new AuthService({
      env,
      database: createDatabase(),
      provider: createProvider(),
      store,
      now: () => NOW,
    });

    const { url, cookie } = service.begin();
    expect(url).toContain('code_challenge=');
    expect(cookie).toContain('.');

    const transaction = service.readTransaction(cookie);
    expect(transaction).not.toBeNull();
    expect(url).toContain(transaction?.state ?? 'missing');
    expect(transaction?.codeVerifier.length).toBeGreaterThan(32);
  });

  it('rejects a forged or expired OAuth transaction', () => {
    const service = new AuthService({
      env,
      database: createDatabase(),
      provider: createProvider(),
      store: createStore(),
      now: () => NOW,
    });

    expect(service.readTransaction('forged.cookie')).toBeNull();
    expect(service.readTransaction(undefined)).toBeNull();

    const { cookie } = service.begin();
    const later = new AuthService({
      env,
      database: createDatabase(),
      provider: createProvider(),
      store: createStore(),
      now: () => new Date(NOW.getTime() + OAUTH_COOKIE_MAX_AGE_SECONDS * 1_000 + 1),
    });
    expect(later.readTransaction(cookie)).toBeNull();
  });

  it('completes login, stores encrypted credentials, and persists only manageable guilds', async () => {
    const store = createStore();
    const provider = createProvider();
    const service = new AuthService({
      env,
      database: createDatabase(),
      provider,
      store,
      now: () => NOW,
    });

    const { cookie } = service.begin();
    const transaction = service.readTransaction(cookie);
    expect(transaction).not.toBeNull();

    const completed = await service.complete({
      code: 'code',
      state: transaction?.state ?? '',
      transaction: transaction!,
    });

    expect(completed.created.token).toBe('session-token');
    expect(store.upsertIdentity).toHaveBeenCalledWith(discordIdentity);
    expect(store.saveCredential).toHaveBeenCalled();
    expect(store.createSession).toHaveBeenCalledWith({
      identityId: 'identity-1',
      guildIds: ['111111111111111111'],
      ttlSeconds: env.SESSION_TTL_SECONDS,
    });
    expect(completed.guilds).toHaveLength(2);
  });

  it('refuses a callback whose state does not match the transaction', async () => {
    const service = new AuthService({
      env,
      database: createDatabase(),
      provider: createProvider(),
      store: createStore(),
      now: () => NOW,
    });
    const { cookie } = service.begin();
    const transaction = service.readTransaction(cookie);

    await expect(
      service.complete({ code: 'code', state: 'other-state', transaction: transaction! }),
    ).rejects.toThrow('state mismatch');
  });

  it('resolves a live session and revokes an expired one', async () => {
    const store = createStore();
    const service = new AuthService({
      env,
      database: createDatabase(),
      provider: createProvider(),
      store,
      now: () => NOW,
    });

    const resolved = await service.resolve('session-token');
    expect(resolved?.user).toMatchObject({ id: '999999999999999999', username: 'operator' });
    expect(store.touch).toHaveBeenCalled();

    const expiredStore = createStore();
    expiredStore.findByToken = vi.fn(async () =>
      sessionRecord({ expiresAt: new Date(NOW.getTime() - 1_000) }),
    );
    const expired = new AuthService({
      env,
      database: createDatabase(),
      provider: createProvider(),
      store: expiredStore,
      now: () => NOW,
    });

    expect(await expired.resolve('session-token')).toBeNull();
    expect(expiredStore.revoke).toHaveBeenCalledWith('session-1', NOW);
  });

  it('treats a revoked session as signed out', async () => {
    const store = createStore();
    store.findByToken = vi.fn(async () => sessionRecord({ revokedAt: NOW }));
    const service = new AuthService({
      env,
      database: createDatabase(),
      provider: createProvider(),
      store,
      now: () => NOW,
    });

    expect(await service.resolve('session-token')).toBeNull();
  });

  it('caches guild access and refreshes it after a cache miss', async () => {
    const store = createStore();
    const provider = createProvider();
    const cache = {
      get: vi.fn(async (): Promise<string | null> => null),
      set: vi.fn(async () => true),
    };
    const service = new AuthService({
      env,
      database: createDatabase(),
      provider,
      store,
      cache,
      now: () => NOW,
    });

    const session = sessionRecord({ guildIds: [] });
    const guilds = await service.guildsFor(session);
    expect(guilds.map((guild) => guild.id)).toEqual(['111111111111111111', '222222222222222222']);
    expect(cache.set).toHaveBeenCalledWith(
      `${env.REDIS_KEY_PREFIX}:api:guilds:identity-1`,
      expect.any(String),
      60_000,
    );
    expect(store.updateGuildIds).toHaveBeenCalledWith('session-1', ['111111111111111111']);

    cache.get = vi.fn(async () => JSON.stringify([{ id: '333333333333333333', canManage: true }]));
    const cached = await service.guildsFor(session);
    expect(cached).toEqual([{ id: '333333333333333333', canManage: true }]);
  });

  it('falls back to stored guild IDs when Discord is unreachable', async () => {
    const store = createStore();
    store.loadCredential = vi.fn(async () => null);
    const service = new AuthService({
      env,
      database: createDatabase(),
      provider: createProvider(),
      store,
      now: () => NOW,
    });

    const guilds = await service.guildsFor(sessionRecord());
    expect(guilds).toEqual([
      {
        id: '111111111111111111',
        name: '111111111111111111',
        iconUrl: null,
        owner: false,
        permissions: '0',
        canManage: true,
      },
    ]);
  });
});
