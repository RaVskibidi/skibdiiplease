import { createServer } from 'node:http';

import type { Logger } from 'pino';

import { createApp } from './app.js';
import { AuthService } from './auth/service.js';
import { PostgresSessionStore } from './auth/session-store.js';
import { TokenCipher } from './crypto.js';
import { HttpDiscordOAuthProvider } from './discord.js';
import { loadApiEnv } from './env.js';
import { createInfrastructure, type ApiInfrastructure } from './infrastructure.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  const env = loadApiEnv();
  const logger = createLogger(env);
  const infrastructure = createInfrastructure(env, logger);
  const auth = createAuth(env, infrastructure, logger);
  const app = createApp({
    env,
    logger,
    database: infrastructure.database,
    auth,
    events: infrastructure.events,
    readiness: async () => ({
      database: await infrastructure.database.ping(),
      redis: await infrastructure.redis.ping(),
    }),
  });

  await infrastructure.connect();

  const server = createServer(app);
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;

  server.listen(env.API_PORT, env.API_HOST, () => {
    logger.info(
      { host: env.API_HOST, port: env.API_PORT, environment: env.NODE_ENV },
      'T77 API listening',
    );
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info({ signal }, 'Stopping T77 API');

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, 10_000).unref();
    });

    try {
      await infrastructure.close();
    } catch (error) {
      logger.error({ err: error }, 'T77 API infrastructure close failed');
    }
    process.exitCode = 0;
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

export function createAuth(
  env: ReturnType<typeof loadApiEnv>,
  infrastructure: ApiInfrastructure,
  _logger: Logger,
): AuthService {
  const cipher = new TokenCipher(env.ENCRYPTION_KEY);
  const store = new PostgresSessionStore({ database: infrastructure.database, cipher });
  return new AuthService({
    env,
    database: infrastructure.database,
    provider: new HttpDiscordOAuthProvider(),
    store,
    cache: infrastructure.redis,
    now: () => new Date(),
  });
}

void main().catch((error: unknown) => {
  // Configuration failures must not print secrets.
  const message = error instanceof Error ? error.message : 'Unknown startup failure';
  // eslint-disable-next-line no-console -- startup failures happen before the logger exists
  console.error(`T77 API failed to start: ${message}`);
  process.exitCode = 1;
});
