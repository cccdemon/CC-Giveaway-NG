import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandBus, type CommandBusDeps, type CommandHandler } from '../src/framework/command-bus.js';
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
  return { pool: db.pool, url: db.url, bus, publisher, log, projections };
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

  const bumpingHandler = (times: number, calls: { n: number }): CommandHandler<{ stream: string; by: number }, { total: number }> => ({
    ...incrementHandler,
    prepare: async (c, cmd) => {
      calls.n += 1;
      if (calls.n <= times) await c.query('UPDATE stream_heads SET last_seq = last_seq + 1 WHERE stream = $1', [cmd.stream]);
      return undefined;
    },
  });

  it('retries once on seq conflict', async () => {
    const { pool, bus } = await setup();
    await bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx());
    const calls = { n: 0 };
    const res = await bus.execute(bumpingHandler(1, calls), { stream: STREAM, by: 1 }, ctx());
    expect(res.ok).toBe(true);
    expect(calls.n).toBe(2);
    if (res.ok) expect(res.events.map((e) => e.seq)).toEqual([2]);
    expect(await total(pool)).toBe(2);
  });

  it('propagates a persistent seq conflict after exactly two attempts', async () => {
    const { bus, publisher } = await setup();
    await bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx());
    const calls = { n: 0 };
    await expect(bus.execute(bumpingHandler(99, calls), { stream: STREAM, by: 1 }, ctx())).rejects.toMatchObject({ code: 'seq_conflict' });
    expect(calls.n).toBe(2);
    expect(publisher.messages).toHaveLength(1);
  });

  it('still returns the rejection when logging the denial fails', async () => {
    const { pool, bus, log } = await setup();
    await pool.query('DROP TABLE access_log');
    const res = await bus.execute(incrementHandler, { stream: STREAM, by: 1, deny: true }, ctx());
    expect(res).toMatchObject({ ok: false, rejection: { code: 'forbidden' } });
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('does not publish when decide returns no events', async () => {
    const { bus, publisher } = await setup();
    const noop: CommandHandler<{ stream: string }, { total: number }> = { ...incrementHandler, decide: () => [] };
    const res = await bus.execute(noop, { stream: STREAM }, ctx());
    expect(res).toEqual({ ok: true, events: [] });
    expect(publisher.messages).toEqual([]);
  });

  it('two bus instances with own pools keep seq gapless', async () => {
    const { pool, url, bus, publisher, projections, log } = await setup();
    const pool2 = new pg.Pool({ connectionString: url, max: 30 });
    try {
      const bus2 = new CommandBus({ pool: pool2, registry, projections, publisher, log });
      const run = (b: CommandBus) => Array.from({ length: 10 }, () => b.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx()));
      const results = await Promise.all([...run(bus), ...run(bus2)]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect((await readStream(pool, registry, STREAM)).map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(await total(pool)).toBe(20);
    } finally {
      await pool2.end();
    }
  });
});
