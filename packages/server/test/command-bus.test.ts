import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandBus, type CommandBusDeps } from '../src/framework/command-bus.js';
import { ProjectionRegistry } from '../src/framework/projections.js';
import { InMemoryPublisher, type Publisher } from '../src/framework/publisher.js';
import { readStream } from '../src/journal/journal.js';
import { AT, freshDb } from './helpers/db.js';
import { STREAM, counterReducer, ctx, incrementHandler, testRegistry, totalsProjector } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());
const registry = testRegistry();

async function setup(over: Partial<CommandBusDeps> = {}) {
  const db = await freshDb();
  close = db.close;
  await db.pool.query('CREATE TABLE test_totals (stream TEXT PRIMARY KEY, total INT NOT NULL)');
  const projections = new ProjectionRegistry();
  projections.register(totalsProjector);
  const publisher = new InMemoryPublisher();
  const log = { error: vi.fn() };
  const bus = new CommandBus({ pool: db.pool, registry, projections, publisher, log, ...over });
  return { pool: db.pool, bus, publisher, log, projections };
}

const total = async (pool: pg.Pool) => (await pool.query('SELECT total FROM test_totals WHERE stream = $1', [STREAM])).rows[0]?.total ?? 0;

describe('CommandBus', () => {
  it('executes: journal, projection and push', async () => {
    const { pool, bus, publisher } = await setup();
    const res = await bus.execute(incrementHandler, { stream: STREAM, by: 3 }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events.map((e) => [e.seq, e.type])).toEqual([[1, 'counter_incremented']]);
    expect(await total(pool)).toBe(3);
    expect(publisher.messages).toEqual([{ stream: STREAM, events: res.events }]);
  });

  it('decide sees the current state', async () => {
    const { bus } = await setup();
    await bus.execute(incrementHandler, { stream: STREAM, by: 60 }, ctx());
    const res = await bus.execute(incrementHandler, { stream: STREAM, by: 50 }, ctx());
    expect(res).toEqual({ ok: false, rejection: { rejected: true, code: 'too_big', message: 'Der Zähler darf 100 nicht überschreiten.' } });
  });

  it('logs denied and rejected commands in access_log, no events', async () => {
    const { pool, bus, publisher } = await setup();
    await bus.execute(incrementHandler, { stream: STREAM, by: 1, deny: true }, ctx());
    await bus.execute(incrementHandler, { stream: STREAM, by: 500 }, ctx());
    const log = await pool.query("SELECT action, reason, target, host(ip) AS ip FROM access_log WHERE kind = 'denied' ORDER BY id");
    expect(log.rows).toEqual([
      { action: 'increment', reason: 'forbidden', target: STREAM, ip: '10.0.0.9' },
      { action: 'increment', reason: 'too_big', target: STREAM, ip: '10.0.0.9' },
    ]);
    expect(await readStream(pool, registry, STREAM)).toEqual([]);
    expect(publisher.messages).toEqual([]);
  });

  it('parallel commands keep seq gapless', async () => {
    const { pool, bus } = await setup();
    const results = await Promise.all(Array.from({ length: 20 }, () => bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx())));
    expect(results.every((r) => r.ok)).toBe(true);
    const seqs = (await readStream(pool, registry, STREAM)).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await total(pool)).toBe(20);
  });

  it('projection failure rolls back everything', async () => {
    const projections = new ProjectionRegistry();
    projections.register({ name: 'broken', handles: ['counter_incremented'], apply: async () => { throw new Error('kaputt'); }, reset: async () => undefined });
    const { pool, bus, publisher } = await setup({ projections });
    await expect(bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx())).rejects.toThrow('kaputt');
    expect(await readStream(pool, registry, STREAM)).toEqual([]);
    const head = await pool.query('SELECT last_seq FROM stream_heads WHERE stream = $1', [STREAM]);
    expect(head.rows[0]?.last_seq ?? 0).toBe(0);
    expect(publisher.messages).toEqual([]);
  });

  it('creates missing partition and retries', async () => {
    const { pool, bus } = await setup();
    const later = new Date('2031-01-01T00:00:05Z');
    const res = await bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx({ now: later }));
    expect(res.ok).toBe(true);
    const r = await pool.query("SELECT count(*)::int AS n FROM events_y2031m01");
    expect(r.rows[0].n).toBe(1);
  });

  it('push failure does not undo the committed command', async () => {
    const failing: Publisher = { publish: async () => { throw new Error('redis weg'); } };
    const { pool, bus, log } = await setup({ publisher: failing });
    const res = await bus.execute(incrementHandler, { stream: STREAM, by: 2 }, ctx());
    expect(res.ok).toBe(true);
    expect(await total(pool)).toBe(2);
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('writes snapshots and loads state equal to full replay', async () => {
    const { pool, bus } = await setup({ snapshotEvery: 3 });
    for (let i = 0; i < 7; i++) await bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx());
    const snaps = await pool.query('SELECT seq, state FROM snapshots WHERE stream = $1 ORDER BY seq', [STREAM]);
    expect(snaps.rows).toEqual([{ seq: 3, state: { total: 3 } }, { seq: 6, state: { total: 6 } }]);
    const c = await pool.connect();
    try {
      expect(await bus.loadState(c, STREAM, counterReducer)).toEqual({ total: 7 });
    } finally {
      c.release();
    }
    const replay = (await readStream(pool, registry, STREAM)).reduce(counterReducer.apply, counterReducer.initial());
    expect(replay).toEqual({ total: 7 });
  });

  it('runs commands at the fixed test time', async () => {
    const { bus } = await setup();
    const res = await bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx());
    expect(res.ok && res.events[0]!.createdAt).toEqual(AT);
  });
});
