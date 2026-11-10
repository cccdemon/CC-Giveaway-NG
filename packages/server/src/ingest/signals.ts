// Adapter-Schnittstelle des Ingest (NEW_DESIGN.md 10.1). Signale tragen Twitch-Nutzer, Ereignisse später nur pids.
import type { Pid } from '../kernel-api/index.js';

/** Strukturgleich mit identity/identities.ts TwitchUser. */
export interface SignalUser {
  id: string;
  login: string;
  displayName: string;
}

export interface ChannelRef {
  pid: Pid;
  twitchId: string;
  /** state: nur Live-Status und Zuschauerzahl. full: dazu Chat, Follow und Anwesenheit je Minute. */
  watch: 'state' | 'full';
  /** Dieser Worker pollt und abonniert den Kanal (konsistenter Hash, NEW_DESIGN.md 10.2). */
  owned: boolean;
}

export type Signal =
  | { kind: 'presence'; channel: Pid; minute: string; users: SignalUser[] }
  | { kind: 'chat'; channel: Pid; at: string; user: SignalUser; text: string; messageId: string }
  | { kind: 'follow'; channel: Pid; at: string; user: SignalUser }
  | { kind: 'stream_state'; channel: Pid; at: string; live: boolean; viewers?: number };

/** Fehlercode einer Chat-Nachricht: steht im Nachweis announcement_sent und wird in der Web-App übersetzt. Nie Freitext. */
export const SEND_ERROR_CODES = ['helix_unauthorized', 'helix_forbidden', 'helix_ratelimited', 'helix_unreachable', 'helix_error', 'dropped', 'send_failed'] as const;
export type SendErrorCode = (typeof SEND_ERROR_CODES)[number];
/** detail: Klartext nur für das Log, nie für das Journal. */
export type SendResult = { ok: true; messageId: string } | { ok: false; reason: SendErrorCode; detail?: string };

export interface FollowResult {
  userId: string;
  follows: boolean;
  since: string | null;
}

export interface AdapterHealth {
  channel: Pid;
  ok: boolean;
  lastSignalAt: string | null;
  problem: string | null;
}

export interface IngestAdapter {
  /** Idempotent. Ein schon gestarteter Kanal wird mit dem neuen Ref ersetzt (Wechsel state ↔ full). */
  start(channels: ChannelRef[]): Promise<void>;
  stop(channel: ChannelRef): Promise<void>;
  onSignal(handler: (s: Signal) => void): void;
  sendChat(channel: ChannelRef, text: string): Promise<SendResult>;
  checkFollows(channel: ChannelRef, userIds: string[]): Promise<FollowResult[]>;
  health(): AdapterHealth[];
  close(): Promise<void>;
}
