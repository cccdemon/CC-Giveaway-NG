import { describe, expect, it } from 'vitest';
import type { ChannelRef, Signal } from '../src/ingest/signals.js';
import { SimulatorAdapter, mulberry32 } from '../src/ingest/simulator.js';
import { AT } from './helpers/db.js';

const P1 = '77777777-7777-4777-8777-777777777777';
const P2 = '88888888-8888-4888-8888-888888888888';
const full: ChannelRef = { pid: P1, twitchId: '1', watch: 'full', owned: true };
const stateOnly: ChannelRef = { pid: P2, twitchId: '2', watch: 'state', owned: true };
const at = (sec: number) => new Date(AT.getTime() + sec * 1000);

async function started(refs: ChannelRef[], opts = {}) {
  const sim = new SimulatorAdapter({ viewersPerChannel: 10, seed: 7, chatEveryMs: 4_000, now: () => AT, ...opts });
  const signals: Signal[] = [];
  sim.onSignal((s) => signals.push(s));
  await sim.start(refs);
  return { sim, signals };
}

describe('SimulatorAdapter', () => {
  it('mulberry32 is deterministic in [0, 1)', () => {
    const a = mulberry32(1), b = mulberry32(1);
    const xs = Array.from({ length: 5 }, () => a());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('start emits stream_state live, stop emits offline', async () => {
    const { sim, signals } = await started([full]);
    expect(signals).toEqual([{ kind: 'stream_state', channel: P1, at: expect.any(String), live: true, viewers: 10 }]);
    await sim.stop(full);
    expect(signals[1]).toMatchObject({ kind: 'stream_state', channel: P1, live: false });
    expect(sim.channels()).toEqual([]);
  });

  it('emits presence once per minute with 80–100 % of the viewers, deterministic by seed', async () => {
    const { sim, signals } = await started([full]);
    sim.tick(at(0));
    sim.tick(at(1));
    sim.tick(at(60));
    const presence = signals.filter((s) => s.kind === 'presence');
    expect(presence).toHaveLength(2);
    expect(presence.map((p) => p.kind === 'presence' && p.minute)).toEqual([AT.toISOString(), at(60).toISOString()]);
    for (const p of presence) {
      if (p.kind !== 'presence') continue;
      expect(p.users.length).toBeGreaterThanOrEqual(8);
      expect(p.users.length).toBeLessThanOrEqual(10);
      expect(p.users[0]).toMatchObject({ id: expect.stringMatching(/^sim-\d+$/), login: expect.stringMatching(/^sim\d+$/), displayName: expect.stringMatching(/^Sim \d+$/) });
    }
    const other = await started([full]);
    other.sim.tick(at(0));
    other.sim.tick(at(1));
    other.sim.tick(at(60));
    expect(other.signals).toEqual(signals);
  });

  it('emits chat every chatEveryMs with a message id and a user from the channel', async () => {
    const { sim, signals } = await started([full]);
    for (let s = 0; s <= 12; s++) sim.tick(at(s));
    const chat = signals.filter((s) => s.kind === 'chat');
    expect(chat).toHaveLength(3);
    for (const c of chat) {
      if (c.kind !== 'chat') continue;
      expect(c.channel).toBe(P1);
      expect(c.messageId).toMatch(/^sim-\d+$/);
      expect(c.user.id).toMatch(/^sim-\d+$/);
      expect(c.text.length).toBeGreaterThan(0);
    }
    expect(new Set(chat.map((c) => c.kind === 'chat' && c.messageId)).size).toBe(3);
  });

  it('emits a follow every followEveryMs', async () => {
    const { sim, signals } = await started([full], { followEveryMs: 10_000 });
    for (let s = 0; s <= 20; s++) sim.tick(at(s));
    expect(signals.filter((s) => s.kind === 'follow')).toHaveLength(2);
  });

  it('state-only channels get no presence or chat, only stream_state every minute', async () => {
    const { sim, signals } = await started([stateOnly]);
    for (let s = 0; s <= 120; s++) sim.tick(at(s));
    const kinds = new Set(signals.map((s) => s.kind));
    expect(kinds).toEqual(new Set(['stream_state']));
    expect(signals).toHaveLength(3); // start, 60 s, 120 s
  });

  it('ignores channels that are not owned', async () => {
    const { sim, signals } = await started([{ ...full, owned: false }]);
    sim.tick(at(0));
    expect(signals).toEqual([]);
    expect(sim.channels()).toEqual([]);
  });

  it('inject passes a signal through to the handler unchanged', async () => {
    const { sim, signals } = await started([]);
    const s: Signal = { kind: 'follow', channel: P1, at: AT.toISOString(), user: { id: '1', login: 'a', displayName: 'A' } };
    sim.inject(s);
    expect(signals).toEqual([s]);
  });

  it('sendChat records the message, checkFollows says yes, health is ok', async () => {
    const { sim } = await started([full]);
    expect(await sim.sendChat(full, 'Hallo')).toEqual({ ok: true, messageId: 'sim-sent-1' });
    expect(sim.sent).toEqual([{ channel: P1, text: 'Hallo' }]);
    expect(await sim.checkFollows(full, ['sim-1', 'sim-2'])).toEqual([
      { userId: 'sim-1', follows: true, since: '2026-01-01T00:00:00.000Z' },
      { userId: 'sim-2', follows: true, since: '2026-01-01T00:00:00.000Z' },
    ]);
    sim.tick(at(3));
    expect(sim.health()).toEqual([{ channel: P1, ok: true, lastSignalAt: at(3).toISOString(), problem: null }]);
    await sim.close();
    expect(sim.channels()).toEqual([]);
  });
});
