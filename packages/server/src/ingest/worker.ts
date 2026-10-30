// Komposition des Ingest-Workers: Adapter → Bündler → Dispatcher → Befehle, dazu channel_status (NEW_DESIGN.md 3.1, 11.2).
import type pg from 'pg';
import type { BusLogger } from '../framework/command-bus.js';
import type { Runtime } from '../framework/runtime.js';
import { scheduleLoop } from '../scheduler/loop.js';
import { Bundler } from './bundler.js';
import { StatusBuffer } from './channel-status.js';
import { DIRECTORY_INTERVAL_MS, Directory, type ChannelSource } from './directory.js';
import { dispatcher, type GiveawayLookup } from './dispatch.js';
import type { IngestAdapter, Signal } from './signals.js';

export const TICK_MS = 1_000;

export interface IngestWorkerOptions {
  adapter: IngestAdapter;
  source: ChannelSource;
  lookup: GiveawayLookup;
  rt: Runtime;
  pool: pg.Pool;
  workers: number;
  index: number;
  log: BusLogger;
  now?: () => Date;
  directoryIntervalMs?: number;
  tickMs?: number;
  /** Takt des Adapters: Simulator-Tick oder Anwesenheits-Polling bei voller Minute. Läuft vor dem Bündler. */
  onTick?: (now: Date) => void | Promise<void>;
}

export interface IngestWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(now: Date): Promise<void>;
  refresh(): Promise<void>;
}

export function createIngestWorker(o: IngestWorkerOptions): IngestWorker {
  const now = o.now ?? (() => new Date());
  const status = new StatusBuffer();
  const directory = new Directory({ source: o.source, adapter: o.adapter, workers: o.workers, index: o.index, log: o.log });
  const dispatch = dispatcher({ rt: o.rt, lookup: o.lookup, log: o.log, now });
  const bundler = new Bundler({ flush: async (b) => void (await dispatch.handle(b)), log: o.log });
  const loops: { stop(): Promise<void> }[] = [];

  const handle = (s: Signal): void => {
    const t = now();
    if (s.kind === 'stream_state') {
      status.note(s.channel, { live: s.live, ...(s.viewers === undefined ? {} : { viewers: s.viewers }), lastSignalAt: t, worker: o.index });
    } else {
      bundler.add(s);
      status.note(s.channel, { lastSignalAt: t, ...(s.kind === 'presence' ? { lastPresenceAt: t, chatters: s.users.length } : {}) });
    }
  };
  o.adapter.onSignal(handle);

  const tick = async (at: Date): Promise<void> => {
    await o.onTick?.(at);
    await bundler.tick(at);
    for (const h of o.adapter.health()) status.note(h.channel, { problem: h.ok ? null : h.problem });
    await status.flush(o.pool, at);
  };

  const refresh = async (): Promise<void> => {
    await directory.refresh();
  };

  return {
    async start() {
      await refresh();
      loops.push(scheduleLoop(refresh, o.directoryIntervalMs ?? DIRECTORY_INTERVAL_MS), scheduleLoop(() => tick(now()), o.tickMs ?? TICK_MS));
    },
    async stop() {
      await Promise.all(loops.splice(0).map((l) => l.stop()));
      await bundler.drain();
      await status.flush(o.pool, now());
      await o.adapter.close();
    },
    tick,
    refresh,
  };
}
