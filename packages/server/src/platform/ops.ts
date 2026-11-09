// Betriebsdaten der Verwaltung (NEW_DESIGN.md 11.4, 12.4): Browser-Fehler ohne Personenbezug, Rückmeldungen, Betriebsansicht, Streamer-Suche.
// Keine Nachweise, darum Tabellen statt Journal (wie channel_status).
import type { Queryable } from '../db/pool.js';
import { displayNamesOf, displayNameOf } from '../identity/identities.js';
import { channelStatusView, type ChannelStatusView } from '../ingest/status-view.js';
import { reject, type Rejection } from '../shared/rejection.js';

export const BROWSER_ERROR_RETENTION_DAYS = 30;
export const BROWSER_ERROR_LIMITS = { message: 500, stack: 4000, url: 500, userAgent: 300 } as const;
export const FEEDBACK_MAX = 2000;
export const DENIED_WINDOW_HOURS = 24;

const cut = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : null);

export interface BrowserErrorInput {
  message: string;
  stack?: string;
  url?: string;
  userAgent?: string;
}

/** Speichert einen Browser-Fehler. Kein pid, keine IP, kein Cookie: nur Text, Ort und Browser. */
export async function recordBrowserError(db: Queryable, e: BrowserErrorInput, at: Date): Promise<void> {
  await db.query('INSERT INTO browser_errors (at, message, stack, url, user_agent) VALUES ($1, $2, $3, $4, $5)', [
    at,
    cut(e.message, BROWSER_ERROR_LIMITS.message) ?? '',
    cut(e.stack, BROWSER_ERROR_LIMITS.stack),
    cut(e.url, BROWSER_ERROR_LIMITS.url),
    cut(e.userAgent, BROWSER_ERROR_LIMITS.userAgent),
  ]);
}

export async function listBrowserErrors(db: Queryable, limit = 50): Promise<{ at: string; message: string; url: string | null }[]> {
  const r = await db.query<{ at: Date; message: string; url: string | null }>('SELECT at, message, url FROM browser_errors ORDER BY at DESC, id DESC LIMIT $1', [limit]);
  return r.rows.map((x) => ({ at: x.at.toISOString(), message: x.message, url: x.url }));
}

export async function purgeBrowserErrors(db: Queryable, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - BROWSER_ERROR_RETENTION_DAYS * 86_400_000);
  const r = await db.query('DELETE FROM browser_errors WHERE at < $1', [cutoff]);
  return r.rowCount ?? 0;
}

export const INVALID_FEEDBACK = (): Rejection => reject('invalid_feedback', `Schreib einen Text mit 1 bis ${FEEDBACK_MAX} Zeichen.`);

export async function addFeedback(db: Queryable, pid: string, text: unknown, at: Date): Promise<{ id: number } | Rejection> {
  if (typeof text !== 'string' || text.trim() === '' || text.length > FEEDBACK_MAX) return INVALID_FEEDBACK();
  const r = await db.query<{ id: string }>('INSERT INTO feedback (pid, text, at) VALUES ($1, $2, $3) RETURNING id', [pid, text.trim(), at]);
  return { id: Number(r.rows[0]!.id) };
}

export interface FeedbackRow {
  id: number;
  pid: string;
  displayName: string;
  text: string;
  at: string;
  done: boolean;
}

export async function listFeedback(db: Queryable, o: { done?: boolean; limit?: number } = {}): Promise<FeedbackRow[]> {
  const r = await db.query<{ id: string; pid: string; text: string; at: Date; done: boolean }>(
    'SELECT id, pid, text, at, done FROM feedback WHERE ($1::boolean IS NULL OR done = $1) ORDER BY at DESC, id DESC LIMIT $2',
    [o.done ?? null, Math.min(200, Math.max(1, o.limit ?? 100))],
  );
  const names = await displayNamesOf(db, r.rows.map((x) => x.pid));
  return r.rows.map((x) => ({ id: Number(x.id), pid: x.pid, displayName: names.get(x.pid) ?? displayNameOf(null, x.pid), text: x.text, at: x.at.toISOString(), done: x.done }));
}

export async function setFeedbackDone(db: Queryable, id: number, done: boolean): Promise<boolean> {
  const r = await db.query('UPDATE feedback SET done = $2 WHERE id = $1', [id, done]);
  return (r.rowCount ?? 0) > 0;
}

export interface OpsView {
  db: 'ok';
  workers: { worker: number; channels: number; lastUpdate: string }[];
  channels: (ChannelStatusView & { displayName: string })[];
  giveaways: Record<'draft' | 'open' | 'paused' | 'closed' | 'drawn' | 'completed' | 'cancelled', number>;
  denied: { action: string; reason: string; count: number; lastAt: string }[];
  browserErrors: { at: string; message: string; url: string | null }[];
}

/** Betrieb (11.4): Health, Ingest je Kanal, abgelehnte Befehle der letzten 24 h, Browser-Fehler. */
export async function opsView(db: Queryable, now: Date): Promise<OpsView> {
  const [workers, accounts, counts, denied, browserErrors] = await Promise.all([
    db.query<{ worker: number; channels: string; last_update: Date }>(
      'SELECT worker, count(*) AS channels, max(updated_at) AS last_update FROM channel_status WHERE worker IS NOT NULL GROUP BY worker ORDER BY worker',
    ),
    db.query<{ pid: string }>('SELECT pid FROM accounts WHERE channel_connected AND NOT deleted ORDER BY pid'),
    db.query<{ status: keyof OpsView['giveaways']; n: string }>('SELECT status, count(*) AS n FROM giveaways GROUP BY status'),
    db.query<{ action: string; reason: string; count: string; last_at: Date }>(
      `SELECT action, reason, sum(count) AS count, max(last_at) AS last_at FROM access_log
        WHERE kind = 'denied' AND last_at > $1 GROUP BY action, reason ORDER BY sum(count) DESC, max(last_at) DESC LIMIT 50`,
      [new Date(now.getTime() - DENIED_WINDOW_HOURS * 3_600_000)],
    ),
    listBrowserErrors(db),
  ]);
  const pids = accounts.rows.map((a) => a.pid);
  const [statuses, names] = await Promise.all([channelStatusView(db, pids, now), displayNamesOf(db, pids)]);
  const giveaways: OpsView['giveaways'] = { draft: 0, open: 0, paused: 0, closed: 0, drawn: 0, completed: 0, cancelled: 0 };
  for (const c of counts.rows) if (c.status in giveaways) giveaways[c.status] = Number(c.n);
  return {
    db: 'ok',
    workers: workers.rows.map((w) => ({ worker: w.worker, channels: Number(w.channels), lastUpdate: w.last_update.toISOString() })),
    channels: statuses.map((v) => ({ ...v, displayName: names.get(v.pid) ?? displayNameOf(null, v.pid) })),
    giveaways,
    denied: denied.rows.map((d) => ({ action: d.action, reason: d.reason, count: Number(d.count), lastAt: d.last_at.toISOString() })),
    browserErrors,
  };
}

export interface AdminStreamer {
  pid: string;
  login: string;
  displayName: string;
  channelConnected: boolean;
  termsVersion: number;
  banned: { reason: string; since: string } | null;
  warnings: { eventId: string; reason: string; at: string }[];
}

/** Streamer-Suche (Festlegung 8): Login oder Anzeigename, höchstens 50, ohne q die zuletzt gesehenen. */
export async function searchStreamers(db: Queryable, q: string, limit = 50): Promise<AdminStreamer[]> {
  const pattern = q.trim() === '' ? null : `%${q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const r = await db.query<{ pid: string; login: string; display_name: string; channel_connected: boolean; terms_version: number; ban_reason: string | null; ban_since: Date | null }>(
    `SELECT i.pid, i.login, i.display_name, a.channel_connected, a.terms_version, b.reason AS ban_reason, b.since AS ban_since
       FROM identities i JOIN accounts a ON a.pid = i.pid LEFT JOIN platform_bans b ON b.pid = i.pid
      WHERE NOT a.deleted AND ($1::text IS NULL OR i.login ILIKE $1 OR i.display_name ILIKE $1)
      ORDER BY i.last_seen_at DESC, i.login LIMIT $2`,
    [pattern, Math.min(50, Math.max(1, limit))],
  );
  const pids = r.rows.map((x) => x.pid);
  const warnings = pids.length
    ? await db.query<{ pid: string; event_id: string; reason: string; at: Date }>('SELECT pid, event_id, reason, at FROM platform_warnings WHERE pid = ANY($1::uuid[]) AND NOT withdrawn ORDER BY at', [pids])
    : { rows: [] as { pid: string; event_id: string; reason: string; at: Date }[] };
  return r.rows.map((x) => ({
    pid: x.pid,
    login: x.login,
    displayName: x.display_name,
    channelConnected: x.channel_connected,
    termsVersion: x.terms_version,
    banned: x.ban_reason !== null && x.ban_since !== null ? { reason: x.ban_reason, since: x.ban_since.toISOString() } : null,
    warnings: warnings.rows.filter((w) => w.pid === x.pid).map((w) => ({ eventId: w.event_id, reason: w.reason, at: w.at.toISOString() })),
  }));
}
