// Baut Adapter und Worker des Ingest aus der Konfiguration. Ohne Nebenwirkungen, damit Tests es importieren können.
import type pg from 'pg';
import { ConfigError, type Config } from '../config/config.js';
import type { BusLogger } from '../framework/command-bus.js';
import type { Runtime } from '../framework/runtime.js';
import type { Subscriber } from '../framework/subscriber.js';
import { twitchAuthClient } from '../identity/twitch.js';
import { minuteOf } from './bundler.js';
import { pgChannelSource } from './directory.js';
import { pgGiveawayLookup } from './dispatch.js';
import type { IngestAdapter } from './signals.js';
import { SimulatorAdapter } from './simulator.js';
import { twitchAdapter } from './twitch/adapter.js';
import { EventSubSocket } from './twitch/eventsub.js';
import { appTokenSource, helixClient } from './twitch/helix.js';
import { channelTokenProvider } from './twitch/tokens.js';
import { createIngestWorker, nonBlocking, type IngestWorker } from './worker.js';

export interface IngestDeps {
  pool: pg.Pool;
  rt: Runtime;
  tokenKey: Buffer;
  log: BusLogger;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Live-Push für Chat-Ansagen; ohne Abonnent sendet der Ingest keine Ansagen. */
  subscriber?: Subscriber;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function buildIngest(config: Config, deps: IngestDeps): { worker: IngestWorker; adapter: IngestAdapter } {
  const now = deps.now ?? (() => new Date());
  const common = {
    source: pgChannelSource(deps.pool), lookup: pgGiveawayLookup(deps.pool), rt: deps.rt, pool: deps.pool,
    workers: config.ingestWorkers, index: config.ingestWorkerIndex, log: deps.log, now,
    ...(deps.subscriber ? { subscriber: deps.subscriber } : {}), publicUrl: config.publicUrl,
  };
  if (config.ingestAdapter === 'simulator') {
    const sim = new SimulatorAdapter({ viewersPerChannel: config.ingestSimViewers, seed: config.ingestSimSeed, now });
    return { adapter: sim, worker: createIngestWorker({ ...common, adapter: sim, onTick: (at) => sim.tick(at) }) };
  }
  if (!config.twitchBotUserId) throw new ConfigError(['TWITCH_BOT_USER_ID: Pflichtwert fehlt, wenn INGEST_ADAPTER=twitch.']);
  const doFetch = deps.fetch ?? fetch;
  const appToken = appTokenSource({ clientId: config.twitchClientId, clientSecret: config.twitchClientSecret, fetch: doFetch, now });
  const helix = helixClient({ clientId: config.twitchClientId, appToken, fetch: doFetch, sleep, now });
  const auth = twitchAuthClient({ clientId: config.twitchClientId, clientSecret: config.twitchClientSecret, fetch: doFetch });
  const tokens = channelTokenProvider({ pool: deps.pool, key: deps.tokenKey, auth, now, log: deps.log });
  const adapter = twitchAdapter({
    helix, tokens, botUserId: config.twitchBotUserId, workers: config.ingestWorkers, index: config.ingestWorkerIndex, sleep, now, log: deps.log,
    socket: (h) => new EventSubSocket({ ...h, log: deps.log }),
  });
  // Anwesenheit einmal je Minute: beim ersten Tick einer neuen Minute, robust gegen Takt-Drift. Läuft im Hintergrund,
  // damit ein hängender Twitch-Aufruf nie den Takt (Bündel, channel_status) blockiert.
  let lastMinute: string | null = null;
  const poll = nonBlocking((at) => adapter.pollPresence(at), deps.log, 'pollPresence');
  const onTick = async (at: Date) => {
    const minute = minuteOf(at);
    if (minute === lastMinute) return;
    lastMinute = minute;
    await poll(at);
  };
  return { adapter, worker: createIngestWorker({ ...common, adapter, onTick }) };
}
