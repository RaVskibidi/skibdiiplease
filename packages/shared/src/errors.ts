export type T77ErrorCode =
  | 'T77_INVALID_CONFIGURATION'
  | 'T77_PERMISSION_DENIED'
  | 'T77_OWNER_ONLY'
  | 'T77_HIERARCHY'
  | 'T77_GUILD_ONLY'
  | 'T77_NOT_FOUND'
  | 'T77_COOLDOWN'
  | 'T77_TENANT_VIOLATION'
  | 'T77_DEGRADED'
  | 'T77_CONFLICT'
  | 'T77_INTERNAL';

export interface T77ErrorOptions {
  code: T77ErrorCode;
  userMessage: string;
  cause?: unknown;
  meta?: Record<string, unknown>;
  expose?: boolean;
}

/**
 * Domain error with a safe user-facing message.
 * Internal details belong in `cause`/`meta` and must never be sent to Discord or HTTP clients.
 */
export class T77Error extends Error {
  public readonly code: T77ErrorCode;
  public readonly userMessage: string;
  public readonly meta: Record<string, unknown> | undefined;
  public readonly expose: boolean;

  public constructor(message: string, options: T77ErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'T77Error';
    this.code = options.code;
    this.userMessage = options.userMessage;
    this.meta = options.meta;
    this.expose = options.expose ?? true;
  }
}

export function isT77Error(error: unknown): error is T77Error {
  return error instanceof T77Error;
}

/** Maps unknown failures to a safe public message without leaking internals. */
export function getPublicErrorMessage(error: unknown, fallback: string): string {
  return isT77Error(error) && error.expose ? error.userMessage : fallback;
}
