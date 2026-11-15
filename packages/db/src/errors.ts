import { T77Error } from '@t77/shared';

/** Raised when a tenant identifier is missing or malformed. */
export class TenantContextError extends T77Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, {
      code: 'T77_TENANT_VIOLATION',
      userMessage: 'T77 could not resolve a valid server context for this request.',
      expose: false,
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'TenantContextError';
  }
}

/** Raised when a row or payload belongs to a different guild than the context. */
export class TenantIsolationError extends T77Error {
  public constructor(message: string, meta?: Record<string, unknown>) {
    super(message, {
      code: 'T77_TENANT_VIOLATION',
      userMessage: 'T77 rejected a request that crossed server boundaries.',
      expose: false,
      ...(meta === undefined ? {} : { meta }),
    });
    this.name = 'TenantIsolationError';
  }
}

/** Optimistic concurrency failure on a versioned guild configuration. */
export class ConfigVersionConflictError extends T77Error {
  public readonly expectedVersion: number;
  public readonly actualVersion: number;

  public constructor(expectedVersion: number, actualVersion: number) {
    super(
      `Guild configuration version conflict: expected ${expectedVersion}, found ${actualVersion}.`,
      {
        code: 'T77_CONFLICT',
        userMessage: 'This configuration was changed elsewhere. Refresh and try again.',
        meta: { expectedVersion, actualVersion },
      },
    );
    this.name = 'ConfigVersionConflictError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** Raised when a tenant-scoped record cannot be found inside the caller's guild. */
export class TenantRecordNotFoundError extends T77Error {
  public constructor(resource: string, id: string) {
    super(`T77 ${resource} ${id} was not found in the active guild.`, {
      code: 'T77_NOT_FOUND',
      userMessage: 'That record is no longer available in this server.',
      meta: { resource, id },
    });
    this.name = 'TenantRecordNotFoundError';
  }
}

/** Raised when only the Discord guild owner may approve a critical action. */
export class OwnerApprovalRequiredError extends T77Error {
  public constructor(message = 'Only the Discord guild owner can approve this action.') {
    super(message, {
      code: 'T77_OWNER_ONLY',
      userMessage: 'Only the server owner can approve destructive T77 enforcement.',
      expose: true,
    });
    this.name = 'OwnerApprovalRequiredError';
  }
}
