// Tabelle channel_status: Signalqualität je Kanal (NEW_DESIGN.md 11.2). Betriebsdaten, schreibt der Ingest direkt.
import type { Queryable } from '../db/pool.js';
import type { ChannelActivity } from '../framework/giveaway/signals.js';
import type { Pid } from '../kernel-api/index.js';

/** Ein Live-Kanal ohne Signal länger als das gilt als still (NEW_DESIGN.md 11.2). */
export const SIGNAL_STALE_MS = 120_000;

/** Kanäle, die live sind und in den letzten 2 Minuten ein Signal lieferten. Für Chat-Bonus und Boost (NEW_DESIGN.md 6.2, 6.3). */
export function pgChannelActivity(): ChannelActivity {
  return {
    async active(db, channels, now) {
      if (channels.length === 0) return new Set();
      const r = await db.query<{ pid: string }>(
        'SELECT pid FROM channel_status WHERE pid = ANY($1::uuid[]) AND live AND last_signal_at >= $2',
        [channels, new Date(now.getTime() - SIGNAL_STALE_MS)],
      );
      return new Set(r.rows.map((x) => x.pid));
    },
  };
}

export interface ChannelStatusRow {
  pid: Pid;
  live: boolean;
  liveSince: Date | null;
  viewers: number | null;
  chatters: number | null;
  lastSignalAt: Date | null;
  lastPresenceAt: Date | null;
  problem: string | null;
  worker: number | null;
  updatedAt: Date;
}

export type ChannelStatusPatch = Partial<Omit<ChannelStatusRow, 'pid' | 'updatedAt'>>;

const COLUMNS: Record<Exclude<keyof ChannelStatusPatch, 'liveSince'>, string> = {
  live: 'live',
  viewers: 'viewers',
  chatters: 'chatters',
  lastSignalAt: 'last_signal_at',
  lastPresenceAt: 'last_presence_at',
  problem: 'problem',
  worker: 'worker',
};

/** Schreibt nur die Felder des Patches. live: true setzt live_since beim Übergang, live: false löscht es. */
export async function upsertChannelStatus(db: Queryable, pid: Pid, patch: ChannelStatusPatch, now: Date): Promise<void> {
  const cols: string[] = ['pid', 'updated_at'];
  const values: unknown[] = [pid, now];
  const sets: string[] = ['updated_at = EXCLUDED.updated_at'];
  for (const [key, col] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
    if (patch[key] === undefined) continue;
    cols.push(col);
    values.push(patch[key]);
    sets.push(`${col} = EXCLUDED.${col}`);
  }
  if (patch.live !== undefined) {
    cols.push('live_since');
    values.push(patch.live ? (patch.liveSince ?? now) : null);
    sets.push(patch.live ? 'live_since = CASE WHEN channel_status.live THEN channel_status.live_since ELSE EXCLUDED.live_since END' : 'live_since = NULL');
  }
  const params = values.map((_, i) => `$${i + 1}`);
  await db.query(`INSERT INTO channel_status (${cols.join(', ')}) VALUES (${params.join(', ')}) ON CONFLICT (pid) DO UPDATE SET ${sets.join(', ')}`, values);
}

const COLUMN_TYPES: Record<string, string> = {
  pid: 'uuid', updated_at: 'timestamptz', live: 'bool', viewers: 'int', chatters: 'int', last_signal_at: 'timestamptz',
  last_presence_at: 'timestamptz', problem: 'text', worker: 'int', live_since: 'timestamptz',
};

/** Mehrere Kanäle mit derselben Spaltenmenge in einem Statement (unnest). Gleiche Regeln wie upsertChannelStatus. */
export async function upsertChannelStatusMany(db: Queryable, entries: { pid: Pid; patch: ChannelStatusPatch }[], now: Date): Promise<void> {
  if (entries.length === 0) return;
  if (entries.length === 1) return upsertChannelStatus(db, entries[0]!.pid, entries[0]!.patch, now);
  const first = entries[0]!.patch;
  const cols: string[] = ['pid', 'updated_at'];
  const columns: unknown[][] = [entries.map((e) => e.pid), entries.map(() => now)];
  const sets: string[] = ['updated_at = EXCLUDED.updated_at'];
  for (const [key, col] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
    if (first[key] === undefined) continue;
    cols.push(col);
    columns.push(entries.map((e) => e.patch[key] ?? null));
    sets.push(`${col} = EXCLUDED.${col}`);
  }
  if (first.live !== undefined) {
    cols.push('live_since');
    columns.push(entries.map((e) => (e.patch.live ? (e.patch.liveSince ?? now) : null)));
    sets.push('live_since = CASE WHEN EXCLUDED.live THEN (CASE WHEN channel_status.live THEN channel_status.live_since ELSE EXCLUDED.live_since END) ELSE NULL END');
  }
  const params = cols.map((c, i) => `$${i + 1}::${COLUMN_TYPES[c]}[]`);
  await db.query(`INSERT INTO channel_status (${cols.join(', ')}) SELECT * FROM unnest(${params.join(', ')}) ON CONFLICT (pid) DO UPDATE SET ${sets.join(', ')}`, columns);
}

interface Row {
  pid: string;
  live: boolean;
  live_since: Date | null;
  viewers: number | null;
  chatters: number | null;
  last_signal_at: Date | null;
  last_presence_at: Date | null;
  problem: string | null;
  worker: number | null;
  updated_at: Date;
}

export async function readChannelStatus(db: Queryable, pids: Pid[]): Promise<Map<Pid, ChannelStatusRow>> {
  if (pids.length === 0) return new Map();
  const r = await db.query<Row>('SELECT * FROM channel_status WHERE pid = ANY($1::uuid[])', [pids]);
  return new Map(
    r.rows.map((x) => [
      x.pid,
      {
        pid: x.pid, live: x.live, liveSince: x.live_since, viewers: x.viewers, chatters: x.chatters, lastSignalAt: x.last_signal_at,
        lastPresenceAt: x.last_presence_at, problem: x.problem, worker: x.worker, updatedAt: x.updated_at,
      },
    ]),
  );
}

export async function deleteChannelStatus(db: Queryable, pid: Pid): Promise<void> {
  await db.query('DELETE FROM channel_status WHERE pid = $1', [pid]);
}

/** Sammelt Patches zwischen zwei Ticks, damit nicht jede Chatnachricht eine Schreibabfrage wird. */
export class StatusBuffer {
  private readonly pending = new Map<Pid, ChannelStatusPatch>();

  note(pid: Pid, patch: ChannelStatusPatch): void {
    this.pending.set(pid, { ...this.pending.get(pid), ...patch });
  }

  /** Ein Statement je Spaltensignatur (Lasttest: sonst ein Upsert je Kanal und Takt). */
  async flush(db: Queryable, now: Date): Promise<number> {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    const groups = new Map<string, { pid: Pid; patch: ChannelStatusPatch }[]>();
    for (const [pid, patch] of entries) {
      const key = Object.keys(patch).filter((k) => patch[k as keyof ChannelStatusPatch] !== undefined).sort().join(',');
      groups.set(key, [...(groups.get(key) ?? []), { pid, patch }]);
    }
    for (const group of groups.values()) await upsertChannelStatusMany(db, group, now);
    return entries.length;
  }
}
