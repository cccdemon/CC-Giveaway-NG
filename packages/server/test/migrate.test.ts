import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { withTx } from '../src/db/pool.js';
import { freshDb } from './helpers/db.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

async function dirWith(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mig-'));
  for (const [n, sql] of Object.entries(files)) await writeFile(path.join(dir, n), sql);
  return dir;
}

describe('runMigrations', () => {
  it('applies files in order exactly once', async () => {
    const db = await freshDb({ migrate: false });
    close = db.close;
    const dir = await dirWith({
      '002_b.sql': 'INSERT INTO t (v) VALUES (2);',
      '001_a.sql': 'CREATE TABLE t (v INT);',
      'readme.txt': 'ignored',
    });
    expect(await runMigrations(db.pool, dir)).toEqual(['001_a.sql', '002_b.sql']);
    expect(await runMigrations(db.pool, dir)).toEqual([]);
    const r = await db.pool.query('SELECT v FROM t');
    expect(r.rows).toEqual([{ v: 2 }]);
  });

  it('rolls back everything and names the broken file', async () => {
    const db = await freshDb({ migrate: false });
    close = db.close;
    const dir = await dirWith({ '001_a.sql': 'CREATE TABLE t (v INT);', '002_b.sql': 'THIS IS NOT SQL;' });
    await expect(runMigrations(db.pool, dir)).rejects.toThrow(/002_b\.sql/);
    const r = await db.pool.query("SELECT to_regclass('t') AS t");
    expect(r.rows[0].t).toBeNull();
  });

  it('withTx rolls back on error', async () => {
    const db = await freshDb({ migrate: false });
    close = db.close;
    await db.pool.query('CREATE TABLE x (v INT)');
    await expect(withTx(db.pool, async (c) => {
      await c.query('INSERT INTO x VALUES (1)');
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM x')).rows[0].n).toBe(0);
  });
});
