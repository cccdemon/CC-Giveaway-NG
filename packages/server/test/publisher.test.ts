import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryPublisher, RedisPublisher, channelFor } from '../src/framework/publisher.js';
import { LocalBus, RedisSubscriber } from '../src/framework/subscriber.js';
import type { EventRecord } from '../src/journal/types.js';
import { AT } from './helpers/db.js';
import { ACTOR, STREAM } from './helpers/fixtures.js';

const ev: EventRecord = {
  id: '1', stream: STREAM, seq: 1, type: 'counter_incremented', typeVersion: 1, payload: { by: 1 }, actor: ACTOR,
  reason: null, reversesEventId: null, correlationId: '00000000-0000-4000-8000-000000000000', createdAt: AT,
};

let container: StartedTestContainer;
beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
});
afterAll(async () => container?.stop());

describe('publishers', () => {
  it('InMemoryPublisher records messages', async () => {
    const p = new InMemoryPublisher();
    await p.publish(STREAM, [ev]);
    expect(p.messages).toEqual([{ stream: STREAM, events: [ev] }]);
  });

  it('LocalBus delivers published events to stream subscribers and unsubscribe stops them', async () => {
    const bus = new LocalBus();
    const got: EventRecord[][] = [];
    const other: EventRecord[][] = [];
    const stop = bus.subscribe(STREAM, (events) => got.push(events));
    bus.subscribe('team:00000000-0000-4000-8000-000000000001', (events) => other.push(events));
    await bus.publish(STREAM, [ev]);
    expect(got).toEqual([[ev]]);
    expect(other).toEqual([]);
    stop();
    await bus.publish(STREAM, [ev]);
    expect(got).toEqual([[ev]]);
    expect(bus.messages).toHaveLength(2);
  });

  it('LocalBus.subscribeAll receives every stream with its id and the returned function unsubscribes', async () => {
    const bus = new LocalBus();
    const got: { stream: string; events: EventRecord[] }[] = [];
    const stop = bus.subscribeAll((stream, events) => got.push({ stream, events }));
    await bus.publish(STREAM, [ev]);
    await bus.publish('team:00000000-0000-4000-8000-000000000001', [ev]);
    expect(got).toEqual([{ stream: STREAM, events: [ev] }, { stream: 'team:00000000-0000-4000-8000-000000000001', events: [ev] }]);
    stop();
    await bus.publish(STREAM, [ev]);
    expect(got).toHaveLength(2);
  });

  it('RedisSubscriber.subscribeAll receives every stream', async () => {
    const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    const subRedis = new Redis(url);
    const pub = new Redis(url);
    const sub = new RedisSubscriber(subRedis);
    await sub.start();
    const got = new Promise<{ stream: string; events: EventRecord[] }>((resolve) => sub.subscribeAll((stream, events) => resolve({ stream, events })));
    await new RedisPublisher(pub).publish(STREAM, [ev]);
    expect(await got).toEqual({ stream: STREAM, events: [ev] });
    await sub.stop();
    pub.disconnect();
  });

  it('RedisSubscriber receives events published on events:<stream> with createdAt as Date', async () => {
    const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    const subRedis = new Redis(url);
    const pub = new Redis(url);
    const sub = new RedisSubscriber(subRedis);
    await sub.start();
    const got = new Promise<EventRecord[]>((resolve) => sub.subscribe(STREAM, resolve));
    await new RedisPublisher(pub).publish(STREAM, [ev]);
    expect(await got).toEqual([ev]);
    await sub.stop();
    pub.disconnect();
  });

  it('RedisPublisher sends JSON on events:<stream>', async () => {
    const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    const sub = new Redis(url);
    const pub = new Redis(url);
    const got = new Promise<string>((resolve) => sub.on('message', (_ch, msg) => resolve(msg)));
    await sub.subscribe(channelFor(STREAM));
    await new RedisPublisher(pub).publish(STREAM, [ev]);
    const msg = JSON.parse(await got);
    expect(msg).toEqual([{ ...ev, createdAt: AT.toISOString() }]);
    sub.disconnect();
    pub.disconnect();
  });
});
