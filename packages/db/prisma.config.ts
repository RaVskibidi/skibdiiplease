import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

const packageDirectory = dirname(fileURLToPath(import.meta.url));

// The bot, API, and worker load the workspace root .env. Prisma CLI commands
// run from this package, so load the same file explicitly.
loadDotenv({ path: resolve(packageDirectory, '../../.env'), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // An empty value lets `prisma generate` work without a database. Commands
    // that connect fail with Prisma's normal configuration error.
    url: process.env.DATABASE_URL ?? '',
  },
});
