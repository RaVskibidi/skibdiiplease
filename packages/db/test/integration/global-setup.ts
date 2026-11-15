import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Redis } from 'ioredis';
import { Client } from 'pg';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Prepares a clean database and cache for integration tests.
 *
 * The schema is dropped and recreated so migrations are always proven to work
 * from an empty database, not from an incrementally modified local schema.
 */
export default async function setup(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const redisUrl = process.env.TEST_REDIS_URL;

  if (!databaseUrl) {
    process.stderr.write(
      '[t77] TEST_DATABASE_URL is not set; database integration tests will be skipped.\n',
    );
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }

  execSync('pnpm exec prisma migrate deploy', {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  if (redisUrl) {
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await redis.connect();
    await redis.flushdb();
    await redis.quit();
  }
}
