import { Router } from 'express';

import { guildIdOf, servicesFor, type RouteDependencies } from './helpers.js';
import type { AuthMiddlewareOptions } from '../auth/middleware.js';

export interface EventsRouteOptions extends RouteDependencies, AuthMiddlewareOptions {}

/**
 * Server-sent events backed by the Redis guild Pub/Sub channel.
 *
 * The stream is guild-scoped by the authenticated route. Event IDs are
 * monotonic per connection; when a client reconnects with Last-Event-ID the API
 * asks it to resynchronise over REST because no durable event log is kept.
 */
export function createEventsRouter(options: EventsRouteOptions): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req, res) => {
    void (async () => {
      const guildId = guildIdOf(req);
      // Touch the tenant once so an inaccessible guild fails before streaming.
      servicesFor(options, req);

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let sequence = 0;
      let closed = false;
      const write = (event: string, data: unknown): void => {
        if (closed) {
          return;
        }
        sequence += 1;
        res.write(`id: ${Date.now()}-${sequence}\n`);
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      write('ready', { guildId, connectedAt: new Date().toISOString() });

      if (typeof req.headers['last-event-id'] === 'string') {
        write('resync', {
          reason: 'T77 does not retain a durable event log. Refresh the current view over REST.',
          lastEventId: req.headers['last-event-id'],
        });
      }

      const heartbeat = setInterval(() => {
        if (!closed) {
          res.write(': heartbeat\n\n');
        }
      }, 25_000);
      heartbeat.unref();

      const unsubscribe =
        options.events === undefined
          ? null
          : await options.events.subscribe(guildId, (event) => {
              write(event.type, { payload: event.payload, emittedAt: event.emittedAt });
            });

      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        if (unsubscribe !== null) {
          void unsubscribe().catch(() => undefined);
        }
        res.end();
      };

      req.on('close', cleanup);
      res.on('close', cleanup);
    })().catch((error: unknown) => {
      if (!res.headersSent) {
        res.status(500).json({
          error: { code: 'T77_INTERNAL', message: 'Event stream could not start.' },
        });
      }
      options.logger.warn({ err: error }, 'T77 SSE stream failed');
    });
  });

  return router;
}
