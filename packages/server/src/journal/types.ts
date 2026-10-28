export type StreamId = string;
export type Actor = string;
export type EventId = string;

export interface NewEvent {
  type: string;
  payload: unknown;
  reason?: string;
  reversesEventId?: EventId;
}

export interface EventRecord {
  id: EventId;
  stream: StreamId;
  seq: number;
  type: string;
  typeVersion: number;
  payload: unknown;
  actor: Actor;
  reason: string | null;
  reversesEventId: EventId | null;
  correlationId: string;
  createdAt: Date;
}

export class JournalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'JournalError';
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STREAM_RE = new RegExp(`^(platform|(giveaway|team|account):${UUID})$`);
const ACTOR_RE = new RegExp(`^(user:${UUID}|system:(ingest|scheduler|twitch|migration))$`);

export function assertStreamId(s: string): void {
  if (!STREAM_RE.test(s)) throw new JournalError('invalid_stream', `Unbekannter Strom: ${s}`);
}

export function assertActor(a: string): void {
  if (!ACTOR_RE.test(a)) throw new JournalError('invalid_actor', `Unbekannter Akteur: ${a}`);
}
