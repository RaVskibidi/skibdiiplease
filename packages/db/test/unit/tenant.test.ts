import { describe, expect, it } from 'vitest';

import { TenantContextError, TenantIsolationError } from '../../src/errors.js';
import {
  assertTenantScope,
  createTenantContext,
  isDiscordSnowflake,
  tenantWhere,
} from '../../src/tenant.js';

describe('createTenantContext', () => {
  it('freezes a valid guild context', () => {
    const context = createTenantContext({
      guildId: '123456789012345678',
      actorId: '987654321098765432',
      requestId: 'req-1',
    });

    expect(context).toEqual({
      guildId: '123456789012345678',
      actorId: '987654321098765432',
      requestId: 'req-1',
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('drops blank optional values', () => {
    const context = createTenantContext({
      guildId: '123456789012345678',
      actorId: '   ',
      requestId: '',
    });

    expect(context).toEqual({ guildId: '123456789012345678' });
  });

  it('rejects missing or malformed guild IDs', () => {
    expect(() => createTenantContext({ guildId: '' })).toThrow(TenantContextError);
    expect(() => createTenantContext({ guildId: 'guild-1' })).toThrow(TenantContextError);
    expect(() => createTenantContext({ guildId: '1234' })).toThrow(TenantContextError);
  });

  it('rejects a malformed actor ID', () => {
    expect(() => createTenantContext({ guildId: '123456789012345678', actorId: 'actor' })).toThrow(
      TenantContextError,
    );
  });
});

describe('tenant guards', () => {
  const tenant = createTenantContext({ guildId: '111111111111111111' });

  it('accepts the matching guild and rejects another guild', () => {
    expect(() => assertTenantScope(tenant, '111111111111111111', 'read')).not.toThrow();

    expect(() => assertTenantScope(tenant, '222222222222222222', 'read')).toThrow(
      TenantIsolationError,
    );
  });

  it('builds a Prisma filter from the context only', () => {
    expect(tenantWhere(tenant)).toEqual({ guildId: '111111111111111111' });
  });

  it('validates Discord snowflakes', () => {
    expect(isDiscordSnowflake('12345678901234567')).toBe(true);
    expect(isDiscordSnowflake('1234567890123456')).toBe(false);
    expect(isDiscordSnowflake('1234567890123456a')).toBe(false);
  });
});
