import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowAll } from '../src/framework/giveaway/authorize.js';
import { reconcileKernelVersions } from '../src/framework/giveaway/projectors.js';
import { giveawayStream } from '../src/framework/giveaway/state.js';
import { KernelRegistry } from '../src/framework/kernel-registry.js';
import { InMemoryPublisher } from '../src/framework/publisher.js';
import { createRuntime, type Runtime } from '../src/framework/runtime.js';
import { loadStreamState } from '../src/framework/state.js';
import { readStream } from '../src/journal/journal.js';
import { loadSnapshot } from '../src/journal/snapshots.js';
import { instantKernel } from '../src/kernels/instant/index.js';
import { GID, GID2, P1, P2, TEAM, createOpen, must, openWindow, setupGiveaway, state, userOf } from './helpers/giveaway.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function setup(over: Parameters<typeof setupGiveaway>[0] = {}) {
  const s = await setupGiveaway(over);
  closers.push(s.close);
  return s;
}

const STREAM = giveawayStream(GID);

async function registerAll(rt: Runtime, pids: string[], giveawayId = GID): Promise<void> {
  for (const pid of pids) await must(rt, rt.handlers.register, { giveawayId, pid }, { actor: userOf(pid) });
}

async function giveawayRow(pool: pg.Pool, id = GID) {
  return (await pool.query('SELECT * FROM giveaways WHERE id = $1', [id])).rows[0];
}

async function participantRows(pool: pg.Pool, id = GID) {
  const r = await pool.query(
    'SELECT pid, registered, in_pool, weight, winner_status FROM giveaway_participants WHERE giveaway_id = $1 ORDER BY pid',
    [id],
  );
  return r.rows;
}

async function timerRows(pool: pg.Pool, stream = STREAM) {
  return (await pool.query('SELECT stream, key, due_at, command FROM timers WHERE stream = $1 ORDER BY key', [stream])).rows;
}

async function lastSeq(pool: pg.Pool, stream = STREAM): Promise<number> {
  return (await pool.query<{ seq: number }>('SELECT max(seq)::int AS seq FROM events WHERE stream = $1', [stream])).rows[0]!.seq;
}

async function openSecondWithP1(rt: Runtime): Promise<void> {
  await createOpen(rt, { giveawayId: GID2 });
  await must(rt, rt.handlers.kernelCommand, { giveawayId: GID2, command: { type: 'open_window', args: {} } });
  await registerAll(rt, [P1], GID2);
}

describe('Lesetabellen des Giveaways', () => {
  it('giveaways row mirrors the state', async () => {
    const { pool, rt } = await setup();
    await must(rt, rt.handlers.create, { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1] } });
    expect(await giveawayRow(pool)).toMatchObject({ status: 'draft', registered_count: 0 });
    await must(rt, rt.handlers.open, { giveawayId: GID });
    await openWindow(rt);
    await registerAll(rt, [P1, P2]);
    expect(await giveawayRow(pool)).toMatchObject({
      status: 'open',
      registered_count: 2,
      pool_size: 2,
      pool_weight: 2,
      last_seq: await lastSeq(pool),
    });
  });

  it('participants rows follow registration, pool and winner status', async () => {
    const { pool, rt } = await setup();
    await createOpen(rt);
    await openWindow(rt);
    await registerAll(rt, [P1, P2]);
    const row = (pid: string, winner_status: string | null = null) => ({ pid, registered: true, in_pool: true, weight: 1, winner_status });
    expect(await participantRows(pool)).toEqual([row(P1), row(P2)]);
    await must(rt, rt.handlers.withdraw, { giveawayId: GID, pid: P2 }, { actor: userOf(P2) });
    expect(await participantRows(pool)).toEqual([row(P1)]);
    await must(rt, rt.handlers.close, { giveawayId: GID });
    await must(rt, rt.handlers.draw, { giveawayId: GID });
    expect(await participantRows(pool)).toEqual([row(P1, 'pending')]);
    await must(rt, rt.handlers.setWinnerStatus, { giveawayId: GID, pid: P1, status: 'done' });
    expect(await participantRows(pool)).toEqual([row(P1, 'done')]);
  });

  it('timers mirror open windows only', async () => {
    const { pool, rt } = await setup();
    await createOpen(rt);
    await openWindow(rt);
    const until = ((await state(rt)).kernelState as { window: { until: string } }).window.until;
    const row = { stream: STREAM, key: 'window_end', due_at: new Date(until), command: { type: 'close_window', args: {} } };
    expect(await timerRows(pool)).toEqual([row]);
    await must(rt, rt.handlers.pause, { giveawayId: GID });
    expect(await timerRows(pool)).toEqual([]);
    await must(rt, rt.handlers.resume, { giveawayId: GID });
    expect(await timerRows(pool)).toEqual([row]);
    await must(rt, rt.handlers.kernelCommand, { giveawayId: GID, command: { type: 'close_window', args: {} } }, { actor: 'system:scheduler' });
    expect(await timerRows(pool)).toEqual([]);
  });

  it('rebuildStream reproduces the rows', async () => {
    const { pool, rt } = await setup();
    await createOpen(rt);
    await openWindow(rt);
    await registerAll(rt, [P1, P2]);
    await openSecondWithP1(rt);
    const rows = async () => ({
      g: await giveawayRow(pool),
      p: await participantRows(pool),
      t: await timerRows(pool),
      g2: await giveawayRow(pool, GID2),
      p2: await participantRows(pool, GID2),
      t2: await timerRows(pool, giveawayStream(GID2)),
    });
    const before = await rows();
    expect(before.t).toHaveLength(1);
    expect(before.t2).toHaveLength(1);
    await pool.query('UPDATE giveaways SET registered_count = 42, status = $2 WHERE id = $1', [GID, 'closed']);
    await pool.query('DELETE FROM giveaway_participants WHERE giveaway_id = $1 AND pid = $2', [GID, P2]);
    await pool.query('UPDATE giveaway_participants SET weight = 9 WHERE giveaway_id = $1', [GID]);
    await pool.query('DELETE FROM timers WHERE stream = $1', [STREAM]);
    expect((await rows()).g.registered_count).toBe(42);
    await rt.projections.rebuildStream(pool, rt.registry, STREAM, rt.reducer);
    expect(await rows()).toEqual(before);
  });

  it('reconcile rebuilds open giveaways only', async () => {
    const { pool, rt } = await setup();
    await createOpen(rt);
    await openWindow(rt);
    await registerAll(rt, [P1, P2]);
    await openSecondWithP1(rt);
    await must(rt, rt.handlers.close, { giveawayId: GID2 });
    await must(rt, rt.handlers.draw, { giveawayId: GID2 });
    await must(rt, rt.handlers.setWinnerStatus, { giveawayId: GID2, pid: P1, status: 'done' });
    await must(rt, rt.handlers.complete, { giveawayId: GID2 });
    await pool.query('UPDATE giveaways SET kernel_version = 99, registered_count = 42');
    expect(await reconcileKernelVersions(pool, rt)).toEqual([GID]);
    expect(await giveawayRow(pool)).toMatchObject({ status: 'open', kernel_version: 1, registered_count: 2 });
    expect(await giveawayRow(pool, GID2)).toMatchObject({ status: 'completed', kernel_version: 99, registered_count: 42 });
  });

  it('kernel version change invalidates snapshots', async () => {
    const { pool, rt } = await setup({ snapshotEvery: 2 });
    await createOpen(rt);
    await openWindow(rt);
    await registerAll(rt, [P1]);
    expect(await lastSeq(pool)).toBe(4);
    expect(await loadSnapshot(pool, STREAM, { name: 'giveaway', version: rt.reducer.version })).not.toBeNull();
    const k2 = new KernelRegistry();
    k2.register({ ...instantKernel, version: 2 });
    const rt2 = createRuntime({ pool, publisher: new InMemoryPublisher(), auth: allowAll, log: { error: vi.fn() }, kernels: k2 });
    expect(rt2.reducer.version).not.toBe(rt.reducer.version);
    const c = await pool.connect();
    const loaded = await loadStreamState(c, rt2.registry, STREAM, rt2.reducer).finally(() => c.release());
    const replayed = (await readStream(pool, rt2.registry, STREAM)).reduce(rt2.reducer.apply, rt2.reducer.initial());
    expect(loaded).toEqual(replayed);
    expect(loaded).toEqual(await state(rt));
    expect(await loadSnapshot(pool, STREAM, { name: 'giveaway', version: rt2.reducer.version })).toBeNull();
    const old = await pool.query<{ reducer_version: number }>('SELECT reducer_version FROM snapshots WHERE stream = $1', [STREAM]);
    expect(old.rows.map((r) => r.reducer_version)).toContain(rt.reducer.version);
  });
});
