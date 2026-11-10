import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { allowAll } from '../src/framework/giveaway/authorize.js';
import { InMemoryPublisher } from '../src/framework/publisher.js';
import { createRuntime } from '../src/framework/runtime.js';
import { ensurePartitions } from '../src/journal/partitions.js';
import { AT } from './helpers/db.js';
import { GID, P1, TEAM } from './helpers/giveaway.js';

// Die Skripte laufen im PostgreSQL-Container selbst (pg_dump, pg_restore, psql liegen dort), gegen seine eigene Datenbank.
const script = (name: string) => fileURLToPath(new URL(`../../../backup/${name}`, import.meta.url));

let c: StartedPostgreSqlContainer;
let pool: pg.Pool;
let env: Record<string, string>;

const run = async (cmd: string[], extra: Record<string, string> = {}) => {
  const r = await c.exec(cmd, { env: { ...env, ...extra } });
  return { code: r.exitCode, out: r.output };
};
const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse((await c.exec(['cat', path])).output) as Record<string, unknown>;

beforeAll(async () => {
  c = await new PostgreSqlContainer('postgres:17-alpine')
    .withCopyFilesToContainer([
      { source: script('backup.sh'), target: '/backup/backup.sh' },
      { source: script('restore-check.sh'), target: '/backup/restore-check.sh' },
      { source: script('health.sh'), target: '/backup/health.sh' },
    ])
    .start();
  env = { PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: c.getUsername(), PGPASSWORD: c.getPassword(), PGDATABASE: c.getDatabase(), BACKUP_DIR: '/backups', KEEP_DAYS: '30' };
  pool = new pg.Pool({ connectionString: c.getConnectionUri(), max: 4 });
  await runMigrations(pool);
  await ensurePartitions(pool, AT, 0);
  const rt = createRuntime({ pool, publisher: new InMemoryPublisher(), auth: allowAll, log: { error: () => {} } });
  const r = await rt.bus.execute(rt.handlers.create, { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1] } }, { actor: `user:${P1}`, correlationId: randomUUID(), now: AT });
  if (!r.ok) throw new Error(r.rejection.code);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await c?.stop();
});

describe('Backup und Restore-Probe', () => {
  it('backup.sh writes a custom-format dump and a manifest with the event count, and deletes dumps older than KEEP_DAYS', async () => {
    // Ein alter Dump, der weg muss, und ein junger, der bleibt.
    expect((await run(['sh', '-c', 'mkdir -p /backups && touch -d 2020-01-01 /backups/ccg_20200101_000000.dump && touch /backups/ccg_young.dump'])).code).toBe(0);
    const r = await run(['sh', '/backup/backup.sh']);
    expect(r.out).toContain('[backup] ok');
    expect(r.code).toBe(0);
    const manifest = await readJson('/backups/manifest.json');
    expect(manifest).toMatchObject({ status: 'ok', eventsBefore: 1, eventsAfter: 1, keepDays: 30 });
    expect(String(manifest.file)).toMatch(/^\/backups\/ccg_\d{8}_\d{6}\.dump$/);
    expect(Number(manifest.bytes)).toBeGreaterThan(1000);
    const files = (await c.exec(['sh', '-c', 'ls /backups'])).output.split('\n').filter(Boolean).sort();
    expect(files).not.toContain('ccg_20200101_000000.dump');
    expect(files).toContain('ccg_young.dump');
    expect(files.some((f) => f === String(manifest.file).replace('/backups/', ''))).toBe(true);
    expect((await run(['sh', '/backup/health.sh'])).code).toBe(0);
    // Fehler: falsche Datenbank → Exit 1, letzter Fehler in last-error.json, das Manifest des letzten guten Backups bleibt, kein halber Dump.
    const bad = await run(['sh', '/backup/backup.sh'], { PGDATABASE: 'gibt_es_nicht' });
    expect(bad.code).toBe(1);
    expect(await readJson('/backups/last-error.json')).toMatchObject({ status: 'error', message: expect.stringContaining('Ereignisse zählen') });
    expect(await readJson('/backups/manifest.json')).toMatchObject({ status: 'ok', file: manifest.file });
    expect((await c.exec(['sh', '-c', 'ls /backups/*.part 2>/dev/null | wc -l'])).output.trim()).toBe('0');
    // Healthcheck: ein Fehler nach dem letzten guten Backup → unhealthy; danach wieder gut → healthy; altes Manifest → unhealthy.
    expect((await run(['sh', '/backup/health.sh'])).code).toBe(1);
    expect((await run(['sh', '/backup/backup.sh'])).code).toBe(0);
    expect((await run(['sh', '/backup/health.sh'])).code).toBe(0);
    expect((await c.exec(['sh', '-c', 'touch -d 2020-01-01 /backups/manifest.json'])).exitCode).toBe(0);
    expect((await run(['sh', '/backup/health.sh'])).code).toBe(1);
    expect((await run(['sh', '/backup/backup.sh'])).code).toBe(0);
    expect((await run(['sh', '/backup/health.sh'])).code).toBe(0);
  });

  it('restore-check.sh restores the manifest dump into a check database, compares the event count, writes restore-check.json and drops the check database', async () => {
    const r = await run(['sh', '/backup/restore-check.sh']);
    expect(r.out).toContain('[restore-check] ok');
    expect(r.code).toBe(0);
    const result = await readJson('/backups/restore-check.json');
    expect(result).toMatchObject({ status: 'ok', events: 1 });
    expect((await run(['sh', '/backup/health.sh'])).code).toBe(0);
    const dbs = await pool.query<{ datname: string }>('SELECT datname FROM pg_database');
    expect(dbs.rows.map((x) => x.datname)).not.toContain('ccg_restore_check');
    // Spanne: Ereignisse vor und nach dem Dump; liegt die Probe außerhalb, meldet sie es.
    expect((await c.exec(['sh', '-c', `sed -i 's/"eventsBefore":1/"eventsBefore":2/; s/"eventsAfter":1/"eventsAfter":3/' /backups/manifest.json`])).exitCode).toBe(0);
    const mismatch = await run(['sh', '/backup/restore-check.sh']);
    expect(mismatch.code).toBe(1);
    expect(await readJson('/backups/restore-check.json')).toMatchObject({ status: 'error', message: expect.stringContaining('Ereigniszahl 1 außerhalb 2 bis 3') });
    expect((await run(['sh', '/backup/health.sh'])).code).toBe(1);
    expect((await pool.query<{ datname: string }>('SELECT datname FROM pg_database')).rows.map((x) => x.datname)).not.toContain('ccg_restore_check');
  });
});
