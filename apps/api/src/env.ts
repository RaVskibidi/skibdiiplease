import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const booleanSchema = z
  .enum(['true', 'false', '1', '0'], {
    message: 'must be one of true, false, 1, or 0',
  })
  .transform((value) => value === 'true' || value === '1');

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, 'must be a Discord snowflake');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_PRETTY: booleanSchema.default(false),

  API_HOST: z.string().trim().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4_000),
  API_PUBLIC_URL: z.string().trim().url().default('http://127.0.0.1:4000'),
  WEB_ORIGIN: z.string().trim().url().default('http://127.0.0.1:5173'),
  TRUST_PROXY: booleanSchema.default(false),

  DATABASE_URL: z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      'must use a postgresql:// or postgres:// connection string',
    ),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(6),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  DB_SLOW_QUERY_MS: z.coerce.number().int().min(10).max(60_000).default(500),

  REDIS_URL: z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      'must use a redis:// or rediss:// connection string',
    ),
  REDIS_KEY_PREFIX: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9:-]{0,47}$/u)
    .default('t77'),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300),

  DISCORD_CLIENT_ID: snowflakeSchema,
  DISCORD_CLIENT_SECRET: z.string().trim().min(10, 'must be configured'),
  DISCORD_REDIRECT_URI: z.string().trim().url(),

  SESSION_SECRET: z.string().trim().min(32, 'must be at least 32 characters'),
  ENCRYPTION_KEY: z
    .string()
    .trim()
    .refine((value) => Buffer.from(value, 'base64').byteLength === 32, 'must be 32 base64 bytes'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(2_592_000).default(43_200),
  COOKIE_SECURE: booleanSchema.default(false),
  COOKIE_DOMAIN: z.string().trim().min(1).optional(),
});

export type ApiEnv = z.infer<typeof envSchema>;

export class EnvironmentValidationError extends Error {
  public readonly issues: ReadonlyArray<{ path: string; message: string }>;

  public constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
    super(
      `Invalid T77 API environment configuration:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'EnvironmentValidationError';
    this.issues = issues;
  }
}

export function parseApiEnv(input: NodeJS.ProcessEnv = process.env): ApiEnv {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new EnvironmentValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

function findEnvFile(startDirectory: string): string | undefined {
  let current = resolve(startDirectory);
  while (true) {
    const candidate = join(current, '.env');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function loadApiEnv(): ApiEnv {
  const envFile = process.env.ENV_FILE ?? findEnvFile(process.cwd());
  if (envFile !== undefined) {
    loadDotenv({ path: envFile, quiet: true });
  }
  return parseApiEnv(process.env);
}
