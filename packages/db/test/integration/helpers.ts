import { Redis } from 'ioredis';

import { Database, silentDbLogger } from '../../src/index.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL;

export const integrationEnabled = TEST_DATABASE_URL !== undefined;
export const redisEnabled = integrationEnabled && TEST_REDIS_URL !== undefined;

export const GUILD_A = '111111111111111111';
export const GUILD_B = '222222222222222222';
export const OWNER_ID = '333333333333333333';
export const ACTOR_ID = '444444444444444444';
export const TARGET_ID = '555555555555555555';
export const TARGET_B_ID = '666666666666666666';

export function createTestDatabase(): Database {
  if (!TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL is required for integration tests.');
  }

  return new Database({
    connectionString: TEST_DATABASE_URL,
    maxConnections: 5,
    slowQueryMs: 5_000,
    logger: silentDbLogger,
  });
}

/** Deletes all tenant data while preserving the migration history. */
export async function resetDatabase(database: Database): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.$executeRawUnsafe('ALTER TABLE "audit_entries" DISABLE TRIGGER ALL');
    await transaction.$executeRawUnsafe(
      'TRUNCATE TABLE "guilds", "oauth_identities" RESTART IDENTITY CASCADE',
    );
    await transaction.$executeRawUnsafe('ALTER TABLE "audit_entries" ENABLE TRIGGER ALL');
  });
}

export async function resetRedis(): Promise<void> {
  if (!TEST_REDIS_URL) {
    return;
  }

  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
  await redis.connect();
  await redis.flushdb();
  await redis.quit();
}
