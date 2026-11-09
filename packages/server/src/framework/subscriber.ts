// Live-Push (NEW_DESIGN.md 3.3 Schritt 5, 11): wer Ereignisse eines Stroms sehen will, abonniert sie. Redis ist nur Transport.
import type { Redis } from 'ioredis';
import type { EventRecord, StreamId } from '../journal/types.js';
import { channelFor, type Publisher } from './publisher.js';

export type EventListener = (events: EventRecord[]) => void;

export interface Subscriber {
  /** Ruft fn je veröffentlichtem Ereignisbündel des Stroms. Die Rückgabe beendet das Abonnement. */
  subscribe(stream: StreamId, fn: EventListener): () => void;
}

class Listeners {
  private readonly byStream = new Map<StreamId, Set<EventListener>>();

  add(stream: StreamId, fn: EventListener): () => void {
    const set = this.byStream.get(stream) ?? new Set<EventListener>();
    set.add(fn);
    this.byStream.set(stream, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.byStream.delete(stream);
    };
  }

  emit(stream: StreamId, events: EventRecord[]): void {
    for (const fn of this.byStream.get(stream) ?? []) fn(events);
  }
}

/** Ein Prozess, kein Redis: Veröffentlichen und Abonnieren im selben Objekt (Tests, lokale Läufe). */
export class LocalBus implements Publisher, Subscriber {
  readonly messages: { stream: StreamId; events: EventRecord[] }[] = [];
  private readonly listeners = new Listeners();

  async publish(stream: StreamId, events: EventRecord[]): Promise<void> {
    this.messages.push({ stream, events });
    this.listeners.emit(stream, events);
  }

  subscribe(stream: StreamId, fn: EventListener): () => void {
    return this.listeners.add(stream, fn);
  }
}

const CHANNEL_PREFIX = channelFor('');

/** Eigene ioredis-Verbindung (im Abo-Modus kann sie nichts anderes), psubscribe auf alle Ströme. */
export class RedisSubscriber implements Subscriber {
  private readonly listeners = new Listeners();
  private readonly errorHandlers: ((err: unknown) => void)[] = [];

  constructor(private readonly redis: Redis) {}

  async start(): Promise<void> {
    this.redis.on('pmessage', (_pattern: string, channel: string, message: string) => {
      if (!channel.startsWith(CHANNEL_PREFIX)) return;
      let body: (Omit<EventRecord, 'createdAt'> & { createdAt: string })[];
      try {
        body = JSON.parse(message);
      } catch {
        return;
      }
      this.listeners.emit(channel.slice(CHANNEL_PREFIX.length), body.map((e) => ({ ...e, createdAt: new Date(e.createdAt) })));
    });
    this.redis.on('error', (err: unknown) => {
      for (const fn of this.errorHandlers) fn(err);
    });
    await this.redis.psubscribe(`${CHANNEL_PREFIX}*`);
  }

  async stop(): Promise<void> {
    try {
      await this.redis.punsubscribe();
    } finally {
      this.redis.disconnect();
    }
  }

  subscribe(stream: StreamId, fn: EventListener): () => void {
    return this.listeners.add(stream, fn);
  }

  /** Redis weg: die App schließt die Live-Verbindungen, die Oberflächen verbinden neu (NEW_DESIGN.md 12.1). */
  onError(fn: (err: unknown) => void): void {
    this.errorHandlers.push(fn);
  }
}
