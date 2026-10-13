import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { ProjectionRegistry } from '../src/framework/projections.js';
import { appendLocked, lockStream } from '../src/journal/journal.js';
import { loadSnapshot, saveSnapshot } from '../src/journal/snapshots.js';
import { AT, freshDb } from './helpers/db.js';
import { ACTOR, OTHER_STREAM, STREAM, testRegistry, totalsProjector } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());
const registry = testRegistry();

async function setup() {
  const db = await freshDb();
  close = db.close;
  await db.pool.query('CREATE TABLE test_totals (stream TEXT PRIMARY KEY, total INT NOT NULL)');
  return db.pool;
}

async function write(pool: pg.Pool, projections: ProjectionRegistry, stream: string, by: number[]) {
  await withTx(pool, async (c) => {
    const events = await appendLocked(c, registry, {
      stream, lastSeq: await lockStream(c, stream), actor: ACTOR, correlationId: randomUUID(), at: AT,
      events: by.map((b) => ({ type: b > 0 ? 'counter_incremented' : 'counter_decremented', payload: { by: Math.abs(b) } })),
    });
    await projections.applyAll(c, events);
  });
}

describe('ProjectionRegistry', () => {
  it('applies only handled types and refuses duplicate names', async () => {
    const pool = await setup();
    const p = new ProjectionRegistry();
    p.register(totalsProjector);
    expect(() => p.register(totalsProjector)).toThrow(/doppelt/);
    await write(pool, p, STREAM, [5, -2]);
    await withTx(pool, async (c) => {
      const ev = await appendLocked(c, registry, {
        stream: STREAM, lastSeq: await lockStream(c, STREAM), actor: ACTOR, correlationId: randomUUID(), at: AT,
        events: [{ type: 'note_sent', payload: { text: 'x', channel: 'y' } }],
      });
      await p.applyAll(c, ev);
    });
    const r = await pool.query('SELECT total FROM test_totals WHERE stream = $1', [STREAM]);
    expect(r.rows[0].total).toBe(3);
  });

  it('rebuild equals the incremental result', async () => {
    const pool = await setup();
    const p = new ProjectionRegistry();
    p.register(totalsProjector);
    await write(pool, p, STREAM, [5, -2, 7]);
    await write(pool, p, OTHER_STREAM, [1, 1]);
    const before = (await pool.query('SELECT * FROM test_totals ORDER BY stream')).rows;
    await pool.query('UPDATE test_totals SET total = 999');
    const applied = await p.rebuild(pool, registry, 'totals', 2);
    expect(applied).toBe(5);
    expect((await pool.query('SELECT * FROM test_totals ORDER BY stream')).rows).toEqual(before);
  });
});

describe('snapshots', () => {
  it('returns the newest snapshot of the matching reducer version', async () => {
    const pool = await setup();
    const ref = { name: 'counter', version: 1 };
    expect(await loadSnapshot(pool, STREAM, ref)).toBeNull();
    await saveSnapshot(pool, STREAM, ref, 1000, { total: 1 }, AT);
    await saveSnapshot(pool, STREAM, ref, 2000, { total: 2 }, AT);
    await saveSnapshot(pool, STREAM, { name: 'counter', version: 2 }, 3000, { total: 3 }, AT);
    await saveSnapshot(pool, STREAM, ref, 2000, { total: 99 }, AT);
    expect(await loadSnapshot(pool, STREAM, ref)).toEqual({ seq: 2000, state: { total: 2 } });
  });
});
