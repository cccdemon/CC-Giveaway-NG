import { ConfigError, loadConfig } from '../config/config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { ensurePartitions } from '../journal/partitions.js';
import { buildApp } from './build-app.js';

async function main() {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  await ensurePartitions(pool, new Date(), 2);
  const app = buildApp({ pool }, { logger: { level: config.logLevel } });
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
