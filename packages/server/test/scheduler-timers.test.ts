import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { giveawayStream } from '../src/framework/giveaway/state.js';
import { readStream } from '../src/journal/journal.js';
import { runDueTimers } from '../src/scheduler/timers.js';
import { GID, GID2, GID3, at, createOpen, must, openWindow, setupGiveaway } from './helpers/giveaway.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function setup() {
  const s = await setupGiveaway();
  closers.push(s.close);
  return { ...s, log: { error: vi.fn() } };
}

async function timerRows(pool: pg.Pool) {
  return (await pool.query('SELECT stream, key FROM timers ORDER BY stream, key')).rows;
}

async function insertTimer(pool: pg.Pool, giveawayId: string) {
  await pool.query('INSERT INTO timers (stream, key, due_at, command) VALUES ($1, $2, $3, $4)', [
    giveawayStream(giveawayId),
    'window_end',
    at(120),
    JSON.stringify({ type: 'close_window', args: {} }),
  ]);
}

describe('runDueTimers', () => {
  it('closes an expired window via command', async () => {
    const { pool, rt, log } = await setup();
    await createOpen(rt);
    await openWindow(rt);
    expect(await runDueTimers(pool, rt, at(119), log)).toEqual({ ran: 0, rejected: 0, failed: 0 });
    expect(await timerRows(pool)).toEqual([{ stream: giveawayStream(GID), key: 'window_end' }]);
    expect(await runDueTimers(pool, rt, at(120), log)).toEqual({ ran: 1, rejected: 0, failed: 0 });
    const last = (await readStream(pool, rt.registry, giveawayStream(GID))).at(-1)!;
    expect(last).toMatchObject({ type: 'instant_window_closed', actor: 'system:scheduler', createdAt: at(120) });
    expect(await timerRows(pool)).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('stale timer rows are removed when the command is rejected', async () => {
    const { pool, rt, log } = await setup();
    await createOpen(rt);
    await must(rt, rt.handlers.pause, { giveawayId: GID });
    const before = await readStream(pool, rt.registry, giveawayStream(GID));
    await insertTimer(pool, GID);
    expect(await runDueTimers(pool, rt, at(120), log)).toEqual({ ran: 0, rejected: 1, failed: 0 });
    expect(await timerRows(pool)).toEqual([]);
    expect(await readStream(pool, rt.registry, giveawayStream(GID))).toEqual(before);
  });

  it('missing giveaway row removes the timer', async () => {
    const { pool, rt, log } = await setup();
    await insertTimer(pool, GID);
    expect(await runDueTimers(pool, rt, at(120), log)).toEqual({ ran: 0, rejected: 1, failed: 0 });
    expect(await timerRows(pool)).toEqual([]);
    expect(await readStream(pool, rt.registry, giveawayStream(GID))).toEqual([]);
  });

  it('runs at most batch per call', async () => {
    const { pool, rt, log } = await setup();
    for (const giveawayId of [GID, GID2, GID3]) {
      await createOpen(rt, { giveawayId });
      await must(rt, rt.handlers.kernelCommand, { giveawayId, command: { type: 'open_window', args: {} } });
    }
    expect(await runDueTimers(pool, rt, at(120), log, 2)).toEqual({ ran: 2, rejected: 0, failed: 0 });
    expect(await timerRows(pool)).toHaveLength(1);
    expect(await runDueTimers(pool, rt, at(120), log, 2)).toEqual({ ran: 1, rejected: 0, failed: 0 });
    expect(await runDueTimers(pool, rt, at(120), log, 2)).toEqual({ ran: 0, rejected: 0, failed: 0 });
    expect(await timerRows(pool)).toEqual([]);
  });
});
