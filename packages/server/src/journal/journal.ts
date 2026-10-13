import type pg from 'pg';
import type { Queryable } from '../db/pool.js';
import type { EventTypeRegistry } from './event-types.js';
import { assertActor, assertStreamId, type Actor, type EventId, type EventRecord, type NewEvent, type StreamId } from './types.js';

export interface AppendArgs {
  stream: StreamId;
  lastSeq: number;
  events: NewEvent[];
  actor: Actor;
  correlationId: string;
  at: Date;
}

export interface EventRow {
  id: string;
  stream: string;
  seq: number;
  type: string;
  type_version: number;
  payload: unknown;
  actor: string;
  reason: string | null;
  reverses_event_id: string | null;
  correlation_id: string;
  created_at: Date;
}

const COLUMNS = 'id, stream, seq, type, type_version, payload, actor, reason, reverses_event_id, correlation_id, created_at';

export function rowToRecord(row: EventRow): EventRecord {
  return {
    id: String(row.id),
    stream: row.stream,
    seq: row.seq,
    type: row.type,
    typeVersion: row.type_version,
    payload: row.payload,
    actor: row.actor,
    reason: row.reason,
    reversesEventId: row.reverses_event_id === null ? null : String(row.reverses_event_id),
    correlationId: row.correlation_id,
    createdAt: row.created_at,
  };
}

/** Sperrt den Strom bis zum Ende der Transaktion und liefert die letzte seq. */
export async function lockStream(c: pg.PoolClient, stream: StreamId): Promise<number> {
  assertStreamId(stream);
  await c.query('INSERT INTO stream_heads (stream, last_seq) VALUES ($1, 0) ON CONFLICT (stream) DO NOTHING', [stream]);
  const r = await c.query<{ last_seq: number }>('SELECT last_seq FROM stream_heads WHERE stream = $1 FOR UPDATE', [stream]);
  return r.rows[0]!.last_seq;
}

/** Nur nach lockStream in derselben Transaktion aufrufen. */
export async function appendLocked(c: pg.PoolClient, registry: EventTypeRegistry, a: AppendArgs): Promise<EventRecord[]> {
  assertActor(a.actor);
  if (a.events.length === 0) return [];
  const out: EventRecord[] = [];
  let seq = a.lastSeq;
  for (const e of a.events) {
    const p = registry.prepare(e);
    seq += 1;
    const r = await c.query<{ id: string }>(
      `INSERT INTO events (stream, seq, type, type_version, payload, actor, reason, reverses_event_id, correlation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [a.stream, seq, p.type, p.typeVersion, JSON.stringify(p.payload), a.actor, p.reason, p.reversesEventId, a.correlationId, a.at],
    );
    out.push({
      id: String(r.rows[0]!.id), stream: a.stream, seq, type: p.type, typeVersion: p.typeVersion, payload: p.payload,
      actor: a.actor, reason: p.reason, reversesEventId: p.reversesEventId, correlationId: a.correlationId, createdAt: a.at,
    });
  }
  await c.query('UPDATE stream_heads SET last_seq = $2 WHERE stream = $1', [a.stream, seq]);
  return out;
}

export async function readStream(db: Queryable, registry: EventTypeRegistry, stream: StreamId, afterSeq = 0): Promise<EventRecord[]> {
  const r = await db.query<EventRow>(`SELECT ${COLUMNS} FROM events WHERE stream = $1 AND seq > $2 ORDER BY seq`, [stream, afterSeq]);
  return r.rows.map((row) => registry.upcast(rowToRecord(row)));
}

export async function readEvent(db: Queryable, registry: EventTypeRegistry, id: EventId): Promise<EventRecord | null> {
  if (!/^\d+$/.test(id)) return null;
  const r = await db.query<EventRow>(`SELECT ${COLUMNS} FROM events WHERE id = $1`, [id]);
  return r.rows[0] ? registry.upcast(rowToRecord(r.rows[0])) : null;
}

export async function isReverted(db: Queryable, id: EventId): Promise<boolean> {
  const r = await db.query('SELECT 1 FROM events WHERE reverses_event_id = $1 LIMIT 1', [id]);
  return (r.rowCount ?? 0) > 0;
}
