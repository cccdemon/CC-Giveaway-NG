// Kanal-Tokens der Streamer, verschlüsselt in channel_tokens (NEW_DESIGN.md 10.2).
import type pg from 'pg';
import type { Queryable } from '../db/pool.js';
import { decrypt, encrypt } from './crypto.js';

export interface NewToken {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: Date;
}

export interface StoredToken extends NewToken {
  status: 'ok' | 'invalid';
}

export async function saveChannelToken(c: pg.PoolClient, pid: string, t: NewToken, key: Buffer, now: Date): Promise<void> {
  await c.query(
    `INSERT INTO channel_tokens (pid, access_token, refresh_token, scopes, expires_at, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'ok', $6)
     ON CONFLICT (pid) DO UPDATE SET access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
       scopes = EXCLUDED.scopes, expires_at = EXCLUDED.expires_at, status = 'ok', updated_at = EXCLUDED.updated_at`,
    [pid, encrypt(t.accessToken, key), encrypt(t.refreshToken, key), t.scopes, t.expiresAt, now],
  );
}

export async function loadChannelToken(db: Queryable, pid: string, key: Buffer): Promise<StoredToken | null> {
  const r = await db.query<{ access_token: Buffer; refresh_token: Buffer; scopes: string[]; expires_at: Date; status: 'ok' | 'invalid' }>(
    'SELECT access_token, refresh_token, scopes, expires_at, status FROM channel_tokens WHERE pid = $1',
    [pid],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    accessToken: decrypt(row.access_token, key),
    refreshToken: decrypt(row.refresh_token, key),
    scopes: row.scopes,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

export async function deleteChannelToken(c: pg.PoolClient, pid: string): Promise<void> {
  await c.query('DELETE FROM channel_tokens WHERE pid = $1', [pid]);
}

/** Refresh fehlgeschlagen oder Scope fehlt: Der Kanal wird im Statusblock rot (10.2). */
export async function markTokenInvalid(db: Queryable, pid: string, now: Date): Promise<void> {
  await db.query("UPDATE channel_tokens SET status = 'invalid', updated_at = $2 WHERE pid = $1", [pid, now]);
}
