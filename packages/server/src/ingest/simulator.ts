// Simulator-Adapter (NEW_DESIGN.md 10.1, 12.2): erzeugt Signale im Prozess, deterministisch je Seed, ohne Netz.
import type { Pid } from '../kernel-api/index.js';
import { minuteOf } from './bundler.js';
import type { AdapterHealth, ChannelRef, FollowResult, IngestAdapter, SendResult, Signal, SignalUser } from './signals.js';

/** Kleiner, deterministischer PRNG. Liefert Werte in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulatorOptions {
  viewersPerChannel?: number;
  seed?: number;
  chatEveryMs?: number;
  followEveryMs?: number;
  now?: () => Date;
}

const TEXTS = ['Hallo zusammen!', 'Das Spiel läuft heute richtig gut.', 'Wann kommt die nächste Runde?', 'Ich bin dabei.', 'Viel Glück an alle!'];
const STATE_EVERY_MS = 60_000;
const FOLLOW_SINCE = '2026-01-01T00:00:00.000Z';

interface SimChannel {
  ref: ChannelRef;
  users: SignalUser[];
  lastMinute: string | null;
  lastChatMs: number | null;
  lastFollowMs: number | null;
  lastStateMs: number | null;
  lastSignalAt: string | null;
}

export class SimulatorAdapter implements IngestAdapter {
  readonly sent: { channel: Pid; text: string }[] = [];
  private readonly byPid = new Map<Pid, SimChannel>();
  private handler: (s: Signal) => void = () => {};
  private readonly rng: () => number;
  private readonly viewers: number;
  private readonly chatEveryMs: number;
  private readonly followEveryMs: number;
  private readonly now: () => Date;
  private nextUser = 1;
  private nextMessage = 1;
  private nextSent = 1;

  constructor(o: SimulatorOptions = {}) {
    this.rng = mulberry32(o.seed ?? 1);
    this.viewers = o.viewersPerChannel ?? 20;
    this.chatEveryMs = o.chatEveryMs ?? 4_000;
    this.followEveryMs = o.followEveryMs ?? 300_000;
    this.now = o.now ?? (() => new Date());
  }

  async start(channels: ChannelRef[]): Promise<void> {
    for (const ref of channels) {
      if (!ref.owned) {
        this.byPid.delete(ref.pid);
        continue;
      }
      const existing = this.byPid.get(ref.pid);
      if (existing) {
        existing.ref = ref;
        continue;
      }
      const users = Array.from({ length: this.viewers }, () => {
        const k = this.nextUser++;
        return { id: `sim-${k}`, login: `sim${k}`, displayName: `Sim ${k}` };
      });
      const ch: SimChannel = { ref, users, lastMinute: null, lastChatMs: null, lastFollowMs: null, lastStateMs: null, lastSignalAt: null };
      this.byPid.set(ref.pid, ch);
      this.emit(ch, { kind: 'stream_state', channel: ref.pid, at: this.now().toISOString(), live: true, viewers: this.viewers }, this.now());
    }
  }

  async stop(channel: ChannelRef): Promise<void> {
    const ch = this.byPid.get(channel.pid);
    if (!ch) return;
    this.byPid.delete(channel.pid);
    this.emit(ch, { kind: 'stream_state', channel: channel.pid, at: this.now().toISOString(), live: false }, this.now());
  }

  onSignal(handler: (s: Signal) => void): void {
    this.handler = handler;
  }

  async sendChat(channel: ChannelRef, text: string): Promise<SendResult> {
    this.sent.push({ channel: channel.pid, text });
    return { ok: true, messageId: `sim-sent-${this.nextSent++}` };
  }

  async checkFollows(_channel: ChannelRef, userIds: string[]): Promise<FollowResult[]> {
    return userIds.map((userId) => ({ userId, follows: true, since: FOLLOW_SINCE }));
  }

  health(): AdapterHealth[] {
    return [...this.byPid.values()].map((ch) => ({ channel: ch.ref.pid, ok: true, lastSignalAt: ch.lastSignalAt, problem: null }));
  }

  async close(): Promise<void> {
    this.byPid.clear();
  }

  /** Nur für Tests: reicht ein Signal unverändert durch. */
  inject(s: Signal): void {
    this.handler(s);
  }

  channels(): ChannelRef[] {
    return [...this.byPid.values()].map((ch) => ch.ref);
  }

  /** Takt des Ingest-Workers. Erzeugt je Kanal Anwesenheit je Minute, Chat, Follows und Live-Status. */
  tick(now: Date): void {
    const ms = now.getTime();
    const at = now.toISOString();
    for (const ch of this.byPid.values()) {
      const pid = ch.ref.pid;
      if (ch.lastStateMs === null) ch.lastStateMs = ms;
      else if (ms - ch.lastStateMs >= STATE_EVERY_MS) {
        ch.lastStateMs = ms;
        this.emit(ch, { kind: 'stream_state', channel: pid, at, live: true, viewers: this.viewers }, now);
      }
      if (ch.ref.watch !== 'full') continue;
      const minute = minuteOf(now);
      if (ch.lastMinute !== minute) {
        ch.lastMinute = minute;
        this.emit(ch, { kind: 'presence', channel: pid, minute, users: this.subset(ch.users) }, now);
      }
      if (ch.lastChatMs === null) ch.lastChatMs = ms;
      else if (ms - ch.lastChatMs >= this.chatEveryMs) {
        ch.lastChatMs = ms;
        const user = this.pick(ch.users);
        const text = TEXTS[Math.floor(this.rng() * TEXTS.length)]!;
        this.emit(ch, { kind: 'chat', channel: pid, at, user, text, messageId: `sim-${this.nextMessage++}` }, now);
      }
      if (ch.lastFollowMs === null) ch.lastFollowMs = ms;
      else if (ms - ch.lastFollowMs >= this.followEveryMs) {
        ch.lastFollowMs = ms;
        this.emit(ch, { kind: 'follow', channel: pid, at, user: this.pick(ch.users) }, now);
      }
    }
  }

  private emit(ch: SimChannel, s: Signal, now: Date): void {
    ch.lastSignalAt = now.toISOString();
    this.handler(s);
  }

  private pick(users: SignalUser[]): SignalUser {
    return users[Math.floor(this.rng() * users.length)]!;
  }

  /** 80–100 % der Nutzer, Reihenfolge nach id. */
  private subset(users: SignalUser[]): SignalUser[] {
    const n = Math.min(users.length, Math.ceil(users.length * (0.8 + this.rng() * 0.2)));
    const ranked = users.map((u) => ({ u, r: this.rng() })).sort((a, b) => a.r - b.r).slice(0, n);
    return ranked.map((x) => x.u).sort((a, b) => a.id.localeCompare(b.id));
  }
}
