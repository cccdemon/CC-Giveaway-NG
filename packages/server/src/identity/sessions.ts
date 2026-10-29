// Sitzungen liegen in PostgreSQL, damit ein Redis-Ausfall niemanden abmeldet. Betriebsdaten wie access_log.
import { randomBytes } from 'node:crypto';
import type { Queryable } from '../db/pool.js';

export const SESSION_TTL_DAYS = 30;
export const SESSION_COOKIE = 'ccg_session';

const DAY_MS = 86_400_000;

export async function createSession(db: Queryable, pid: string, now: Date): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * DAY_MS);
  await db.query('INSERT INTO sessions (id, pid, created_at, expires_at) VALUES ($1, $2, $3, $4)', [id, pid, now, expiresAt]);
  return id;
}

/** Nur eine nicht abgelaufene Sitzung ergibt eine pid. */
export async function findSession(db: Queryable, id: string, now: Date): Promise<{ pid: string } | null> {
  const r = await db.query<{ pid: string }>('SELECT pid FROM sessions WHERE id = $1 AND expires_at > $2', [id, now]);
  return r.rows[0] ? { pid: r.rows[0].pid } : null;
}

export async function deleteSession(db: Queryable, id: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE id = $1', [id]);
}

export async function deleteSessionsOf(db: Queryable, pid: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE pid = $1', [pid]);
}

export async function purgeExpiredSessions(db: Queryable, now: Date): Promise<number> {
  const r = await db.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
  return r.rowCount ?? 0;
}
