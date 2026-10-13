import type { Queryable } from '../db/pool.js';
import type { StreamId } from './types.js';

export interface ReducerRef {
  name: string;
  version: number;
}

export async function loadSnapshot<S>(db: Queryable, stream: StreamId, reducer: ReducerRef): Promise<{ seq: number; state: S } | null> {
  const r = await db.query<{ seq: number; state: S }>(
    'SELECT seq, state FROM snapshots WHERE stream = $1 AND reducer = $2 AND reducer_version = $3 ORDER BY seq DESC LIMIT 1',
    [stream, reducer.name, reducer.version],
  );
  return r.rows[0] ?? null;
}

export async function saveSnapshot(db: Queryable, stream: StreamId, reducer: ReducerRef, seq: number, state: unknown, at: Date): Promise<void> {
  await db.query(
    `INSERT INTO snapshots (stream, seq, reducer, reducer_version, state, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [stream, seq, reducer.name, reducer.version, JSON.stringify(state), at],
  );
}
