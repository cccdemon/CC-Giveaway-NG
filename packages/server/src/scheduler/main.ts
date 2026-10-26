import { ConfigError, loadConfig } from '../config/config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
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
      console.error(JSON.stringify({ msg: 'Wartung fehlgeschlagen. Nächster Versuch in einer Stunde.', err: String(e) }));
    }
  };
  await tick();
  setInterval(tick, HOUR_MS);
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});
