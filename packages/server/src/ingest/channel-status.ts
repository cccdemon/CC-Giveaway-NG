// Tabelle channel_status: Signalqualität je Kanal (NEW_DESIGN.md 11.2). Betriebsdaten, schreibt der Ingest direkt.
import type { Queryable } from '../db/pool.js';
import type { Pid } from '../kernel-api/index.js';

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

  async flush(db: Queryable, now: Date): Promise<number> {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [pid, patch] of entries) await upsertChannelStatus(db, pid, patch, now);
    return entries.length;
  }
}
