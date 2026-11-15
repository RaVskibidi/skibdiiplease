import { describe, expect, it } from 'vitest';

import { GuildEventBus, decodeGuildEvent, type PubSubConnection } from '../../src/cache/pubsub.js';

class FakePubSub implements PubSubConnection {
  public readonly channels = new Map<string, Set<(message: string) => void>>();
  public published: Array<{ channel: string; message: string }> = [];

  public publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    const handlers = this.channels.get(channel);
    if (!handlers) {
      return Promise.resolve(0);
    }

    for (const handler of handlers) {
      handler(message);
    }
    return Promise.resolve(handlers.size);
  }

  public subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    const handlers = this.channels.get(channel) ?? new Set();
    handlers.add(handler);
    this.channels.set(channel, handlers);
    return Promise.resolve();
  }

  public unsubscribe(channel: string, handler: (message: string) => void): Promise<void> {
    this.channels.get(channel)?.delete(handler);
    return Promise.resolve();
  }
}

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';

describe('GuildEventBus', () => {
  it('publishes guild-scoped envelopes', async () => {
    const connection = new FakePubSub();
    const bus = new GuildEventBus(connection, { prefix: 't77-test' });

    const event = await bus.publish(GUILD_A, 'config.updated', { version: 2 });

    expect(event.guildId).toBe(GUILD_A);
    expect(event.type).toBe('config.updated');
    expect(connection.published).toHaveLength(1);
    expect(connection.published[0]?.channel).toBe(`t77-test:guild:${GUILD_A}:events`);
  });

  it('delivers only to matching guild subscribers', async () => {
    const connection = new FakePubSub();
    const bus = new GuildEventBus(connection);
    const received: string[] = [];

    const unsubscribeA = await bus.subscribe(GUILD_A, (event) => {
      received.push(`a:${event.type}`);
    });
    await bus.subscribe(GUILD_B, (event) => {
      received.push(`b:${event.type}`);
    });

    await bus.publish(GUILD_A, 'incident.opened', { id: 'incident-1' });

    expect(received).toEqual(['a:incident.opened']);

    await unsubscribeA();
    await bus.publish(GUILD_A, 'incident.closed', { id: 'incident-1' });
    expect(received).toEqual(['a:incident.opened']);
  });

  it('ignores a cross-guild envelope injected into a channel', async () => {
    const connection = new FakePubSub();
    const bus = new GuildEventBus(connection);
    const received: string[] = [];

    await bus.subscribe(GUILD_A, (event) => {
      received.push(event.guildId);
    });

    await connection.publish(
      bus.channel(GUILD_A),
      JSON.stringify({
        version: 1,
        guildId: GUILD_B,
        type: 'config.updated',
        emittedAt: new Date().toISOString(),
        payload: {},
      }),
    );

    expect(received).toEqual([]);
  });

  it('rejects malformed envelopes', () => {
    expect(decodeGuildEvent('not json')).toBeNull();
    expect(decodeGuildEvent(JSON.stringify({ guildId: GUILD_A }))).toBeNull();
    expect(
      decodeGuildEvent(
        JSON.stringify({
          version: 1,
          guildId: 'bad',
          type: 'x',
          emittedAt: new Date().toISOString(),
          payload: null,
        }),
      ),
    ).toBeNull();
  });
});
