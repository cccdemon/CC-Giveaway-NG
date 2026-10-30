// Bündelt Signale je Kanal und Minute (NEW_DESIGN.md 3.1). Ein Bündel wird ein Befehl je offenem Giveaway.
import type { BusLogger } from '../framework/command-bus.js';
import type { Pid } from '../kernel-api/index.js';
import type { Signal, SignalUser } from './signals.js';

export interface SignalBundle {
  channel: Pid;
  minute: string;
  presence: SignalUser[] | null;
  chat: { user: SignalUser; at: string; text: string; messageId: string }[];
  follows: { user: SignalUser; at: string }[];
}

export const BUNDLE_GRACE_MS = 5_000;
const MINUTE_MS = 60_000;

export function minuteOf(at: string | Date): string {
  const ms = typeof at === 'string' ? Date.parse(at) : at.getTime();
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
}

export class Bundler {
  private readonly buckets = new Map<string, SignalBundle>();
  private readonly graceMs: number;

  constructor(private readonly o: { flush: (b: SignalBundle) => Promise<void>; graceMs?: number; log: BusLogger }) {
    this.graceMs = o.graceMs ?? BUNDLE_GRACE_MS;
  }

  add(s: Signal): void {
    if (s.kind === 'stream_state') return;
    const minute = s.kind === 'presence' ? s.minute : minuteOf(s.at);
    const b = this.bucket(s.channel, minute);
    switch (s.kind) {
      case 'presence':
        b.presence = s.users;
        break;
      case 'chat':
        b.chat.push({ user: s.user, at: s.at, text: s.text, messageId: s.messageId });
        break;
      case 'follow':
        b.follows.push({ user: s.user, at: s.at });
        break;
    }
  }

  /** Flusht alle Eimer, deren Minute samt Nachlauf vorbei ist, früheste Minute zuerst. */
  async tick(now: Date): Promise<void> {
    const due = [...this.buckets.entries()].filter(([, b]) => Date.parse(b.minute) + MINUTE_MS + this.graceMs <= now.getTime());
    await this.flushAll(due);
  }

  async drain(): Promise<void> {
    await this.flushAll([...this.buckets.entries()]);
  }

  size(): number {
    return this.buckets.size;
  }

  private bucket(channel: Pid, minute: string): SignalBundle {
    const key = `${channel}|${minute}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { channel, minute, presence: null, chat: [], follows: [] };
      this.buckets.set(key, b);
    }
    return b;
  }

  private async flushAll(entries: [string, SignalBundle][]): Promise<void> {
    entries.sort((a, b) => a[1].minute.localeCompare(b[1].minute));
    for (const [key, b] of entries) {
      this.buckets.delete(key);
      try {
        await this.o.flush(b);
      } catch (err) {
        this.o.log.error({ err, channel: b.channel, minute: b.minute }, 'Ein Signalbündel ließ sich nicht verarbeiten. Es ist verloren.');
      }
    }
  }
}
