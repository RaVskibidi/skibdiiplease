import { randomBytes } from 'node:crypto';

import type { Database, OAuthIdentity } from '@t77/db';

import { randomToken, sha256, type TokenCipher } from '../crypto.js';
import type { DiscordIdentity, DiscordTokens } from '../discord.js';

export interface SessionRecord {
  readonly id: string;
  readonly identityId: string;
  readonly guildIds: readonly string[];
  readonly csrfHash: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface CreatedSession {
  readonly session: SessionRecord;
  /** Raw session token; only the SHA-256 hash is persisted. */
  readonly token: string;
  /** Raw CSRF token; only the SHA-256 hash is persisted. */
  readonly csrfToken: string;
}

export interface CredentialRecord {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
}

export interface DashboardSessionStore {
  createSession(input: {
    identityId: string;
    guildIds: readonly string[];
    ttlSeconds: number;
  }): Promise<CreatedSession>;
  findByToken(token: string): Promise<SessionRecord | null>;
  touch(sessionId: string, at?: Date): Promise<void>;
  revoke(sessionId: string, at?: Date): Promise<void>;
  updateGuildIds(sessionId: string, guildIds: readonly string[]): Promise<void>;
  upsertIdentity(identity: DiscordIdentity): Promise<OAuthIdentity>;
  saveCredential(identityId: string, tokens: DiscordTokens, at?: Date): Promise<CredentialRecord>;
  loadCredential(identityId: string): Promise<CredentialRecord | null>;
}

export interface PostgresSessionStoreOptions {
  readonly database: Database;
  readonly cipher: TokenCipher;
}

/** PostgreSQL-backed dashboard sessions and encrypted Discord credentials. */
export class PostgresSessionStore implements DashboardSessionStore {
  private readonly database: Database;
  private readonly cipher: TokenCipher;

  public constructor(options: PostgresSessionStoreOptions) {
    this.database = options.database;
    this.cipher = options.cipher;
  }

  public async createSession(input: {
    identityId: string;
    guildIds: readonly string[];
    ttlSeconds: number;
  }): Promise<CreatedSession> {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1_000);

    const row = await this.database.client.dashboardSession.create({
      data: {
        identityId: input.identityId,
        sessionHash: sha256(token),
        csrfHash: sha256(csrfToken),
        guildIds: [...input.guildIds],
        expiresAt,
      },
    });

    return {
      session: {
        id: row.id,
        identityId: row.identityId,
        guildIds: row.guildIds,
        csrfHash: row.csrfHash,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
      },
      token,
      csrfToken,
    };
  }

  public async findByToken(token: string): Promise<SessionRecord | null> {
    if (token.length < 16) {
      return null;
    }
    const row = await this.database.client.dashboardSession.findUnique({
      where: { sessionHash: sha256(token) },
    });
    if (row === null) {
      return null;
    }
    return {
      id: row.id,
      identityId: row.identityId,
      guildIds: row.guildIds,
      csrfHash: row.csrfHash,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  public async touch(sessionId: string, at: Date = new Date()): Promise<void> {
    await this.database.client.dashboardSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { lastSeenAt: at },
    });
  }

  public async revoke(sessionId: string, at: Date = new Date()): Promise<void> {
    await this.database.client.dashboardSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: at },
    });
  }

  public async updateGuildIds(sessionId: string, guildIds: readonly string[]): Promise<void> {
    await this.database.client.dashboardSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { guildIds: [...guildIds] },
    });
  }

  public async upsertIdentity(identity: DiscordIdentity): Promise<OAuthIdentity> {
    return this.database.client.oAuthIdentity.upsert({
      where: { discordUserId: identity.id },
      create: {
        discordUserId: identity.id,
        username: identity.username,
        globalName: identity.globalName,
        avatarHash: identity.avatarHash,
      },
      update: {
        username: identity.username,
        globalName: identity.globalName,
        avatarHash: identity.avatarHash,
      },
    });
  }

  public async saveCredential(
    identityId: string,
    tokens: DiscordTokens,
    at: Date = new Date(),
  ): Promise<CredentialRecord> {
    const access = this.cipher.encrypt(tokens.accessToken);
    const refresh = this.cipher.encrypt(tokens.refreshToken);
    const expiresAt = new Date(at.getTime() + tokens.expiresInSeconds * 1_000);

    const row = await this.database.client.oAuthCredential.upsert({
      where: { identityId },
      create: {
        id: randomBytes(16).toString('hex'),
        identityId,
        accessTokenCiphertext: access.ciphertext,
        refreshTokenCiphertext: refresh.ciphertext,
        iv: access.iv,
        authTag: access.tag,
        refreshIv: refresh.iv,
        refreshAuthTag: refresh.tag,
        scopes: [...tokens.scopes],
        expiresAt,
      },
      update: {
        accessTokenCiphertext: access.ciphertext,
        refreshTokenCiphertext: refresh.ciphertext,
        iv: access.iv,
        authTag: access.tag,
        refreshIv: refresh.iv,
        refreshAuthTag: refresh.tag,
        scopes: [...tokens.scopes],
        expiresAt,
      },
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      scopes: row.scopes,
      expiresAt: row.expiresAt,
    };
  }

  public async loadCredential(identityId: string): Promise<CredentialRecord | null> {
    const row = await this.database.client.oAuthCredential.findUnique({
      where: { identityId },
    });
    if (row === null) {
      return null;
    }

    try {
      return {
        accessToken: this.cipher.decrypt({
          ciphertext: row.accessTokenCiphertext,
          iv: row.iv,
          tag: row.authTag,
        }),
        refreshToken: this.cipher.decrypt({
          ciphertext: row.refreshTokenCiphertext,
          iv: row.refreshIv,
          tag: row.refreshAuthTag,
        }),
        scopes: row.scopes,
        expiresAt: row.expiresAt,
      };
    } catch {
      // A rotated ENCRYPTION_KEY makes stored tokens unreadable. Treat that as a
      // re-login requirement instead of crashing every request.
      return null;
    }
  }
}
