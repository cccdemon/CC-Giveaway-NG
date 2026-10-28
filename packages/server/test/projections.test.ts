import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { CommandBus } from '../src/framework/command-bus.js';
import { ProjectionRegistry } from '../src/framework/projections.js';
import { InMemoryPublisher } from '../src/framework/publisher.js';
import { appendLocked, lockStream } from '../src/journal/journal.js';
import { loadSnapshot, saveSnapshot } from '../src/journal/snapshots.js';
import { AT, freshDb } from './helpers/db.js';
import { ACTOR, OTHER_STREAM, STREAM, counterReducer, ctx, incrementHandler, testRegistry, totalsProjector, totalsStateProjector } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());
const registry = testRegistry();

async function setup() {
  const db = await freshDb();
  close = db.close;
  await db.pool.query('CREATE TABLE test_totals (stream TEXT PRIMARY KEY, total INT NOT NULL)');
  await db.pool.query('CREATE TABLE test_state_totals (stream TEXT PRIMARY KEY, total INT NOT NULL, seq INT NOT NULL)');
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
  it('rebuildStream resets only that stream and equals the live state', async () => {
    const pool = await setup();
    const p = new ProjectionRegistry();
    p.registerState(totalsStateProjector);
    const bus = new CommandBus({ pool, registry, projections: p, publisher: new InMemoryPublisher(), log: { error: vi.fn() } });
    for (const by of [5, 2, 7]) await bus.execute(incrementHandler, { stream: STREAM, by }, ctx());
    await bus.execute(incrementHandler, { stream: OTHER_STREAM, by: 1 }, ctx());
    const live = (await pool.query('SELECT total, seq FROM test_state_totals WHERE stream = $1', [STREAM])).rows;
    expect(live).toEqual([{ total: 14, seq: 3 }]);
    await pool.query('UPDATE test_state_totals SET total = 999');
    await p.rebuildStream(pool, registry, STREAM, counterReducer);
    expect((await pool.query('SELECT stream, total, seq FROM test_state_totals ORDER BY stream')).rows).toEqual([
      { stream: STREAM, total: 14, seq: 3 },
      { stream: OTHER_STREAM, total: 999, seq: 1 },
    ]);
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
