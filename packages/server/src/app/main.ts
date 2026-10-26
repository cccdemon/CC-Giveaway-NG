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
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
