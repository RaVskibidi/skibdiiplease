import { Redis } from 'ioredis';

import type { DbLogger } from './logger.js';

export interface RedisConnectionOptions {
  url: string;
  logger?: DbLogger;
  connectTimeoutMs?: number;
  maxRetriesPerRequest?: number;
  /** Accepted for forward compatibility; T77 namespaces keys explicitly. */
  keyPrefix?: string;
  lazyConnect?: boolean;
}

/**
 * Owns the shared Redis command connection and one lazy subscriber connection.
 *
 * A subscriber connection cannot issue normal commands once it enters subscribe
 * mode, so T77 keeps them separate. Cache and Pub/Sub therefore never interfere
 * with each other.
 */
export class RedisConnection {
  private readonly options: RedisConnectionOptions;
  private readonly logger: DbLogger | undefined;
  private readonly command: Redis;
  private subscriber: Redis | null = null;
  private readonly subscriberHandlers = new Map<string, Set<(message: string) => void>>();
  private connected = false;
  private closed = false;

  public constructor(options: RedisConnectionOptions) {
    if (options.url.trim().length === 0) {
      throw new Error('T77 Redis connection string is empty.');
    }

    this.options = options;
    this.logger = options.logger;
    this.command = this.createClient();
    this.command.on('error', (error) => {
      this.logger?.error({ err: error }, 'T77 Redis command connection error');
    });
  }

  public get isConnected(): boolean {
    return this.connected && !this.closed;
  }

  /** Verifies connectivity with PING; used by health checks and startup. */
  public async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('T77 Redis has been closed.');
    }

    if (this.connected) {
      return;
    }

    if (this.command.status === 'wait') {
      await this.command.connect();
    }

    await this.command.ping();
    this.connected = true;
    this.logger?.info('T77 Redis connection established');
  }

  public async ping(): Promise<boolean> {
    if (this.closed) {
      return false;
    }

    try {
      await this.command.ping();
      return true;
    } catch (error) {
      this.logger?.warn({ err: error }, 'T77 Redis ping failed');
      return false;
    }
  }

  public async get(key: string): Promise<string | null> {
    return this.command.get(key);
  }

  /** Sets a key with a millisecond TTL. A non-positive TTL is rejected. */
  public async set(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('T77 cache writes require a positive TTL.');
    }

    const result = await this.command.set(key, value, 'PX', Math.floor(ttlMs));
    return result === 'OK';
  }

  public async delete(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }

    return this.command.unlink(...keys);
  }

  /**
   * Runs a Lua script atomically.
   *
   * T77 uses scripts for rolling windows so prune, record, and read happen in a
   * single Redis operation. That prevents two shards from observing a partially
   * applied counter and avoids check-then-act races.
   */
  public async eval(
    script: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown> {
    return this.command.eval(script, keys.length, ...keys, ...args.map(String));
  }

  /** Returns a sorted-set range by score, inclusive. */
  public async zrangeByScore(key: string, min: number, max: number): Promise<string[]> {
    return this.command.zrangebyscore(key, min, max);
  }

  public async zcard(key: string): Promise<number> {
    return this.command.zcard(key);
  }

  /** Sets an absolute expiry; used to bound fallback counters. */
  public async expire(key: string, ttlMs: number): Promise<boolean> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('T77 Redis expiry requires a positive TTL.');
    }

    return (await this.command.pexpire(key, Math.floor(ttlMs))) === 1;
  }

  /** Reads the remaining TTL in milliseconds. -1 means no expiry, -2 missing. */
  public async pttl(key: string): Promise<number> {
    return this.command.pttl(key);
  }

  /** Iterates SCAN until the cursor returns to zero, bounded by a hard cap. */
  public async scan(match: string, count = 200): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    let iterations = 0;

    do {
      const [nextCursor, batch] = await this.command.scan(
        cursor,
        'MATCH',
        match,
        'COUNT',
        Math.min(Math.max(count, 1), 1_000),
      );
      cursor = nextCursor;
      keys.push(...batch);
      iterations += 1;

      if (iterations > 10_000) {
        throw new Error('T77 cache scan exceeded its safe iteration limit.');
      }
    } while (cursor !== '0');

    return keys;
  }

  public async publish(channel: string, message: string): Promise<number> {
    return this.command.publish(channel, message);
  }

  /** Subscribes on a dedicated connection. Multiple handlers share it. */
  public async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    if (this.closed) {
      throw new Error('T77 Redis has been closed.');
    }

    const subscription = this.ensureSubscriber();
    if (subscription.status === 'wait') {
      await subscription.connect();
    }

    const handlers = this.subscriberHandlers.get(channel) ?? new Set();
    const isNewChannel = handlers.size === 0;
    handlers.add(handler);
    this.subscriberHandlers.set(channel, handlers);

    if (isNewChannel) {
      await subscription.subscribe(channel);
    }
  }

  public async unsubscribe(channel: string, handler: (message: string) => void): Promise<void> {
    const handlers = this.subscriberHandlers.get(channel);
    if (!handlers) {
      return;
    }

    handlers.delete(handler);

    if (handlers.size === 0) {
      this.subscriberHandlers.delete(channel);
      if (this.subscriber?.status === 'ready') {
        await this.subscriber.unsubscribe(channel);
      }
    }
  }

  /** Closes both command and subscriber connections. Safe to call twice. */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.connected = false;

    const subscriber = this.subscriber;
    this.subscriber = null;
    this.subscriberHandlers.clear();

    if (subscriber) {
      await closeClient(subscriber);
    }

    await closeClient(this.command);
    this.logger?.info('T77 Redis connection closed');
  }

  private createClient(): Redis {
    const client = new Redis(this.options.url, {
      lazyConnect: this.options.lazyConnect ?? true,
      maxRetriesPerRequest: this.options.maxRetriesPerRequest ?? 2,
      connectTimeout: this.options.connectTimeoutMs ?? 5_000,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
      ...(this.options.keyPrefix === undefined ? {} : { keyPrefix: this.options.keyPrefix }),
    });

    return client;
  }

  private ensureSubscriber(): Redis {
    if (this.subscriber) {
      return this.subscriber;
    }

    const subscriber = this.createClient();
    subscriber.on('error', (error) => {
      this.logger?.error({ err: error }, 'T77 Redis subscriber connection error');
    });
    subscriber.on('message', (channel: string, message: string) => {
      const handlers = this.subscriberHandlers.get(channel);
      if (!handlers) {
        return;
      }

      for (const handler of handlers) {
        try {
          handler(message);
        } catch (error) {
          this.logger?.error({ err: error, channel }, 'T77 Redis subscriber handler failed');
        }
      }
    });

    this.subscriber = subscriber;
    return subscriber;
  }
}

async function closeClient(client: Redis): Promise<void> {
  try {
    if (client.status === 'end') {
      return;
    }

    if (client.status === 'wait') {
      client.disconnect();
      return;
    }

    await client.quit();
  } catch {
    client.disconnect();
  }
}
