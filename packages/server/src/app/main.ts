import { Redis } from 'ioredis';
import { ConfigError, loadConfig } from '../config/config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { denyUsers } from '../framework/giveaway/authorize.js';
import { reconcileKernelVersions } from '../framework/giveaway/projectors.js';
import { RedisPublisher } from '../framework/publisher.js';
import { createRuntime } from '../framework/runtime.js';
import { ensurePartitions } from '../journal/partitions.js';
import { buildApp } from './build-app.js';

async function main() {
  const config = loadConfig(process.env);
  // Migrationen dürfen länger laufen als das normale Abfragelimit.
  const migratePool = createPool(config.databaseUrl, { queryTimeoutMillis: 0 });
  try {
    await runMigrations(migratePool);
  } finally {
    await migratePool.end();
  }
  const pool = createPool(config.databaseUrl);
  await ensurePartitions(pool, new Date(), 2);
  const app = buildApp({ pool }, { logger: { level: config.logLevel } });
  const redis = new Redis(config.redisUrl);
  app.addHook('onClose', async () => {
    await redis.quit();
  });
  const rt = createRuntime({ pool, publisher: new RedisPublisher(redis), auth: denyUsers, log: app.log });
  const { rebuilt, skipped } = await reconcileKernelVersions(pool, rt);
  app.log.info({ rebuilt, skipped }, 'Kern-Versionsabgleich erledigt.');
  await app.listen({ host: '0.0.0.0', port: config.port });

  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'Der Prozess fährt herunter.');
    app
      .close()
      .then(() => process.exit(0))
      .catch((e: unknown) => {
        app.log.error({ err: e }, 'Das Herunterfahren ist fehlgeschlagen.');
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
