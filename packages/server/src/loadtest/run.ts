// Lasttest (NEW_DESIGN.md 12.2, Erfolgskriterium 7): Simulator → Bündler → Dispatcher → apply_signals über den Bus, gegen eine
// eigene Datenbank, mit vorgerückter Uhr. Misst jede bus.execute-Dauer je Befehlstyp. Kein zweiter Schreibweg, kein Netz.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type pg from 'pg';
import type { BusLogger, CommandBus } from '../framework/command-bus.js';
import { allowAll } from '../framework/giveaway/authorize.js';
import { allActive } from '../framework/giveaway/signals.js';
import type { LegalTexts } from '../framework/legal.js';
import { InMemoryPublisher } from '../framework/publisher.js';
import { createRuntime } from '../framework/runtime.js';
import { identityResolver } from '../identity/resolver.js';
import { pgGiveawayLookup } from '../ingest/dispatch.js';
import { SimulatorAdapter } from '../ingest/simulator.js';
import { createIngestWorker } from '../ingest/worker.js';
import { summarize, type Summary } from './stats.js';

export interface LoadOptions {
  pool: pg.Pool;
  channels: number;
  viewers: number;
  minutes: number;
  seed?: number;
  log?: BusLogger;
  /** Nach jeder simulierten Minute: Nummer (ab 1), Befehle und Wanduhrzeit dieser Minute. */
  onMinute?: (minute: number, info: { commands: number; ms: number }) => void;
}

export interface LoadResult {
  config: { channels: number; viewers: number; minutes: number; seed: number };
  wallMs: number;
  commands: Record<string, Summary>;
  events: number;
  rejected: number;
  failed: number;
  perMinute: { minute: number; commands: number; ms: number }[];
  target: { p95Ms: number; ok: boolean };
}

/** Ziel aus NEW_DESIGN.md 12.2: unter 100 ms je Befehl im p95. */
export const P95_TARGET_MS = 100;
/** Feste Startzeit, damit Partitionen und Ergebnisse vergleichbar sind. */
export const LOAD_START = new Date('2026-10-15T12:00:00.000Z');
const MEASURED = 'apply_signals';
const LEGAL: LegalTexts = { impressumUrl: 'https://last.example/impressum', terms: { text: 'Testregeln.' }, privacyUrl: 'https://last.example/datenschutz' };

const silent: BusLogger = { error: (obj, msg) => console.error(JSON.stringify({ msg, ...obj })) };

export async function runLoadTest(o: LoadOptions): Promise<LoadResult> {
  const seed = o.seed ?? 1;
  const log = o.log ?? silent;
  const durations = new Map<string, number[]>();
  let rejected = 0;
  let failed = 0;
  let clock = LOAD_START;
  const now = () => clock;

  const rt = createRuntime({
    pool: o.pool, publisher: new InMemoryPublisher(), auth: allowAll, log, legalSource: { profileOf: async () => LEGAL },
    fetcher: async (url) => ({ ok: true, hash: `h:${url}` }), identities: identityResolver(), activity: allActive,
  });
  // Jede Ausführung messen, auch die des Dispatchers. Der Bus bleibt der einzige Schreibweg.
  const bus = rt.bus as { execute: CommandBus['execute'] };
  const original = bus.execute.bind(rt.bus);
  bus.execute = (async (handler, cmd, ctx) => {
    const t = performance.now();
    try {
      const r = await original(handler, cmd, ctx);
      if (!r.ok) rejected += 1;
      return r;
    } catch (e) {
      failed += 1;
      throw e;
    } finally {
      const list = durations.get(handler.type) ?? [];
      list.push(performance.now() - t);
      durations.set(handler.type, list);
    }
  }) as CommandBus['execute'];

  const startedAt = performance.now();
  const channels: string[] = [];
  for (let i = 0; i < o.channels; i += 1) {
    const pid = randomUUID();
    const giveawayId = randomUUID();
    const teamId = randomUUID();
    const ctx = { actor: `user:${pid}`, correlationId: randomUUID(), now: now() };
    const created = await rt.bus.execute(
      rt.handlers.create,
      { giveawayId, teamId, kernelId: 'watchtime', settings: { prize: `Lasttest ${i + 1}`, channels: [pid], counting: 'first_seen', keyword: '!los', legal: LEGAL } },
      ctx,
    );
    if (!created.ok) throw new Error(`create_giveaway abgelehnt: ${created.rejection.code}`);
    const opened = await rt.bus.execute(rt.handlers.open, { giveawayId }, { ...ctx, correlationId: randomUUID() });
    if (!opened.ok) throw new Error(`open_giveaway abgelehnt: ${opened.rejection.code}`);
    channels.push(pid);
  }

  const sim = new SimulatorAdapter({ viewersPerChannel: o.viewers, seed, now });
  const worker = createIngestWorker({
    adapter: sim,
    source: { list: async () => channels.map((pid, i) => ({ pid, twitchId: `sim-ch-${i + 1}`, watch: 'full' as const })) },
    lookup: pgGiveawayLookup(o.pool),
    rt,
    pool: o.pool,
    workers: 1,
    index: 0,
    log,
    now,
    onTick: (at) => sim.tick(at),
  });
  await worker.refresh();

  const perMinute: LoadResult['perMinute'] = [];
  const commandsSoFar = () => [...durations.values()].reduce((s, l) => s + l.length, 0);
  const minuteOf = async (minute: number, seconds: number) => {
    const before = commandsSoFar();
    const t = performance.now();
    for (let s = 0; s < seconds; s += 1) {
      clock = new Date(LOAD_START.getTime() + ((minute - 1) * 60 + s) * 1000);
      await worker.tick(clock);
    }
    const info = { commands: commandsSoFar() - before, ms: performance.now() - t };
    perMinute.push({ minute, ...info });
    o.onMinute?.(minute, info);
  };
  for (let m = 1; m <= o.minutes; m += 1) await minuteOf(m, 60);
  // Die letzte Minute würde erst nach Minutenende plus Karenz gebündelt: stop() drainiert sie, ohne neue Signale zu erzeugen.
  await worker.stop();

  const events = Number((await o.pool.query('SELECT count(*)::int AS n FROM events')).rows[0]!.n);
  const commands: Record<string, Summary> = {};
  for (const [type, list] of durations) commands[type] = summarize(list);
  const p95 = commands[MEASURED]?.p95 ?? 0;
  return {
    config: { channels: o.channels, viewers: o.viewers, minutes: o.minutes, seed },
    wallMs: performance.now() - startedAt,
    commands,
    events,
    rejected,
    failed,
    perMinute,
    target: { p95Ms: P95_TARGET_MS, ok: p95 < P95_TARGET_MS },
  };
}
