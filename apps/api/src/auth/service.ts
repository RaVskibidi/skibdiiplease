import { createHash } from 'node:crypto';

import type { Database, OAuthIdentity } from '@t77/db';

import type { ApiEnv } from '../env.js';
import { randomToken, signPayload, verifyPayload } from '../crypto.js';
import {
  discordAvatarUrl,
  type DiscordGuildSummary,
  type DiscordOAuthProvider,
} from '../discord.js';
import type { CreatedSession, DashboardSessionStore, SessionRecord } from './session-store.js';

export const OAUTH_COOKIE = 't77_oauth';
export const SESSION_COOKIE = 't77_session';
export const CSRF_COOKIE = 't77_csrf';
export const OAUTH_COOKIE_MAX_AGE_SECONDS = 600;

interface OAuthTransaction {
  readonly state: string;
  readonly codeVerifier: string;
  readonly issuedAt: number;
}

export interface DashboardUser {
  readonly id: string;
  readonly username: string;
  readonly globalName: string | null;
  readonly avatarUrl: string | null;
}

export interface ResolvedSession {
  readonly session: SessionRecord;
  readonly user: DashboardUser;
}

export interface CompletedLogin {
  readonly created: CreatedSession;
  readonly user: DashboardUser;
  readonly guilds: readonly DiscordGuildSummary[];
}

export interface GuildAccessCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<boolean>;
}

export interface AuthServiceOptions {
  readonly env: ApiEnv;
  readonly database: Database;
  readonly provider: DiscordOAuthProvider;
  readonly store: DashboardSessionStore;
  readonly cache?: GuildAccessCache;
  readonly now?: () => Date;
}

const GUILD_ACCESS_TTL_SECONDS = 60;

export class AuthService {
  private readonly env: ApiEnv;
  private readonly database: Database;
  private readonly provider: DiscordOAuthProvider;
  private readonly store: DashboardSessionStore;
  private readonly cache: GuildAccessCache | undefined;
  private readonly now: () => Date;

  public constructor(options: AuthServiceOptions) {
    this.env = options.env;
    this.database = options.database;
    this.provider = options.provider;
    this.store = options.store;
    this.cache = options.cache;
    this.now = options.now ?? (() => new Date());
  }

  /** Creates the signed OAuth transaction cookie and the Discord consent URL. */
  public begin(): { readonly url: string; readonly cookie: string } {
    const state = randomToken(24);
    const codeVerifier = randomToken(48);
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const transaction: OAuthTransaction = {
      state,
      codeVerifier,
      issuedAt: this.now().getTime(),
    };

    const url = this.provider.buildAuthorizeUrl({
      clientId: this.env.DISCORD_CLIENT_ID,
      redirectUri: this.env.DISCORD_REDIRECT_URI,
      state,
      codeChallenge,
    });

    return {
      url,
      cookie: signPayload(transaction, this.env.SESSION_SECRET),
    };
  }

  public readTransaction(cookie: string | undefined): OAuthTransaction | null {
    if (cookie === undefined) {
      return null;
    }
    const payload = verifyPayload<OAuthTransaction>(cookie, this.env.SESSION_SECRET);
    if (payload === null || typeof payload.codeVerifier !== 'string') {
      return null;
    }
    if (this.now().getTime() - payload.issuedAt > OAUTH_COOKIE_MAX_AGE_SECONDS * 1_000) {
      return null;
    }
    return payload;
  }

  public async complete(input: {
    code: string;
    state: string;
    transaction: OAuthTransaction;
  }): Promise<CompletedLogin> {
    if (input.state !== input.transaction.state) {
      throw new Error('OAuth state mismatch.');
    }

    const tokens = await this.provider.exchangeCode({
      clientId: this.env.DISCORD_CLIENT_ID,
      clientSecret: this.env.DISCORD_CLIENT_SECRET,
      redirectUri: this.env.DISCORD_REDIRECT_URI,
      code: input.code,
      codeVerifier: input.transaction.codeVerifier,
    });

    const [identity, guilds] = await Promise.all([
      this.provider.fetchIdentity(tokens.accessToken),
      this.provider.fetchGuilds(tokens.accessToken),
    ]);

    const stored = await this.store.upsertIdentity(identity);
    await this.store.saveCredential(stored.id, tokens, this.now());

    const manageable = guilds.filter((guild) => guild.canManage);
    const created = await this.store.createSession({
      identityId: stored.id,
      guildIds: manageable.map((guild) => guild.id),
      ttlSeconds: this.env.SESSION_TTL_SECONDS,
    });

    return {
      created,
      user: toDashboardUser(stored),
      guilds,
    };
  }

  public async resolve(token: string): Promise<ResolvedSession | null> {
    const session = await this.store.findByToken(token);
    if (session === null) {
      return null;
    }
    if (session.revokedAt !== null || session.expiresAt.getTime() <= this.now().getTime()) {
      if (session.revokedAt === null) {
        await this.store.revoke(session.id, this.now()).catch(() => undefined);
      }
      return null;
    }

    const identity = await this.database.client.oAuthIdentity.findUnique({
      where: { id: session.identityId },
    });
    if (identity === null) {
      return null;
    }

    await this.store.touch(session.id, this.now()).catch(() => undefined);

    return { session, user: toDashboardUser(identity) };
  }

  public async guildsFor(session: SessionRecord): Promise<readonly DiscordGuildSummary[]> {
    const cacheKey = `${this.env.REDIS_KEY_PREFIX}:api:guilds:${session.identityId}`;

    if (this.cache !== undefined) {
      try {
        const cached = await this.cache.get(cacheKey);
        if (cached !== null) {
          return JSON.parse(cached) as DiscordGuildSummary[];
        }
      } catch {
        // A cache outage degrades to a Discord call, never to a denial.
      }
    }

    const guilds = await this.fetchGuildsFor(session);

    if (this.cache !== undefined) {
      await this.cache
        .set(cacheKey, JSON.stringify(guilds), GUILD_ACCESS_TTL_SECONDS * 1_000)
        .catch(() => undefined);
    }

    return guilds;
  }

  public async logout(token: string): Promise<void> {
    const session = await this.store.findByToken(token);
    if (session !== null) {
      await this.store.revoke(session.id, this.now());
    }
  }

  private async fetchGuildsFor(session: SessionRecord): Promise<readonly DiscordGuildSummary[]> {
    const credential = await this.store.loadCredential(session.identityId);
    if (credential === null) {
      return this.fallbackGuilds(session);
    }

    let accessToken = credential.accessToken;
    let tokens = credential;
    if (credential.expiresAt.getTime() <= this.now().getTime() + 60_000) {
      try {
        const refreshed = await this.provider.refresh({
          clientId: this.env.DISCORD_CLIENT_ID,
          clientSecret: this.env.DISCORD_CLIENT_SECRET,
          refreshToken: credential.refreshToken,
        });
        tokens = await this.store.saveCredential(session.identityId, refreshed, this.now());
        accessToken = refreshed.accessToken;
      } catch {
        return this.fallbackGuilds(session);
      }
    }

    try {
      const guilds = await this.provider.fetchGuilds(accessToken);
      const manageable = guilds.filter((guild) => guild.canManage).map((guild) => guild.id);
      const changed =
        manageable.length !== session.guildIds.length ||
        manageable.some((id) => !session.guildIds.includes(id));
      if (changed) {
        await this.store.updateGuildIds(session.id, manageable);
      }
      return guilds;
    } catch {
      return this.fallbackGuilds(session);
    } finally {
      void tokens;
    }
  }

  private fallbackGuilds(session: SessionRecord): readonly DiscordGuildSummary[] {
    return session.guildIds.map((id) => ({
      id,
      name: id,
      iconUrl: null,
      owner: false,
      permissions: '0',
      canManage: true,
    }));
  }
}

function toDashboardUser(identity: OAuthIdentity): DashboardUser {
  return {
    id: identity.discordUserId,
    username: identity.username,
    globalName: identity.globalName,
    avatarUrl: discordAvatarUrl(identity.discordUserId, identity.avatarHash),
  };
}
