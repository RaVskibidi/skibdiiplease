import { describe, expect, it, vi } from 'vitest';

import {
  canManageGuild,
  discordAvatarUrl,
  discordGuildIconUrl,
  HttpDiscordOAuthProvider,
} from '../src/discord.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('canManageGuild', () => {
  it('allows the owner regardless of permission bits', () => {
    expect(canManageGuild({ owner: true, permissions: '0' })).toBe(true);
  });

  it('checks Administrator and Manage Server bits', () => {
    expect(canManageGuild({ owner: false, permissions: String(0x8) })).toBe(true);
    expect(canManageGuild({ owner: false, permissions: String(0x20) })).toBe(true);
    expect(canManageGuild({ owner: false, permissions: String(0x400) })).toBe(false);
  });

  it('rejects malformed permission values instead of throwing', () => {
    expect(canManageGuild({ owner: false, permissions: 'not-a-number' })).toBe(false);
  });
});

describe('CDN URL helpers', () => {
  it('returns null for missing hashes', () => {
    expect(discordAvatarUrl('1', null)).toBeNull();
    expect(discordGuildIconUrl('1', null)).toBeNull();
  });

  it('uses gif for animated hashes and png otherwise', () => {
    expect(discordAvatarUrl('123', 'a_abc')).toContain('.gif');
    expect(discordAvatarUrl('123', 'abc')).toContain('.png');
    expect(discordGuildIconUrl('456', 'a_def')).toContain('/icons/456/a_def.gif');
  });
});

describe('HttpDiscordOAuthProvider', () => {
  it('builds an authorize URL with PKCE and minimal scopes', () => {
    const provider = new HttpDiscordOAuthProvider();
    const url = new URL(
      provider.buildAuthorizeUrl({
        clientId: '123456789012345678',
        redirectUri: 'http://127.0.0.1:4000/api/auth/discord/callback',
        state: 'state-value',
        codeChallenge: 'challenge-value',
      }),
    );

    expect(url.origin).toBe('https://discord.com');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('scope')).toBe('identify guilds');
    expect(url.searchParams.get('state')).toBe('state-value');
  });

  it('exchanges a code and refreshes tokens', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 604_800,
        scope: 'identify guilds',
      }),
    );
    const provider = new HttpDiscordOAuthProvider(fetchImpl);

    const tokens = await provider.exchangeCode({
      clientId: '123',
      clientSecret: 'secret',
      redirectUri: 'http://localhost/callback',
      code: 'code',
      codeVerifier: 'verifier',
    });

    expect(tokens).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresInSeconds: 604_800,
      scopes: ['identify', 'guilds'],
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/v10/oauth2/token');
    expect(init.method).toBe('POST');
    expect(init.body as string).toContain('code_verifier=verifier');
  });

  it('filters guilds the user cannot manage and keeps icons', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        {
          id: '111111111111111111',
          name: 'Managed',
          icon: 'abc',
          owner: false,
          permissions: String(0x20),
        },
        {
          id: '222222222222222222',
          name: 'Unmanaged',
          icon: null,
          owner: false,
          permissions: '0',
        },
        { name: 'Missing id' },
      ]),
    );
    const provider = new HttpDiscordOAuthProvider(fetchImpl);

    const guilds = await provider.fetchGuilds('token');
    expect(guilds).toHaveLength(2);
    expect(guilds[0]).toMatchObject({
      id: '111111111111111111',
      canManage: true,
    });
    expect(guilds[0]?.iconUrl).toContain('/icons/111111111111111111/abc.png');
    expect(guilds[1]?.canManage).toBe(false);
  });

  it('surfaces identity failures without leaking the access token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: '401: Unauthorized' }, 401));
    const provider = new HttpDiscordOAuthProvider(fetchImpl);

    await expect(provider.fetchIdentity('super-secret-token')).rejects.toThrow('status 401');
    await expect(provider.fetchIdentity('super-secret-token')).rejects.not.toThrow(
      'super-secret-token',
    );
  });
});
