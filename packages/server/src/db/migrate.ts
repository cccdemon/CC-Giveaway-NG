import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { withTx } from './pool.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const LOCK_KEY = 4242000;

export async function runMigrations(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  return withTx(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(dir, f), 'utf8');
      try {
        await c.query(sql);
      } catch (e) {
        throw new Error(`Migration ${f} ist fehlgeschlagen: ${(e as Error).message}`);
      }
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      applied.push(f);
    }
    return applied;
  });
}
