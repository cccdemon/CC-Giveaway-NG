import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { ensurePartitions } from '../../src/journal/partitions.js';

export const AT = new Date('2026-10-15T12:00:00Z');

export async function freshDb(opts: { migrate?: boolean } = {}) {
  const base = inject('pgUrl');
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: base });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 30 });
  if (opts.migrate !== false) {
    await runMigrations(pool);
    await ensurePartitions(pool, AT, 0);
  }
  return { pool, url: url.toString(), close: () => pool.end() };
}
