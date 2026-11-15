import { pino, type Logger } from 'pino';

import type { ApiEnv } from './env.js';

export type { Logger };

export function createLogger(env: ApiEnv): Logger {
  return pino({
    level: env.LOG_LEVEL,
    ...(env.LOG_PRETTY
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard', singleLine: true },
          },
        }
      : {}),
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'accessToken',
        'refreshToken',
        'clientSecret',
        '*.accessToken',
        '*.refreshToken',
      ],
      censor: '[redacted]',
    },
  });
}
