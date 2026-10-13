import type pg from 'pg';
import { withTx } from '../db/pool.js';

const LOCK_KEY = 4242001;

export function partitionName(d: Date): string {
  return `events_y${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function ensurePartitions(pool: pg.Pool, now: Date, monthsAhead = 2): Promise<string[]> {
  return withTx(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const names: string[] = [];
    for (let i = 0; i <= monthsAhead; i++) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i + 1, 1));
      const name = partitionName(start);
      await c.query(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF events FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
      );
      names.push(name);
    }
    return names;
  });
}

export function isMissingPartition(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === '23514' && /no partition of relation/.test(err.message ?? '');
}
