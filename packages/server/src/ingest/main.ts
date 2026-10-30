// Prozess ingest (NEW_DESIGN.md 3.1): holt Signale von Twitch oder vom Simulator und sendet Befehle an den Rahmen.
import { Redis } from 'ioredis';
import { ConfigError, loadConfig } from '../config/config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import type { BusLogger } from '../framework/command-bus.js';
import { denyUsers } from '../framework/giveaway/authorize.js';
import { RedisPublisher } from '../framework/publisher.js';
import { createRuntime } from '../framework/runtime.js';
import { accountLegalSource } from '../identity/account/legal-source.js';
import { loadTokenKey } from '../identity/crypto.js';
import { identityResolver } from '../identity/resolver.js';
import { buildIngest } from './build.js';

const log: BusLogger = {
  error: (obj, msg) => {
    const { err, ...rest } = obj as { err?: unknown };
    console.error(JSON.stringify({ msg, ...rest, ...(err === undefined ? {} : { err: err instanceof Error ? err.stack : String(err) }) }));
  },
};

async function main() {
  const config = loadConfig(process.env);
  const tokenKey = await loadTokenKey(config.tokenKeyFile);
  // Migrationen dürfen länger laufen als das normale Abfragelimit.
  const migratePool = createPool(config.databaseUrl, { queryTimeoutMillis: 0 });
  try {
    await runMigrations(migratePool);
  } finally {
    await migratePool.end();
  }
  const pool = createPool(config.databaseUrl);
  const redis = new Redis(config.redisUrl);
  const rt = createRuntime({ pool, publisher: new RedisPublisher(redis), auth: denyUsers, legalSource: accountLegalSource(), identities: identityResolver(), log });
  const { worker } = buildIngest(config, { pool, rt, tokenKey, log });
  await worker.start();
  console.log(JSON.stringify({ msg: 'Ingest läuft.', adapter: config.ingestAdapter, worker: config.ingestWorkerIndex, workers: config.ingestWorkers }));

  const shutdown = (signal: string) => {
    console.log(JSON.stringify({ msg: 'Der Prozess fährt herunter.', signal }));
    worker
      .stop()
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
