import { PrismaPg } from '@prisma/adapter-pg';

import type { DbLogger } from './logger.js';
import { PrismaClient, type Prisma } from './generated/prisma/client.ts';

export interface DatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Prisma transaction defaults; individual calls can still override them. */
  transactionTimeoutMs?: number;
  maxTransactionWaitMs?: number;
  slowQueryMs?: number;
  logger?: DbLogger;
}

export interface TransactionOptions {
  timeoutMs?: number;
  maxWaitMs?: number;
}

const DEFAULT_TRANSACTION_TIMEOUT_MS = 10_000;
const DEFAULT_TRANSACTION_WAIT_MS = 5_000;

/**
 * Owns the PostgreSQL connection pool and Prisma client.
 *
 * T77 uses the Prisma 7 driver-adapter model: the pg pool is created by
 * `@prisma/adapter-pg`, so pool limits and timeouts are explicit instead of
 * relying on removed Rust-engine defaults.
 */
export class Database {
  public readonly client: PrismaClient<'warn' | 'error' | 'query'>;
  private readonly logger: DbLogger | undefined;
  private readonly slowQueryMs: number;
  private readonly transactionTimeoutMs: number;
  private readonly maxTransactionWaitMs: number;
  private connected = false;
  private closed = false;

  public constructor(options: DatabaseOptions) {
    if (options.connectionString.trim().length === 0) {
      throw new Error('T77 database connection string is empty.');
    }

    this.logger = options.logger;
    this.slowQueryMs = options.slowQueryMs ?? 500;
    this.transactionTimeoutMs = options.transactionTimeoutMs ?? DEFAULT_TRANSACTION_TIMEOUT_MS;
    this.maxTransactionWaitMs = options.maxTransactionWaitMs ?? DEFAULT_TRANSACTION_WAIT_MS;

    const adapter = new PrismaPg(
      {
        connectionString: options.connectionString,
        max: options.maxConnections ?? 10,
        connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
        idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
        statement_timeout: options.statementTimeoutMs ?? 15_000,
      },
      {
        onPoolError: (error) => {
          this.logger?.error({ err: error }, 'T77 PostgreSQL pool error');
        },
        onConnectionError: (error) => {
          this.logger?.error({ err: error }, 'T77 PostgreSQL connection error');
        },
      },
    );

    this.client = new PrismaClient({
      adapter,
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'query' },
      ],
    });

    this.client.$on('warn', (event) => {
      this.logger?.warn({ prisma: event }, 'Prisma warning');
    });
    this.client.$on('error', (event) => {
      this.logger?.error({ prisma: event }, 'Prisma error');
    });
    this.client.$on('query', (event) => {
      if (event.duration >= this.slowQueryMs) {
        this.logger?.warn(
          { durationMs: event.duration, target: event.target },
          'Slow T77 database query',
        );
      }
    });
  }

  public get isConnected(): boolean {
    return this.connected && !this.closed;
  }

  /** Opens the pool and verifies the connection with a trivial query. */
  public async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('T77 database has been closed.');
    }

    if (this.connected) {
      return;
    }

    await this.client.$connect();
    await this.client.$queryRaw`SELECT 1`;
    this.connected = true;
    this.logger?.info('T77 database connection established');
  }

  /** Lightweight readiness probe used by health checks. */
  public async ping(): Promise<boolean> {
    if (this.closed) {
      return false;
    }

    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger?.warn({ err: error }, 'T77 database ping failed');
      return false;
    }
  }

  /** Runs a transaction with T77's bounded defaults. */
  public async transaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    return this.client.$transaction(operation, {
      timeout: options.timeoutMs ?? this.transactionTimeoutMs,
      maxWait: options.maxWaitMs ?? this.maxTransactionWaitMs,
    });
  }

  /** Flushes the pool. Safe to call multiple times. */
  public async disconnect(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.connected = false;

    try {
      await this.client.$disconnect();
      this.logger?.info('T77 database connection closed');
    } catch (error) {
      this.logger?.error({ err: error }, 'T77 database disconnect failed');
      throw error;
    }
  }
}

export { Prisma, PrismaClient } from './generated/prisma/client.ts';
export type {
  AntiNukeRule,
  AntiRaidConfig,
  AuditActorType,
  AuditEntry,
  AutomodConfig,
  Backup,
  BeastModeState,
  BotApproval,
  CriticalApproval,
  DashboardAction,
  Guild,
  GuildConfig,
  GuildResource,
  LogChannel,
  ModerationCase,
  OAuthCredential,
  OAuthIdentity,
  Punishment,
  QuarantineEntry,
  RestoreJob,
  SecurityEvent,
  SecurityIncident,
  VerificationChallenge,
  VerificationConfig,
  Warning,
  WhitelistEntry,
} from './generated/prisma/client.ts';

/** True when Prisma reports a unique-constraint violation (P2002). */
export function isUniqueConstraintError(error: unknown): boolean {
  return getPrismaErrorCode(error) === 'P2002';
}

/** True when Prisma reports a foreign-key violation (P2003). */
export function isForeignKeyError(error: unknown): boolean {
  return getPrismaErrorCode(error) === 'P2003';
}

/** True when Prisma reports a missing record for an update/delete (P2025). */
export function isRecordNotFoundError(error: unknown): boolean {
  return getPrismaErrorCode(error) === 'P2025';
}

function getPrismaErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
