/**
 * Discord OAuth2 (Authorization Code + PKCE) and REST adapter.
 *
 * T77 requests only `identify` and `guilds`. The bot token is never used here,
 * and the user's access token never leaves this process.
 */

export const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
export const DISCORD_TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
export const DISCORD_API_BASE = 'https://discord.com/api/v10';

export const DISCORD_OAUTH_SCOPES = ['identify', 'guilds'] as const;

export const DISCORD_PERMISSIONS = {
  ADMINISTRATOR: 0x8n,
  MANAGE_GUILD: 0x20n,
} as const;

export interface DiscordIdentity {
  readonly id: string;
  readonly username: string;
  readonly globalName: string | null;
  readonly avatarHash: string | null;
}

export interface DiscordGuildSummary {
  readonly id: string;
  readonly name: string;
  readonly iconUrl: string | null;
  readonly owner: boolean;
  readonly permissions: string;
  readonly canManage: boolean;
}

export interface DiscordTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly scopes: readonly string[];
}

export interface DiscordOAuthProvider {
  buildAuthorizeUrl(input: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
    readonly scopes?: readonly string[];
  }): string;
  exchangeCode(input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<DiscordTokens>;
  refresh(input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
  }): Promise<DiscordTokens>;
  fetchIdentity(accessToken: string): Promise<DiscordIdentity>;
  fetchGuilds(accessToken: string): Promise<DiscordGuildSummary[]>;
}

interface DiscordTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

interface DiscordUserResponse {
  id?: unknown;
  username?: unknown;
  global_name?: unknown;
  avatar?: unknown;
}

interface DiscordGuildResponse {
  id?: unknown;
  name?: unknown;
  icon?: unknown;
  owner?: unknown;
  permissions?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function canManageGuild(input: {
  readonly owner: boolean;
  readonly permissions: string;
}): boolean {
  if (input.owner) {
    return true;
  }
  let bits: bigint;
  try {
    bits = BigInt(input.permissions);
  } catch {
    return false;
  }
  return (
    (bits & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n ||
    (bits & DISCORD_PERMISSIONS.MANAGE_GUILD) !== 0n
  );
}

export function discordAvatarUrl(userId: string, avatarHash: string | null): string | null {
  if (avatarHash === null) {
    return null;
  }
  const extension = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${extension}?size=128`;
}

export function discordGuildIconUrl(guildId: string, iconHash: string | null): string | null {
  if (iconHash === null) {
    return null;
  }
  const extension = iconHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.${extension}?size=128`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class HttpDiscordOAuthProvider implements DiscordOAuthProvider {
  private readonly fetchImpl: typeof fetch;

  public constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  public buildAuthorizeUrl(input: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
    readonly scopes?: readonly string[];
  }): string {
    const params = new URLSearchParams({
      client_id: input.clientId,
      response_type: 'code',
      redirect_uri: input.redirectUri,
      scope: (input.scopes ?? DISCORD_OAUTH_SCOPES).join(' '),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'consent',
    });
    return `${DISCORD_AUTHORIZE_URL}?${params.toString()}`;
  }

  public async exchangeCode(input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<DiscordTokens> {
    return this.requestTokens({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    });
  }

  public async refresh(input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
  }): Promise<DiscordTokens> {
    return this.requestTokens({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    });
  }

  public async fetchIdentity(accessToken: string): Promise<DiscordIdentity> {
    const response = await this.fetchImpl(`${DISCORD_API_BASE}/users/@me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = (await readJson(response)) as DiscordUserResponse;
    if (!response.ok) {
      throw new Error(`Discord identity request failed with status ${response.status}.`);
    }
    const id = asString(body.id);
    const username = asString(body.username);
    if (id === null || username === null) {
      throw new Error('Discord identity response was missing required fields.');
    }
    return {
      id,
      username,
      globalName: asString(body.global_name),
      avatarHash: asString(body.avatar),
    };
  }

  public async fetchGuilds(accessToken: string): Promise<DiscordGuildSummary[]> {
    const response = await this.fetchImpl(`${DISCORD_API_BASE}/users/@me/guilds`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = await readJson(response);
    if (!response.ok || !Array.isArray(body)) {
      if (!response.ok) {
        throw new Error(`Discord guild list failed with status ${response.status}.`);
      }
      throw new Error('Discord guild list response was not an array.');
    }

    return (body as DiscordGuildResponse[])
      .map((guild) => {
        const id = asString(guild.id);
        const name = asString(guild.name);
        const permissions = asString(guild.permissions) ?? '0';
        const owner = guild.owner === true;
        if (id === null || name === null) {
          return null;
        }
        return {
          id,
          name,
          iconUrl: discordGuildIconUrl(id, asString(guild.icon)),
          owner,
          permissions,
          canManage: canManageGuild({ owner, permissions }),
        } satisfies DiscordGuildSummary;
      })
      .filter((guild): guild is DiscordGuildSummary => guild !== null);
  }

  private async requestTokens(form: Record<string, string>): Promise<DiscordTokens> {
    const response = await this.fetchImpl(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await readJson(response)) as DiscordTokenResponse;
    if (!response.ok) {
      throw new Error(`Discord token exchange failed with status ${response.status}.`);
    }
    const accessToken = asString(body.access_token);
    const refreshToken = asString(body.refresh_token);
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number.NaN;
    if (accessToken === null || refreshToken === null || !Number.isFinite(expiresIn)) {
      throw new Error('Discord token response was missing required fields.');
    }
    const scopes = asString(body.scope)?.split(/\s+/u).filter(Boolean) ?? [];
    return {
      accessToken,
      refreshToken,
      expiresInSeconds: expiresIn,
      scopes,
    };
  }
}
