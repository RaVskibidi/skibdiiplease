/** Minimal structured logger contract so @t77/db does not depend on Pino. */
export interface DbLogger {
  trace?(context: unknown, message?: string): void;
  debug(context: unknown, message?: string): void;
  info(context: unknown, message?: string): void;
  warn(context: unknown, message?: string): void;
  error(context: unknown, message?: string): void;
}

export const silentDbLogger: DbLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
