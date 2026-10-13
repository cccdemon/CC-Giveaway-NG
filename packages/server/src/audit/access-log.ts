import type pg from 'pg';
import { withTx, type Queryable } from '../db/pool.js';

export interface DeniedEntry { actor: string; action: string; reason: string; target?: string | null; ip?: string | null; at: Date }
export interface ReadEntry { actor: string; action: string; target: string; ip?: string | null; at: Date }

export const DENY_WINDOW_MS = 5 * 60 * 1000;
export const IP_RETENTION_DAYS = 30;

export async function logDenied(pool: pg.Pool, e: DeniedEntry): Promise<void> {
  await withTx(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1 || '|' || $2 || '|' || $3))", [e.actor, e.action, e.reason]);
    const windowStart = new Date(e.at.getTime() - DENY_WINDOW_MS);
    const upd = await c.query(
      `UPDATE access_log SET count = count + 1, last_at = GREATEST(last_at, $4)
       WHERE id = (SELECT id FROM access_log
                   WHERE kind = 'denied' AND actor = $1 AND action = $2 AND reason = $3 AND first_at > $5
                   ORDER BY first_at DESC LIMIT 1)`,
      [e.actor, e.action, e.reason, e.at, windowStart],
    );
    if ((upd.rowCount ?? 0) > 0) return;
    await c.query(
      `INSERT INTO access_log (kind, actor, action, reason, target, ip, first_at, last_at)
       VALUES ('denied', $1, $2, $3, $4, $5, $6, $6)`,
      [e.actor, e.action, e.reason, e.target ?? null, e.ip ?? null, e.at],
    );
  });
}

export async function logRead(db: Queryable, e: ReadEntry): Promise<void> {
  await db.query(
    `INSERT INTO access_log (kind, actor, action, target, ip, first_at, last_at) VALUES ('read', $1, $2, $3, $4, $5, $5)`,
    [e.actor, e.action, e.target, e.ip ?? null, e.at],
  );
}

export async function purgeIps(db: Queryable, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - IP_RETENTION_DAYS * 86_400_000);
  const r = await db.query('UPDATE access_log SET ip = NULL WHERE ip IS NOT NULL AND last_at < $1', [cutoff]);
  return r.rowCount ?? 0;
}
