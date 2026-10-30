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
/** „Letztes Signal“ wird je Kanal höchstens alle 5 s geschrieben. Sonst wird jede Chatnachricht ein UPDATE. */
export const SIGNAL_NOTE_MIN_MS = 5_000;

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

/**
 * Startet `fn` höchstens einmal zugleich und wartet nie darauf. Ein laufender Aufruf wird nicht erneut gestartet.
 * Für Arbeit, die den Takt des Workers nie blockieren darf (Anwesenheits-Polling gegen Twitch).
 */
export function nonBlocking(fn: (now: Date) => Promise<void>, log: BusLogger, label: string): (now: Date) => Promise<void> {
  let running: Promise<void> | null = null;
  return async (now) => {
    if (running !== null) return;
    running = fn(now)
      .catch((err: unknown) => log.error({ err, label }, 'Eine Hintergrundaufgabe des Ingest ist fehlgeschlagen. Der nächste Takt versucht es erneut.'))
      .finally(() => {
        running = null;
      });
  };
}

export function createIngestWorker(o: IngestWorkerOptions): IngestWorker {
  const now = o.now ?? (() => new Date());
  const status = new StatusBuffer();
  const directory = new Directory({ source: o.source, adapter: o.adapter, workers: o.workers, index: o.index, log: o.log });
  const dispatch = dispatcher({ rt: o.rt, lookup: o.lookup, log: o.log, now });
  const bundler = new Bundler({ flush: async (b) => void (await dispatch.handle(b)), log: o.log });
  const loops: { stop(): Promise<void> }[] = [];
  /** Zuletzt notierter Stand je Kanal, damit unveränderte Werte keine Schreibabfrage auslösen. */
  const noted = new Map<string, { problem: string | null | undefined; signalMs: number }>();
  const lastOf = (pid: string) => noted.get(pid) ?? { problem: undefined, signalMs: -Infinity };

  const handle = (s: Signal): void => {
    const t = now();
    const last = lastOf(s.channel);
    if (s.kind === 'stream_state') {
      status.note(s.channel, { live: s.live, ...(s.viewers === undefined ? {} : { viewers: s.viewers }), lastSignalAt: t, worker: o.index });
      noted.set(s.channel, { ...last, signalMs: t.getTime() });
      return;
    }
    bundler.add(s);
    if (s.kind === 'presence') {
      status.note(s.channel, { lastSignalAt: t, lastPresenceAt: t, chatters: s.users.length });
      noted.set(s.channel, { ...last, signalMs: t.getTime() });
    } else if (t.getTime() - last.signalMs >= SIGNAL_NOTE_MIN_MS) {
      status.note(s.channel, { lastSignalAt: t });
      noted.set(s.channel, { ...last, signalMs: t.getTime() });
    }
  };
  o.adapter.onSignal(handle);

  const tick = async (at: Date): Promise<void> => {
    await o.onTick?.(at);
    await bundler.tick(at);
    for (const h of o.adapter.health()) {
      const problem = h.ok ? null : h.problem;
      const last = lastOf(h.channel);
      if (last.problem === problem) continue;
      status.note(h.channel, { problem });
      noted.set(h.channel, { ...last, problem });
    }
    await status.flush(o.pool, at);
  };

  const refresh = async (): Promise<void> => {
    await directory.refresh();
  };

  const onLoopError = (e: unknown) => o.log.error({ err: e }, 'Ein geplanter Lauf des Ingest ist fehlgeschlagen. Der nächste Lauf folgt wie geplant.');

  return {
    async start() {
      await refresh();
      loops.push(
        scheduleLoop(refresh, o.directoryIntervalMs ?? DIRECTORY_INTERVAL_MS, onLoopError),
        scheduleLoop(() => tick(now()), o.tickMs ?? TICK_MS, onLoopError),
      );
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
