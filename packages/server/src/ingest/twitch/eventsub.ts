// EventSub über WebSocket (NEW_DESIGN.md 10.2): Sitzung, Keepalive, Reconnect, Benachrichtigungen → Signale.
import type { BusLogger } from '../../framework/command-bus.js';
import type { ChannelRef, Signal } from '../signals.js';

export const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
export const KEEPALIVE_GRACE_SEC = 10;
const DEFAULT_KEEPALIVE_SEC = 10;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 4_000;
/** So viele message_ids merkt sich eine Verbindung für die Entdopplung. Twitch liefert mindestens einmal, besonders um einen Reconnect. */
export const SEEN_MESSAGES_MAX = 5_000;

export type EventSubMessage =
  | { type: 'session_welcome'; sessionId: string; keepaliveSec: number }
  | { type: 'session_keepalive' }
  | { type: 'session_reconnect'; url: string }
  | { type: 'notification'; subscriptionType: string; messageId: string | null; event: Record<string, unknown> }
  | { type: 'revocation'; subscriptionType: string; status: string; broadcasterId: string | null }
  | { type: 'unknown' };

const UNKNOWN: EventSubMessage = { type: 'unknown' };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

/** Wirft nie. Unlesbares oder Unbekanntes wird `unknown`. */
export function parseMessage(raw: string): EventSubMessage {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return UNKNOWN;
  }
  const metadata = obj(obj(m).metadata);
  const payload = obj(obj(m).payload);
  const session = obj(payload.session);
  switch (metadata.message_type) {
    case 'session_welcome': {
      const sessionId = str(session.id);
      if (sessionId === null) return UNKNOWN;
      const keepalive = session.keepalive_timeout_seconds;
      return { type: 'session_welcome', sessionId, keepaliveSec: typeof keepalive === 'number' && keepalive > 0 ? keepalive : DEFAULT_KEEPALIVE_SEC };
    }
    case 'session_keepalive':
      return { type: 'session_keepalive' };
    case 'session_reconnect': {
      const url = str(session.reconnect_url);
      return url === null ? UNKNOWN : { type: 'session_reconnect', url };
    }
    case 'notification': {
      const subscriptionType = str(metadata.subscription_type);
      return subscriptionType === null ? UNKNOWN : { type: 'notification', subscriptionType, messageId: str(metadata.message_id), event: obj(payload.event) };
    }
    case 'revocation': {
      const subscription = obj(payload.subscription);
      return {
        type: 'revocation',
        subscriptionType: str(metadata.subscription_type) ?? str(subscription.type) ?? '',
        status: str(subscription.status) ?? '',
        broadcasterId: str(obj(subscription.condition).broadcaster_user_id),
      };
    }
    default:
      return UNKNOWN;
  }
}

/** Benachrichtigung → Signal. Unbekannter Broadcaster, eigene Bot-Nachrichten und fremde Typen → null. */
export function toSignal(
  m: Extract<EventSubMessage, { type: 'notification' }>,
  channelOf: (twitchId: string) => ChannelRef | undefined,
  botUserId: string,
  now: () => Date,
): Signal | null {
  const e = m.event;
  const broadcaster = str(e.broadcaster_user_id);
  const ref = broadcaster === null ? undefined : channelOf(broadcaster);
  if (!ref) return null;
  switch (m.subscriptionType) {
    case 'channel.chat.message': {
      const id = str(e.chatter_user_id);
      const messageId = str(e.message_id);
      const text = str(obj(e.message).text);
      if (id === null || id === botUserId || messageId === null || text === null) return null;
      return { kind: 'chat', channel: ref.pid, at: now().toISOString(), user: { id, login: str(e.chatter_user_login) ?? '', displayName: str(e.chatter_user_name) ?? '' }, text, messageId };
    }
    case 'stream.online':
      return { kind: 'stream_state', channel: ref.pid, at: now().toISOString(), live: true };
    case 'stream.offline':
      return { kind: 'stream_state', channel: ref.pid, at: now().toISOString(), live: false };
    case 'channel.follow': {
      const id = str(e.user_id);
      if (id === null) return null;
      return { kind: 'follow', channel: ref.pid, at: str(e.followed_at) ?? now().toISOString(), user: { id, login: str(e.user_login) ?? '', displayName: str(e.user_name) ?? '' } };
    }
    default:
      return null;
  }
}

/** Teilmenge des globalen WebSocket, damit Tests einen Fake einsetzen. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
}

export interface EventSubSocketOptions {
  url?: string;
  connect?: (url: string) => SocketLike;
  /** Nach jeder neuen Sitzung (auch nach Reconnect): Shard binden. */
  onSession: (sessionId: string) => Promise<void>;
  onMessage: (m: EventSubMessage) => void;
  log: BusLogger;
  sleep?: (ms: number) => Promise<void>;
}

export class EventSubSocket {
  sessionId: string | null = null;
  private current: SocketLike | null = null;
  /** Ersatzverbindung nach session_reconnect, noch ohne Welcome. */
  private pending: SocketLike | null = null;
  private readonly retired = new WeakSet<SocketLike>();
  /** Zuletzt gelieferte message_ids, in Ankunftsreihenfolge. Überlebt den Reconnect, weil Twitch dann alte Nachrichten wiederholt. */
  private readonly seen = new Set<string>();
  private closedByUs = false;
  private keepaliveTimer: NodeJS.Timeout | undefined;
  private keepaliveMs = (DEFAULT_KEEPALIVE_SEC + KEEPALIVE_GRACE_SEC) * 1000;
  private attempts = 0;
  private startResolve: (() => void) | null = null;
  private readonly url: string;
  private readonly connect: (url: string) => SocketLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: EventSubSocketOptions) {
    this.url = o.url ?? EVENTSUB_URL;
    this.connect = o.connect ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.sleep = o.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Verbindet und löst mit der ersten Sitzung auf. */
  start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.startResolve = resolve;
      this.open(this.url, null);
    });
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.clearKeepalive();
    this.current?.close();
    this.current = null;
  }

  private open(url: string, replacing: SocketLike | null): SocketLike {
    const s = this.connect(url);
    s.addEventListener('message', (ev) => this.onRaw(s, typeof ev.data === 'string' ? ev.data : String(ev.data ?? ''), replacing));
    s.addEventListener('close', (ev) => void this.onClose(s, ev));
    s.addEventListener('error', () => this.o.log.error({ url }, 'Die EventSub-Verbindung meldet einen Fehler.'));
    if (replacing === null) this.current = s;
    return s;
  }

  private onRaw(s: SocketLike, raw: string, replacing: SocketLike | null): void {
    const m = parseMessage(raw);
    if (m.type === 'session_welcome') {
      if (replacing !== null) {
        this.retired.add(replacing);
        replacing.close();
      }
      if (s === this.pending) this.pending = null;
      this.current = s;
      this.sessionId = m.sessionId;
      this.keepaliveMs = (m.keepaliveSec + KEEPALIVE_GRACE_SEC) * 1000;
      this.attempts = 0;
      this.armKeepalive();
      this.o.onSession(m.sessionId).catch((err: unknown) => this.o.log.error({ err, sessionId: m.sessionId }, 'Die EventSub-Sitzung ließ sich nicht einrichten.'));
      this.startResolve?.();
      this.startResolve = null;
      return;
    }
    if (s === this.current) this.armKeepalive();
    switch (m.type) {
      case 'session_reconnect':
        this.pending = this.open(m.url, s);
        return;
      case 'notification':
        if (m.messageId !== null && !this.firstDelivery(m.messageId)) return;
        this.o.onMessage(m);
        return;
      case 'revocation':
        this.o.onMessage(m);
        return;
      default:
        return;
    }
  }

  private async onClose(s: SocketLike, ev: { code?: number; reason?: string }): Promise<void> {
    if (this.closedByUs || this.retired.has(s)) return;
    this.retired.add(s);
    // Nur die aktuelle Verbindung treibt den Reconnect, und nur, wenn kein Ersatz schon unterwegs ist.
    // Eine alte Verbindung, die Twitch spät schließt, öffnet keine weitere (sonst Reconnect-Sturm).
    const wasCurrent = s === this.current;
    const wasPending = s === this.pending;
    if (wasPending) this.pending = null;
    if (wasCurrent) {
      this.current = null;
      this.clearKeepalive();
    }
    if (!wasCurrent && !wasPending) return;
    if (wasCurrent && this.pending !== null) return;
    if (wasPending && this.current !== null) return;
    this.attempts += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempts - 1), RECONNECT_MAX_MS);
    this.o.log.error({ code: ev.code, reason: ev.reason, attempt: this.attempts, delay }, 'Die EventSub-Verbindung ist abgerissen. Neuer Versuch folgt.');
    await this.sleep(delay);
    if (this.closedByUs) return;
    this.open(this.url, null);
  }

  /** Merkt sich die message_id. Liefert false, wenn sie schon da war. Älteste Einträge fallen ab SEEN_MESSAGES_MAX heraus. */
  private firstDelivery(messageId: string): boolean {
    if (this.seen.has(messageId)) return false;
    this.seen.add(messageId);
    if (this.seen.size > SEEN_MESSAGES_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  private armKeepalive(): void {
    this.clearKeepalive();
    this.keepaliveTimer = setTimeout(() => {
      this.o.log.error({ keepaliveMs: this.keepaliveMs }, 'EventSub schweigt. Die Verbindung wird neu aufgebaut.');
      this.current?.close();
    }, this.keepaliveMs);
    this.keepaliveTimer.unref?.();
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }
}
