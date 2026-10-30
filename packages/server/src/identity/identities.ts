// Tabelle identities: die einzige Stelle mit Twitch-Daten (NEW_DESIGN.md 9.1). Löschen entfernt die Zeile (12.4).
import type pg from 'pg';
import type { Queryable } from '../db/pool.js';

export interface TwitchUser {
  id: string;
  login: string;
  displayName: string;
}

export interface Identity {
  pid: string;
  twitchId: string;
  login: string;
  displayName: string;
  createdAt: Date;
  lastSeenAt: Date;
}

interface Row {
  pid: string;
  twitch_id: string;
  login: string;
  display_name: string;
  created_at: Date;
  last_seen_at: Date;
}

const COLUMNS = 'pid, twitch_id, login, display_name, created_at, last_seen_at';

function toIdentity(r: Row): Identity {
  return { pid: r.pid, twitchId: r.twitch_id, login: r.login, displayName: r.display_name, createdAt: r.created_at, lastSeenAt: r.last_seen_at };
}

/**
 * Legt die Identität mit `candidatePid` an oder aktualisiert die vorhandene Zeile derselben twitch_id.
 * Liefert die wirksame pid: bei vorhandener twitch_id die alte, nie die Kandidatin.
 */
export async function upsertIdentity(c: pg.PoolClient, user: TwitchUser, candidatePid: string, now: Date): Promise<string> {
  const r = await c.query<{ pid: string }>(
    `INSERT INTO identities (pid, twitch_id, login, display_name, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (twitch_id) DO UPDATE SET login = EXCLUDED.login, display_name = EXCLUDED.display_name, last_seen_at = EXCLUDED.last_seen_at
     RETURNING pid`,
    [candidatePid, user.id, user.login, user.displayName, now],
  );
  return r.rows[0]!.pid;
}

export async function findIdentity(db: Queryable, pid: string): Promise<Identity | null> {
  const r = await db.query<Row>(`SELECT ${COLUMNS} FROM identities WHERE pid = $1`, [pid]);
  return r.rows[0] ? toIdentity(r.rows[0]) : null;
}

export async function findPidByTwitchId(db: Queryable, twitchId: string): Promise<string | null> {
  const r = await db.query<{ pid: string }>('SELECT pid FROM identities WHERE twitch_id = $1', [twitchId]);
  return r.rows[0]?.pid ?? null;
}

export async function findPidsByTwitchIds(db: Queryable, twitchIds: string[]): Promise<Map<string, string>> {
  if (twitchIds.length === 0) return new Map();
  const r = await db.query<{ twitch_id: string; pid: string }>('SELECT twitch_id, pid FROM identities WHERE twitch_id = ANY($1)', [twitchIds]);
  return new Map(r.rows.map((row) => [row.twitch_id, row.pid]));
}

export const TOUCH_MIN_MS = 3_600_000;

/** last_seen_at für Anwesende, höchstens einmal je Stunde je Person (Löschfrist, NEW_DESIGN.md 12.4). Liefert die Zahl der Zeilen. */
export async function touchIdentities(db: Queryable, pids: string[], now: Date): Promise<number> {
  if (pids.length === 0) return 0;
  const r = await db.query('UPDATE identities SET last_seen_at = $2 WHERE pid = ANY($1::uuid[]) AND last_seen_at < $3', [
    pids, now, new Date(now.getTime() - TOUCH_MIN_MS),
  ]);
  return r.rowCount ?? 0;
}

export async function deleteIdentity(c: pg.PoolClient, pid: string): Promise<void> {
  await c.query('DELETE FROM identities WHERE pid = $1', [pid]);
}

/** Anzeigename für Verlauf und Listen. Ohne Zuordnung: „gelöschter Teilnehmer #<kurz-id>“ (NEW_DESIGN.md 12.4). */
export function displayNameOf(identity: Identity | null, pid: string): string {
  return identity ? identity.displayName : `gelöschter Teilnehmer #${pid.slice(0, 8)}`;
}
