import { afterEach, describe, expect, it } from 'vitest';
import { logDenied, logRead, purgeIps } from '../src/audit/access-log.js';
import { AT, freshDb } from './helpers/db.js';
import { ACTOR } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());
const plus = (ms: number) => new Date(AT.getTime() + ms);

async function setup() {
  const db = await freshDb();
  close = db.close;
  return db.pool;
}

describe('access_log', () => {
  it('throttles denials per actor, action and reason within 5 minutes', async () => {
    const pool = await setup();
    const base = { actor: ACTOR, action: 'pause', reason: 'forbidden', ip: '10.0.0.1' };
    await logDenied(pool, { ...base, at: AT });
    await logDenied(pool, { ...base, at: plus(60_000) });
    await logDenied(pool, { ...base, at: plus(299_000) });
    await logDenied(pool, { ...base, reason: 'not_open', at: plus(1_000) });
    await logDenied(pool, { ...base, at: plus(301_000) });
    const r = await pool.query("SELECT reason, count, first_at, last_at FROM access_log WHERE kind = 'denied' ORDER BY id");
    expect(r.rows.map((x) => [x.reason, x.count])).toEqual([['forbidden', 3], ['not_open', 1], ['forbidden', 1]]);
    expect(r.rows[0].last_at).toEqual(plus(299_000));
  });

  it('parallel denials do not create duplicate rows', async () => {
    const pool = await setup();
    await Promise.all(Array.from({ length: 20 }, () => logDenied(pool, { actor: ACTOR, action: 'pause', reason: 'forbidden', at: AT })));
    const r = await pool.query("SELECT count, (SELECT count(*)::int FROM access_log) AS rows FROM access_log");
    expect(r.rows[0]).toEqual({ count: 20, rows: 1 });
  });

  it('logs reads unthrottled', async () => {
    const pool = await setup();
    await logRead(pool, { actor: ACTOR, action: 'view_participants', target: 'giveaway:x', at: AT });
    await logRead(pool, { actor: ACTOR, action: 'view_participants', target: 'giveaway:x', at: AT });
    const r = await pool.query("SELECT count(*)::int AS n FROM access_log WHERE kind = 'read'");
    expect(r.rows[0].n).toBe(2);
  });

  it('removes IPs after 30 days and keeps the rest', async () => {
    const pool = await setup();
    await logRead(pool, { actor: ACTOR, action: 'a', target: 't', ip: '10.0.0.1', at: AT });
    await logRead(pool, { actor: ACTOR, action: 'b', target: 't', ip: '10.0.0.2', at: plus(20 * 86_400_000) });
    expect(await purgeIps(pool, plus(31 * 86_400_000))).toBe(1);
    const r = await pool.query('SELECT action, host(ip) AS ip FROM access_log ORDER BY id');
    expect(r.rows).toEqual([{ action: 'a', ip: null }, { action: 'b', ip: '10.0.0.2' }]);
  });
});
