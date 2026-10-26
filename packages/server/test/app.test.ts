import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app/build-app.js';
import { createPool } from '../src/db/pool.js';
import { freshDb } from './helpers/db.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('GET /healthz', () => {
  it('returns ok when the database answers', async () => {
    const db = await freshDb();
    const app = buildApp({ pool: db.pool });
    close = () => app.close();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 with a German reason when the database refuses', async () => {
    const pool = createPool('postgres://x:y@127.0.0.1:1/none', { connectionTimeoutMillis: 500, onError: () => undefined });
    const app = buildApp({ pool });
    close = () => app.close();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', reason: 'Die Datenbank antwortet nicht.' });
  });

  it('returns 503 within the connection timeout when the database does not answer at all', async () => {
    // 10.255.255.1 ist nicht routbar: kein RST, die Verbindung bleibt offen bis zum Timeout.
    const pool = createPool('postgres://x:y@10.255.255.1:5432/none', { connectionTimeoutMillis: 500, onError: () => undefined });
    const app = buildApp({ pool });
    close = () => app.close();
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('closing the app ends the pool', async () => {
    const db = await freshDb();
    const app = buildApp({ pool: db.pool });
    await app.close();
    close = undefined;
    await expect(db.pool.query('SELECT 1')).rejects.toThrow();
  });
});
