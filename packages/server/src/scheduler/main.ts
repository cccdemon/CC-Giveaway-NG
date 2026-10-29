import { Redis } from 'ioredis';
import { ConfigError, loadConfig } from '../config/config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import type { BusLogger } from '../framework/command-bus.js';
import { denyUsers } from '../framework/giveaway/authorize.js';
import { RedisPublisher } from '../framework/publisher.js';
import { accountLegalSource } from '../identity/account/legal-source.js';
import { loadTokenKey } from '../identity/crypto.js';
import { attachAccounts } from '../identity/runtime.js';
import { createRuntime } from '../framework/runtime.js';
import { SchedulerLockError, acquireSchedulerLock } from './lock.js';
import { scheduleLoop } from './loop.js';
import { runMaintenance } from './maintenance.js';
import { TIMER_INTERVAL_MS, runDueTimers } from './timers.js';

const HOUR_MS = 60 * 60 * 1000;

const log: BusLogger = {
  error: (obj, msg) => {
    const { err, ...rest } = obj as { err?: unknown };
    console.error(JSON.stringify({ msg, ...rest, ...(err === undefined ? {} : { err: err instanceof Error ? err.stack : String(err) }) }));
  },
};

/** Genau eine Instanz dieses Prozesses darf laufen (NEW_DESIGN.md 3.1). Der Advisory-Lock setzt das durch. */
async function main() {
  const config = loadConfig(process.env);
  const tokenKey = await loadTokenKey(config.tokenKeyFile);
  const pool = createPool(config.databaseUrl);
  let lock: { release(): Promise<void> };
  try {
    lock = await acquireSchedulerLock(pool);
  } catch (e) {
    if (e instanceof SchedulerLockError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  // Migrationen dürfen länger laufen als das normale Abfragelimit.
  const migratePool = createPool(config.databaseUrl, { queryTimeoutMillis: 0 });
  try {
    await runMigrations(migratePool);
  } finally {
    await migratePool.end();
  }
  const redis = new Redis(config.redisUrl);
  const rt = createRuntime({ pool, publisher: new RedisPublisher(redis), auth: denyUsers, legalSource: accountLegalSource(), log });
  const accounts = attachAccounts(rt, { tokenKey });

  const maintenance = async () => {
    try {
      const r = await runMaintenance(pool, new Date(), { rt, accounts });
      console.log(JSON.stringify({ msg: 'Wartung erledigt', ...r }));
    } catch (e) {
      console.error(JSON.stringify({ msg: 'Wartung fehlgeschlagen. Nächster Versuch in einer Stunde.', err: e instanceof Error ? e.stack : String(e) }));
    }
  };
  const timers = async () => {
    const r = await runDueTimers(pool, rt, new Date(), log);
    if (r.ran + r.rejected + r.failed > 0) console.log(JSON.stringify({ msg: 'Zeitgeber erledigt', ...r }));
  };
  const loops = [scheduleLoop(maintenance, HOUR_MS), scheduleLoop(timers, TIMER_INTERVAL_MS)];

  const shutdown = (signal: string) => {
    console.log(JSON.stringify({ msg: 'Der Prozess fährt herunter.', signal }));
    Promise.all(loops.map((l) => l.stop()))
      .then(() => lock.release())
      .then(() => redis.quit())
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((e: unknown) => {
        console.error(JSON.stringify({ msg: 'Das Herunterfahren ist fehlgeschlagen.', err: String(e) }));
        process.exit(1);
      });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
