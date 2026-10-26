import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app/build-app.js';
import { freshDb } from './helpers/db.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('GET /healthz', () => {
  it('returns ok when the database answers', async () => {
    const db = await freshDb();
    close = db.close;
    const res = await buildApp({ pool: db.pool }).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 with a German reason when the database is gone', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://x:y@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    close = () => pool.end();
    const res = await buildApp({ pool }).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', reason: 'Die Datenbank antwortet nicht.' });
  });
});
