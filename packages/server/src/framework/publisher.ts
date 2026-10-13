import type { Redis } from 'ioredis';
import type { EventRecord, StreamId } from '../journal/types.js';

export interface Publisher {
  publish(stream: StreamId, events: EventRecord[]): Promise<void>;
}

export function channelFor(stream: StreamId): string {
  return `events:${stream}`;
}

export class InMemoryPublisher implements Publisher {
  readonly messages: { stream: StreamId; events: EventRecord[] }[] = [];

  async publish(stream: StreamId, events: EventRecord[]): Promise<void> {
    this.messages.push({ stream, events });
  }
}

export class RedisPublisher implements Publisher {
  constructor(private readonly redis: Redis) {}

  async publish(stream: StreamId, events: EventRecord[]): Promise<void> {
    const body = events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() }));
    await this.redis.publish(channelFor(stream), JSON.stringify(body));
  }
}
