// Lasttest gegen die Dev-Datenbank (NEW_DESIGN.md 12.2): legt eine eigene Datenbank an, fährt den Simulator, druckt Perzentile.
// Aufruf: npm run loadtest -w packages/server -- --channels 1000 --viewers 200 --minutes 3 [--seed 1] [--pool 10] [--keep]
// Exit 1, wenn apply_signals im p95 das Ziel von 100 ms verfehlt.
import { parseArgs } from 'node:util';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { ensurePartitions } from '../src/journal/partitions.js';
import { LOAD_START, runLoadTest, type LoadResult } from '../src/loadtest/run.js';

const { values } = parseArgs({
  options: {
    channels: { type: 'string', default: '1000' },
    viewers: { type: 'string', default: '200' },
    minutes: { type: 'string', default: '3' },
    seed: { type: 'string', default: '1' },
    pool: { type: 'string', default: '10' },
    keep: { type: 'boolean', default: false },
  },
  strict: true,
});

const int = (name: string, raw: string | undefined, min: number): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name}: ganze Zahl ab ${min} erwartet, bekommen „${raw}“.`);
  return n;
};

function table(r: LoadResult): string {
  const rows = Object.entries(r.commands).sort(([a], [b]) => a.localeCompare(b));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(22) : c.padStart(9))).join(' ');
  const out = [line(['Befehl', 'Anzahl', 'Mittel', 'p50', 'p95', 'p99', 'max'])];
  for (const [type, s] of rows) out.push(line([type, String(s.count), s.mean.toFixed(1), s.p50.toFixed(1), s.p95.toFixed(1), s.p99.toFixed(1), s.max.toFixed(1)]));
  return out.join('\n');
}

async function main(): Promise<number> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL fehlt. Setze sie wie in .env (Dev-Compose auf Port 5433).');
  const channels = int('--channels', values.channels, 1);
  const viewers = int('--viewers', values.viewers, 1);
  const minutes = int('--minutes', values.minutes, 1);
  const seed = int('--seed', values.seed, 0);
  const max = int('--pool', values.pool, 1);
  const name = `loadtest_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: base });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), { max, queryTimeoutMillis: 0 });
  console.log(`Datenbank ${name} angelegt. ${channels} Kanäle × ${viewers} Zuschauer, ${minutes} Minuten, Seed ${seed}, Pool ${max}.`);
  try {
    await runMigrations(pool);
    await ensurePartitions(pool, LOAD_START, 1);
    const r = await runLoadTest({
      pool, channels, viewers, minutes, seed,
      onMinute: (m, info) => console.log(`Minute ${m}: ${info.commands} Befehle in ${(info.ms / 1000).toFixed(1)} s`),
    });
    console.log('');
    console.log(table(r));
    console.log('');
    console.log(`Ereignisse: ${r.events}, abgelehnt: ${r.rejected}, fehlgeschlagen: ${r.failed}, Wanduhr: ${(r.wallMs / 1000).toFixed(1)} s`);
    console.log(`Ziel: apply_signals p95 < ${r.target.p95Ms} ms → ${r.target.ok ? 'erreicht' : 'verfehlt'}`);
    return r.target.ok && r.failed === 0 ? 0 : 1;
  } finally {
    await pool.end();
    if (values.keep) console.log(`Datenbank ${name} bleibt (--keep).`);
    else {
      await admin.query(`DROP DATABASE ${name}`);
      console.log(`Datenbank ${name} gelöscht.`);
    }
    await admin.end();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
