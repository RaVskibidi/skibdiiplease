import type { Logger } from 'pino';

import { Database, GuildCache, GuildEventBus, RedisConnection, type DbLogger } from '@t77/db';

import type { ApiEnv } from './env.js';

export interface ApiInfrastructure {
  readonly database: Database;
  readonly redis: RedisConnection;
  readonly cache: GuildCache;
  readonly events: GuildEventBus;
  connect(): Promise<void>;
  close(): Promise<void>;
}

export function createDbLogger(logger: Logger): DbLogger {
  return {
    debug: (context, message) => logger.debug(context as object, message),
    info: (context, message) => logger.info(context as object, message),
    warn: (context, message) => logger.warn(context as object, message),
    error: (context, message) => logger.error(context as object, message),
  };
}

export function createInfrastructure(env: ApiEnv, logger: Logger): ApiInfrastructure {
  const dbLogger = createDbLogger(logger);

  const database = new Database({
    connectionString: env.DATABASE_URL,
    maxConnections: env.DB_POOL_MAX,
    connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    slowQueryMs: env.DB_SLOW_QUERY_MS,
    logger: dbLogger,
  });

  const redis = new RedisConnection({
    url: env.REDIS_URL,
    logger: dbLogger,
    connectTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
  });

  const cache = new GuildCache(redis, {
    prefix: env.REDIS_KEY_PREFIX,
    defaultTtlSeconds: env.CACHE_TTL_SECONDS,
    maxTtlSeconds: 86_400,
  });

  const events = new GuildEventBus(redis, {
    prefix: env.REDIS_KEY_PREFIX,
    logger: dbLogger,
  });

  let connected = false;
  let closed = false;

  return {
    database,
    redis,
    cache,
    events,

    async connect() {
      if (closed) {
        throw new Error('T77 API infrastructure has been closed.');
      }
      if (connected) {
        return;
      }
      try {
        await database.connect();
        await redis.connect();
        connected = true;
      } catch (error) {
        await redis.close().catch(() => undefined);
        await database.disconnect().catch(() => undefined);
        throw error;
      }
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      connected = false;
      const results = await Promise.allSettled([redis.close(), database.disconnect()]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure && failure.status === 'rejected') {
        throw failure.reason;
      }
    },
  };
}
