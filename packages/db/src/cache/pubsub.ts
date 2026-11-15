import { z } from 'zod';

import type { DbLogger } from '../logger.js';
import { GuildCacheKeys, type GuildCacheKeyOptions } from './keys.js';

export const guildEventEnvelopeSchema = z
  .object({
    version: z.literal(1),
    guildId: z.string().regex(/^\d{17,20}$/u),
    type: z.string().trim().min(1).max(64),
    emittedAt: z.string().datetime(),
    payload: z.unknown(),
  })
  .strict();

export type GuildEventEnvelope<T = unknown> = z.infer<typeof guildEventEnvelopeSchema> & {
  payload: T;
};

export interface GuildEventBusOptions extends GuildCacheKeyOptions {
  logger?: DbLogger;
}

/** The minimal Redis surface required for Pub/Sub; fakeable in unit tests. */
export interface PubSubConnection {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel: string, handler: (message: string) => void): Promise<void>;
}

export type GuildEventHandler<T = unknown> = (event: GuildEventEnvelope<T>) => void | Promise<void>;

/**
 * Guild-scoped Pub/Sub used to invalidate caches across bot, API, and worker
 * processes. Every subscriber re-checks the envelope guild before invoking a
 * handler, so a message published to the wrong channel is ignored.
 */
export class GuildEventBus {
  private readonly connection: PubSubConnection;
  private readonly keys: GuildCacheKeys;
  private readonly logger: DbLogger | undefined;

  public constructor(connection: PubSubConnection, options: GuildEventBusOptions = {}) {
    this.connection = connection;
    this.keys = new GuildCacheKeys(options);
    this.logger = options.logger;
  }

  public channel(guildId: string): string {
    return this.keys.pubSubChannel(guildId);
  }

  public async publish<T>(
    guildId: string,
    type: string,
    payload: T,
  ): Promise<GuildEventEnvelope<T>> {
    const event: GuildEventEnvelope<T> = {
      version: 1,
      guildId,
      type,
      emittedAt: new Date().toISOString(),
      payload,
    };

    const validated = guildEventEnvelopeSchema.parse(event) as GuildEventEnvelope<T>;
    await this.connection.publish(this.keys.pubSubChannel(guildId), JSON.stringify(validated));
    return validated;
  }

  /** Returns an idempotent unsubscribe function. */
  public async subscribe<T>(
    guildId: string,
    handler: GuildEventHandler<T>,
  ): Promise<() => Promise<void>> {
    const channel = this.keys.pubSubChannel(guildId);
    let active = true;

    const listener = (raw: string): void => {
      if (!active) {
        return;
      }

      const event = decodeGuildEvent<T>(raw);
      if (event === null || event.guildId !== guildId) {
        this.logger?.warn({ channel }, 'T77 ignored a malformed or cross-guild Pub/Sub event');
        return;
      }

      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            this.logger?.error(
              { err: error, channel, type: event.type },
              'T77 Pub/Sub handler failed',
            );
          });
        }
      } catch (error) {
        this.logger?.error({ err: error, channel, type: event.type }, 'T77 Pub/Sub handler failed');
      }
    };

    await this.connection.subscribe(channel, listener);

    return async () => {
      if (!active) {
        return;
      }

      active = false;
      await this.connection.unsubscribe(channel, listener);
    };
  }
}

export function decodeGuildEvent<T = unknown>(raw: string): GuildEventEnvelope<T> | null {
  try {
    const result = guildEventEnvelopeSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      return null;
    }

    return result.data as GuildEventEnvelope<T>;
  } catch {
    return null;
  }
}
