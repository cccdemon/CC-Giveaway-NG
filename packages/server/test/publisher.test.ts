import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryPublisher, RedisPublisher, channelFor } from '../src/framework/publisher.js';
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
