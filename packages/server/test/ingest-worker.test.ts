import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import type { ApplySignalsCmd } from '../src/framework/giveaway/signals.js';
import { BUNDLE_GRACE_MS, minuteOf } from '../src/ingest/bundler.js';
import { readChannelStatus } from '../src/ingest/channel-status.js';
import type { ChannelSource } from '../src/ingest/directory.js';
import { pgGiveawayLookup } from '../src/ingest/dispatch.js';
import type { AdapterHealth, IngestAdapter, Signal, SignalUser } from '../src/ingest/signals.js';
import { SimulatorAdapter } from '../src/ingest/simulator.js';
import { createIngestWorker } from '../src/ingest/worker.js';
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
