import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import type { ApplySignalsCmd } from '../src/framework/giveaway/signals.js';
import { BUNDLE_GRACE_MS, minuteOf } from '../src/ingest/bundler.js';
import { readChannelStatus } from '../src/ingest/channel-status.js';
import type { ChannelSource } from '../src/ingest/directory.js';
import { pgGiveawayLookup } from '../src/ingest/dispatch.js';
import type { AdapterHealth, IngestAdapter, Signal, SignalUser } from '../src/ingest/signals.js';
import { SimulatorAdapter } from '../src/ingest/simulator.js';
import { SIGNAL_NOTE_MIN_MS, createIngestWorker, nonBlocking } from '../src/ingest/worker.js';
import { LocalBus } from '../src/framework/subscriber.js';
import { AT } from './helpers/db.js';
import { GID, GID2, GID3, P1, P2, P3, createOpen, must, setupGiveaway } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const ALICE: SignalUser = { id: '12345', login: 'alice', displayName: 'Alice' };
const at = (sec: number) => new Date(AT.getTime() + sec * 1000);
const AFTER_MINUTE = at(60 + BUNDLE_GRACE_MS / 1000);

function controllable(): IngestAdapter & { emit(s: Signal): void; healthRows: AdapterHealth[] } {
  let handler: (s: Signal) => void = () => {};
  const a = {
    healthRows: [] as AdapterHealth[],
    emit: (s: Signal) => handler(s),
    start: async () => {},
    stop: async () => {},
    onSignal: (h: (s: Signal) => void) => { handler = h; },
    sendChat: async () => ({ ok: true as const, messageId: 'x' }),
    checkFollows: async () => [],
    health: () => a.healthRows,
    close: async () => {},
  };
  return a;
}

async function setup(adapter: IngestAdapter, list: ChannelSource['list'] = async () => [{ pid: P1, twitchId: '1', watch: 'full' }]) {
  const s = await setupGiveaway();
  close = s.close;
  await createOpen(s.rt);
  await createOpen(s.rt, { giveawayId: GID2, settings: { prize: 'Key', channels: [P1, P2] } });
  await createOpen(s.rt, { giveawayId: GID3, settings: { prize: 'Key', channels: [P1] } });
  await must(s.rt, s.rt.handlers.pause, { giveawayId: GID3 });
  const clock = { now: AT };
  const spy = vi.spyOn(s.rt.bus, 'execute');
  const worker = createIngestWorker({
    adapter, source: { list }, lookup: pgGiveawayLookup(s.pool), rt: s.rt, pool: s.pool, workers: 1, index: 0, log: { error: vi.fn() }, now: () => clock.now,
  });
  return { ...s, clock, spy, worker };
}

describe('Ingest-Worker', () => {
  it('presence of a simulator channel reaches apply_signals of every open giveaway with that channel', async () => {
    const sim = new SimulatorAdapter({ viewersPerChannel: 3, now: () => AT });
    const s = await setup(sim);
    await s.worker.refresh();
    expect(sim.channels().map((r) => r.pid)).toEqual([P1]);
    sim.inject({ kind: 'presence', channel: P1, minute: minuteOf(AT), users: [ALICE] });
    sim.inject({ kind: 'chat', channel: P1, at: at(3).toISOString(), user: ALICE, text: 'hi', messageId: 'm1' });
    s.clock.now = at(30);
    await s.worker.tick(s.clock.now);
    expect(s.spy).not.toHaveBeenCalled();
    s.clock.now = AFTER_MINUTE;
    await s.worker.tick(s.clock.now);
    expect(s.spy).toHaveBeenCalledTimes(2);
    const calls = s.spy.mock.calls.map((c) => ({ type: (c[0] as { type: string }).type, cmd: c[1] as ApplySignalsCmd, actor: c[2].actor }));
    expect(calls.map((c) => c.cmd.giveawayId).sort()).toEqual([GID, GID2].sort());
    for (const c of calls) {
      expect(c.type).toBe('apply_signals');
      expect(c.actor).toBe('system:ingest');
      expect(c.cmd).toMatchObject({ channel: P1, minute: minuteOf(AT), presence: [ALICE], chat: [{ user: ALICE, text: 'hi', messageId: 'm1' }], follows: [] });
    }
    for (const r of s.spy.mock.results) expect((await (r.value as Promise<CommandResult>)).ok).toBe(true);
    const row = (await readChannelStatus(s.pool, [P1])).get(P1)!;
    expect(row).toMatchObject({ live: true, viewers: 3, chatters: 1, lastPresenceAt: AT, lastSignalAt: AT, worker: 0 });
  });

  it('a channel without open giveaway only updates channel_status', async () => {
    const a = controllable();
    const s = await setup(a);
    a.emit({ kind: 'presence', channel: P3, minute: minuteOf(AT), users: [ALICE] });
    s.clock.now = AFTER_MINUTE;
    await s.worker.tick(s.clock.now);
    expect(s.spy).not.toHaveBeenCalled();
    expect((await readChannelStatus(s.pool, [P3])).get(P3)).toMatchObject({ chatters: 1, lastPresenceAt: AT, lastSignalAt: AT, live: false });
  });

  it('stream_state updates live, viewers and last_signal_at without any command', async () => {
    const a = controllable();
    const s = await setup(a);
    a.emit({ kind: 'stream_state', channel: P1, at: AT.toISOString(), live: true, viewers: 42 });
    await s.worker.tick(AT);
    expect((await readChannelStatus(s.pool, [P1])).get(P1)).toMatchObject({ live: true, liveSince: AT, viewers: 42, lastSignalAt: AT, worker: 0 });
    s.clock.now = at(10);
    a.emit({ kind: 'stream_state', channel: P1, at: at(10).toISOString(), live: false });
    await s.worker.tick(at(10));
    expect((await readChannelStatus(s.pool, [P1])).get(P1)).toMatchObject({ live: false, liveSince: null, viewers: 42, lastSignalAt: at(10) });
    expect(s.spy).not.toHaveBeenCalled();
  });

  it('adapter health problems land in channel_status.problem and clear again', async () => {
    const a = controllable();
    const s = await setup(a);
    a.healthRows = [{ channel: P1, ok: false, lastSignalAt: null, problem: 'twitch_error' }];
    await s.worker.tick(AT);
    expect((await readChannelStatus(s.pool, [P1])).get(P1)!.problem).toBe('twitch_error');
    a.healthRows = [{ channel: P1, ok: true, lastSignalAt: AT.toISOString(), problem: null }];
    await s.worker.tick(at(1));
    expect((await readChannelStatus(s.pool, [P1])).get(P1)!.problem).toBeNull();
  });

  it('unchanged health does not rewrite channel_status, chat signals are noted at most every 5 s', async () => {
    const a = controllable();
    const s = await setup(a);
    a.healthRows = [{ channel: P1, ok: true, lastSignalAt: AT.toISOString(), problem: null }];
    a.emit({ kind: 'chat', channel: P1, at: AT.toISOString(), user: ALICE, text: 'a', messageId: 'm1' });
    await s.worker.tick(AT);
    const first = (await readChannelStatus(s.pool, [P1])).get(P1)!;
    expect(first).toMatchObject({ lastSignalAt: AT, updatedAt: AT });
    s.clock.now = at(2);
    a.emit({ kind: 'chat', channel: P1, at: at(2).toISOString(), user: ALICE, text: 'b', messageId: 'm2' });
    await s.worker.tick(at(2));
    await s.worker.tick(at(3));
    expect((await readChannelStatus(s.pool, [P1])).get(P1)).toMatchObject({ lastSignalAt: AT, updatedAt: AT });
    s.clock.now = at(SIGNAL_NOTE_MIN_MS / 1000);
    a.emit({ kind: 'chat', channel: P1, at: s.clock.now.toISOString(), user: ALICE, text: 'c', messageId: 'm3' });
    await s.worker.tick(s.clock.now);
    expect((await readChannelStatus(s.pool, [P1])).get(P1)).toMatchObject({ lastSignalAt: s.clock.now, updatedAt: s.clock.now });
    a.healthRows = [{ channel: P1, ok: false, lastSignalAt: null, problem: 'twitch_error' }];
    s.clock.now = at(10);
    await s.worker.tick(at(10));
    expect((await readChannelStatus(s.pool, [P1])).get(P1)).toMatchObject({ problem: 'twitch_error', updatedAt: at(10) });
  });

  it('nonBlocking runs the task once at a time and logs a rejection', async () => {
    const log = { error: vi.fn() };
    let release: () => void = () => {};
    let calls = 0;
    const fn = vi.fn(() => { calls++; return new Promise<void>((r) => { release = r; }); });
    const run = nonBlocking(fn, log, 'Test');
    await run(AT);
    await run(AT);
    expect(calls).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    await run(AT);
    expect(calls).toBe(2);
    release();
    const failing = nonBlocking(async () => { throw new Error('kaputt'); }, log, 'Test');
    await failing(AT);
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledOnce());
  });

  it('onTick runs before the bundles flush', async () => {
    const a = controllable();
    const s = await setup(a);
    const order: string[] = [];
    const w = createIngestWorker({
      adapter: a, source: { list: async () => [] }, lookup: { openGiveawaysFor: async () => { order.push('lookup'); return []; } }, rt: s.rt, pool: s.pool, workers: 1, index: 0,
      log: { error: vi.fn() }, now: () => AFTER_MINUTE, onTick: () => { order.push('tick'); },
    });
    a.emit({ kind: 'presence', channel: P3, minute: minuteOf(AT), users: [] });
    await w.tick(AFTER_MINUTE);
    expect(order).toEqual(['tick', 'lookup']);
  });

  it('stop drains pending bundles', async () => {
    const a = controllable();
    const s = await setup(a);
    a.emit({ kind: 'presence', channel: P1, minute: minuteOf(AT), users: [ALICE] });
    await s.worker.stop();
    expect(s.spy).toHaveBeenCalledTimes(2);
  });
});

describe('Ingest-Worker und Ansagen', () => {
  it('with a subscriber the worker builds an Announcer that sends on the owned channels after start and stops with the worker', async () => {
    const bus = new LocalBus();
    const s = await setupGiveaway({ publisher: bus });
    close = s.close;
    const sim = new SimulatorAdapter({ viewersPerChannel: 1, now: () => AT });
    const worker = createIngestWorker({
      adapter: sim, source: { list: async () => [{ pid: P1, twitchId: '1', watch: 'full' }] }, lookup: pgGiveawayLookup(s.pool), rt: s.rt, pool: s.pool,
      workers: 1, index: 0, log: { error: vi.fn() }, now: () => AT, subscriber: bus, publicUrl: 'https://g.example', directoryIntervalMs: 60_000, tickMs: 60_000,
    });
    expect(worker.announcer).not.toBeNull();
    await worker.start();
    await createOpen(s.rt);
    await worker.announcer!.idle();
    expect(sim.sent).toEqual([{ channel: P1, text: `Giveaway „Key“ ist offen! Mach im Portal mit. https://g.example/g/${GID}` }]);
    await worker.stop();
    await must(s.rt, s.rt.handlers.pause, { giveawayId: GID });
    await worker.announcer!.idle();
    expect(sim.sent).toHaveLength(1);
  });

  it('without a subscriber there is no announcer', async () => {
    const s = await setup(controllable());
    expect(s.worker.announcer).toBeNull();
  });
});
