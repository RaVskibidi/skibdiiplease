import { describe, expect, it } from 'vitest';

import { EnvironmentValidationError, parseApiEnv } from '../src/env.js';

const KEY = Buffer.alloc(32, 3).toString('base64');

function validEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://t77@127.0.0.1:55432/t77_test',
    REDIS_URL: 'redis://127.0.0.1:56379/15',
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_CLIENT_SECRET: 'client-secret-value',
    DISCORD_REDIRECT_URI: 'http://127.0.0.1:4000/api/auth/discord/callback',
    SESSION_SECRET: 'a'.repeat(32),
    ENCRYPTION_KEY: KEY,
    ...overrides,
  };
}

describe('API environment', () => {
  it('applies safe defaults', () => {
    const env = parseApiEnv(validEnv());
    expect(env.API_PORT).toBe(4_000);
    expect(env.WEB_ORIGIN).toBe('http://127.0.0.1:5173');
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.COOKIE_DOMAIN).toBeUndefined();
    expect(env.CACHE_TTL_SECONDS).toBe(300);
    expect(env.SESSION_TTL_SECONDS).toBe(43_200);
  });

  it('parses boolean flags', () => {
    expect(parseApiEnv(validEnv({ COOKIE_SECURE: 'true' })).COOKIE_SECURE).toBe(true);
    expect(parseApiEnv(validEnv({ TRUST_PROXY: '1' })).TRUST_PROXY).toBe(true);
    expect(parseApiEnv(validEnv({ LOG_PRETTY: 'false' })).LOG_PRETTY).toBe(false);
  });

  it('rejects a non-PostgreSQL database URL', () => {
    expect(() => parseApiEnv(validEnv({ DATABASE_URL: 'mysql://localhost/t77' }))).toThrow(
      EnvironmentValidationError,
    );
  });

  it('rejects an encryption key that is not 32 base64 bytes', () => {
    expect(() =>
      parseApiEnv(validEnv({ ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') })),
    ).toThrow(EnvironmentValidationError);
  });

  it('rejects a short session secret', () => {
    expect(() => parseApiEnv(validEnv({ SESSION_SECRET: 'short' }))).toThrow(
      EnvironmentValidationError,
    );
  });

  it('lists every invalid field without printing their values', () => {
    try {
      parseApiEnv(validEnv({ DISCORD_CLIENT_ID: 'not-a-snowflake', SESSION_SECRET: 'short' }));
      expect.unreachable('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      const issues = (error as EnvironmentValidationError).issues;
      expect(issues.map((issue) => issue.path)).toContain('DISCORD_CLIENT_ID');
      expect(issues.map((issue) => issue.path)).toContain('SESSION_SECRET');
      expect((error as Error).message).not.toContain('client-secret-value');
    }
  });
});
