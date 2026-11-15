import { TenantContextError, TenantIsolationError } from './errors.js';

const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/u;

/**
 * Immutable guild scope attached to every data access operation.
 *
 * The guild ID must come from a verified Discord object or an authenticated API
 * route, never from raw user input passed through unchecked.
 */
export interface TenantContext {
  readonly guildId: string;
  readonly actorId?: string;
  readonly requestId?: string;
}

export interface TenantContextInput {
  guildId: string;
  actorId?: string | null;
  requestId?: string | null;
}

export function isDiscordSnowflake(value: string): boolean {
  return DISCORD_SNOWFLAKE_PATTERN.test(value);
}

export function createTenantContext(input: TenantContextInput): TenantContext {
  const guildId = input.guildId.trim();

  if (!isDiscordSnowflake(guildId)) {
    throw new TenantContextError('A tenant context requires a valid Discord guild snowflake.');
  }

  const actorId = normalizeOptionalSnowflake(input.actorId, 'actorId');
  const requestId = input.requestId?.trim();

  return Object.freeze({
    guildId,
    ...(actorId === undefined ? {} : { actorId }),
    ...(requestId === undefined || requestId.length === 0 ? {} : { requestId }),
  });
}

/**
 * Verifies that a row or payload belongs to the caller's guild.
 *
 * Repositories call this before trusting an identifier returned from an
 * untrusted source, so a probe from guild A can never mutate guild B.
 */
export function assertTenantScope(
  context: TenantContext,
  actualGuildId: string,
  operation: string,
): void {
  if (context.guildId !== actualGuildId) {
    throw new TenantIsolationError(
      `Tenant isolation violation during ${operation}: context guild ${context.guildId} attempted to access ${actualGuildId}.`,
      { operation, contextGuildId: context.guildId, actualGuildId },
    );
  }
}

/** Returns a Prisma-compatible `{ guildId }` filter. */
export function tenantWhere(context: TenantContext): { guildId: string } {
  return { guildId: context.guildId };
}

function normalizeOptionalSnowflake(
  value: string | null | undefined,
  field: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (!isDiscordSnowflake(trimmed)) {
    throw new TenantContextError(`Tenant context ${field} must be a Discord snowflake.`);
  }

  return trimmed;
}
