// Kanalverzeichnis des Ingest: welche Kanäle beobachtet werden und welcher Worker sie pollt (NEW_DESIGN.md 10.2).
// Liest nur Lesetabellen. Schreiben geht ausschließlich über Befehle.
import type pg from 'pg';
import type { BusLogger } from '../framework/command-bus.js';
import type { Pid } from '../kernel-api/index.js';
import { shardOf } from './shard.js';
import type { ChannelRef, IngestAdapter } from './signals.js';

export interface ChannelSource {
  list(): Promise<{ pid: Pid; twitchId: string; watch: 'state' | 'full' }[]>;
}

export const DIRECTORY_INTERVAL_MS = 30_000;

/** Verbundene Kanäle mit gültigem Token, ohne gesperrte Streamer (11.4). full = in mindestens einem offenen Giveaway (Pausiert sammelt nichts, 7.1). */
export function pgChannelSource(pool: pg.Pool): ChannelSource {
  return {
    async list() {
      const r = await pool.query<{ pid: string; twitch_id: string; full: boolean }>(
        `SELECT a.pid, i.twitch_id,
                EXISTS (SELECT 1 FROM giveaways g WHERE g.status = 'open' AND g.channels @> to_jsonb(ARRAY[a.pid::text])) AS full
           FROM accounts a
           JOIN identities i ON i.pid = a.pid
           JOIN channel_tokens t ON t.pid = a.pid
          WHERE a.channel_connected AND NOT a.deleted AND t.status = 'ok'
            AND NOT EXISTS (SELECT 1 FROM platform_bans b WHERE b.pid = a.pid)
          ORDER BY a.pid`,
      );
      return r.rows.map((x) => ({ pid: x.pid, twitchId: x.twitch_id, watch: x.full ? 'full' : 'state' }));
    },
  };
}

export class Directory {
  private refs = new Map<Pid, ChannelRef>();

  constructor(private readonly o: { source: ChannelSource; adapter: IngestAdapter; workers: number; index: number; log: BusLogger }) {}

  /** Holt die Liste, startet neue oder geänderte Refs, stoppt weggefallene. Wirft die Quelle, bleibt der alte Stand. */
  async refresh(): Promise<{ started: number; stopped: number }> {
    let list: Awaited<ReturnType<ChannelSource['list']>>;
    try {
      list = await this.o.source.list();
    } catch (err) {
      this.o.log.error({ err }, 'Das Kanalverzeichnis ließ sich nicht lesen. Der alte Stand bleibt.');
      return { started: 0, stopped: 0 };
    }
    const next = new Map<Pid, ChannelRef>(
      list.map((x) => [x.pid, { pid: x.pid, twitchId: x.twitchId, watch: x.watch, owned: shardOf(x.pid, this.o.workers) === this.o.index }]),
    );
    const toStart = [...next.values()].filter((r) => {
      const c = this.refs.get(r.pid);
      return !c || c.twitchId !== r.twitchId || c.watch !== r.watch || c.owned !== r.owned;
    });
    const toStop = [...this.refs.values()].filter((r) => !next.has(r.pid));
    if (toStart.length > 0) await this.o.adapter.start(toStart);
    for (const r of toStop) await this.o.adapter.stop(r);
    this.refs = next;
    return { started: toStart.length, stopped: toStop.length };
  }

  byTwitchId(id: string): ChannelRef | undefined {
    for (const r of this.refs.values()) if (r.twitchId === id) return r;
    return undefined;
  }

  current(): ChannelRef[] {
    return [...this.refs.values()];
  }
}
