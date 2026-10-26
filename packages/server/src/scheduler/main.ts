import { ConfigError, loadConfig } from '../config/config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { scheduleLoop } from './loop.js';
import { runMaintenance } from './maintenance.js';

const HOUR_MS = 60 * 60 * 1000;

/** Genau eine Instanz dieses Prozesses darf laufen (NEW_DESIGN.md 3.1). */
async function main() {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  const tick = async () => {
    try {
      const r = await runMaintenance(pool, new Date());
      console.log(JSON.stringify({ msg: 'Wartung erledigt', ...r }));
    } catch (e) {
      console.error(JSON.stringify({ msg: 'Wartung fehlgeschlagen. Nächster Versuch in einer Stunde.', err: e instanceof Error ? e.stack : String(e) }));
    }
  };
  const loop = scheduleLoop(tick, HOUR_MS);

  const shutdown = (signal: string) => {
    console.log(JSON.stringify({ msg: 'Der Prozess fährt herunter.', signal }));
    loop
      .stop()
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
