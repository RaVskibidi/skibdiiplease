import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

import { ConfigVersionConflictError, TenantRecordNotFoundError } from '@t77/db';
import { T77Error } from '@t77/shared';

import type { Logger } from '../logger.js';
import type { DashboardUser } from '../auth/service.js';
import type { SessionRecord } from '../auth/session-store.js';

export interface GuildAccess {
  readonly guildId: string;
  readonly canManage: boolean;
  readonly owner: boolean;
}

declare global {
  // Express augments its Request interface through a global namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      t77?: {
        readonly session: SessionRecord;
        readonly user: DashboardUser;
        guild?: GuildAccess;
      };
    }
  }
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: unknown;

  public constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function notFound(message = 'Resource not found.'): ApiError {
  return new ApiError(404, 'T77_NOT_FOUND', message);
}

export function forbidden(message = 'You do not have access to this server.'): ApiError {
  return new ApiError(403, 'T77_FORBIDDEN', message);
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, 'T77_BAD_REQUEST', message, details);
}

export function unauthorized(message = 'Sign in with Discord to continue.'): ApiError {
  return new ApiError(401, 'T77_UNAUTHORIZED', message);
}

export function conflict(message: string, details?: unknown): ApiError {
  return new ApiError(409, 'T77_CONFLICT', message, details);
}

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, _next) => {
    if (res.headersSent) {
      return;
    }

    if (error instanceof ApiError) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details ?? null },
        requestId: res.getHeader('x-request-id') ?? null,
      });
      return;
    }

    if (error instanceof ZodError) {
      res.status(422).json({
        error: {
          code: 'T77_VALIDATION',
          message: 'One or more fields are invalid.',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
      return;
    }

    if (error instanceof ConfigVersionConflictError) {
      res.status(409).json({
        error: {
          code: 'T77_CONFLICT',
          message: error.userMessage,
          details: { expectedVersion: error.expectedVersion, actualVersion: error.actualVersion },
        },
      });
      return;
    }

    if (error instanceof TenantRecordNotFoundError) {
      res.status(404).json({
        error: { code: 'T77_NOT_FOUND', message: error.userMessage, details: null },
      });
      return;
    }

    if (error instanceof T77Error) {
      res.status(400).json({
        error: { code: error.code, message: error.userMessage, details: null },
      });
      return;
    }

    logger.error({ err: error, path: req.path, method: req.method }, 'Unhandled T77 API error');
    res.status(500).json({
      error: {
        code: 'T77_INTERNAL',
        message: 'T77 could not complete that request.',
        details: null,
      },
    });
  };
}
