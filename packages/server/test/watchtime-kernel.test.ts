import { describe, expect, it } from 'vitest';
import { FRAMEWORK_EVENTS, type KernelEvent } from '../src/kernel-api/index.js';
import { defaultConfig } from '../src/framework/kernel-config.js';
import { mulberry32 } from '../src/ingest/simulator.js';
import { coinsOf, secondsOf, watchtimeKernel, type WatchtimeState } from '../src/kernels/watchtime/index.js';

const T0 = '2026-10-15T12:00:00.000Z';
const CH1 = 'c1';
const CH2 = 'c2';
let seq = 0;
function ev(type: string, payload: unknown, at = T0): KernelEvent {
  seq += 1;
  return { id: `e${seq}`, type, payload, at, reversesEventId: null };
}
const credit = (channel: string, entries: { pid: string; sec: number }[], factor = 1) =>
  ev(FRAMEWORK_EVENTS.watchCredited, { minute: T0, channel, factor, entries });
const chat = (channel: string, entries: { pid: string; sec: number; lastAt: string }[], factor = 1) =>
  ev(FRAMEWORK_EVENTS.chatCredited, { minute: T0, channel, factor, entries });
const correct = (channel: string, entries: { pid: string; sec: number }[]) => ev(FRAMEWORK_EVENTS.watchCorrected, { channel, entries });

const config = defaultConfig(watchtimeKernel.configSchema);
const k = watchtimeKernel;
const apply = (s: WatchtimeState, events: KernelEvent[]): WatchtimeState => events.reduce((acc, e) => k.reduce(acc, e, config), s);
const fresh = (): WatchtimeState => k.initialState(config);

describe('Kern A Zuschauzeit', () => {
  it('initialState is empty', () => {
    expect(fresh()).toEqual({ sec: {}, registered: [] });
    expect(config).toEqual({ coinBaseSec: 7200 });
  });

  it('credits sec times factor per pid and channel, sums channels for coins', () => {
    const s = apply(fresh(), [credit(CH1, [{ pid: 'p1', sec: 3600 }]), credit(CH2, [{ pid: 'p1', sec: 3600 }, { pid: 'p2', sec: 60 }], 2)]);
    expect(s.sec).toEqual({ p1: { c1: 3600, c2: 7200 }, p2: { c2: 120 } });
    expect(secondsOf(s, 'p1')).toBe(10800);
    expect(coinsOf(s, config, 'p1')).toBe(1);
    expect(coinsOf(s, config, 'p2')).toBe(0);
    expect(coinsOf(s, config, 'p9')).toBe(0);
  });

  it('chat_credited adds to the same bucket', () => {
    const s = apply(fresh(), [credit(CH1, [{ pid: 'p1', sec: 60 }]), chat(CH1, [{ pid: 'p1', sec: 2, lastAt: T0 }], 3)]);
    expect(s.sec).toEqual({ p1: { c1: 66 } });
  });

  it('watch_corrected can take time away, coins never go below 0', () => {
    const s = apply(fresh(), [credit(CH1, [{ pid: 'p1', sec: 7200 }]), correct(CH1, [{ pid: 'p1', sec: -9000 }])]);
    expect(s.sec).toEqual({ p1: { c1: -1800 } });
    expect(coinsOf(s, config, 'p1')).toBe(0);
    expect(k.pool(s, config)).toEqual([]);
    const back = apply(s, [correct(CH1, [{ pid: 'p1', sec: 9000 }])]);
    expect(coinsOf(back, config, 'p1')).toBe(1);
  });

  it('pool lists everyone with at least one coin, weight = coins, sorted by pid', () => {
    const s = apply(fresh(), [
      credit(CH1, [{ pid: 'p-b', sec: 3600 }, { pid: 'p-a', sec: 3600 }, { pid: 'p-c', sec: 1799 }], 4),
      ev(FRAMEWORK_EVENTS.registered, { pid: 'p-c' }),
    ]);
    expect(k.pool(s, config)).toEqual([
      { pid: 'p-a', weight: 2 },
      { pid: 'p-b', weight: 2 },
    ]);
    expect(s.registered).toEqual(['p-c']);
  });

  it('registered pids are unique and sorted, withdrawn removes', () => {
    const s = apply(fresh(), [
      ev(FRAMEWORK_EVENTS.registered, { pid: 'p-b' }),
      ev(FRAMEWORK_EVENTS.registered, { pid: 'p-b' }),
      ev(FRAMEWORK_EVENTS.registered, { pid: 'p-a' }),
      ev(FRAMEWORK_EVENTS.withdrawn, { pid: 'p-b' }),
    ]);
    expect(s.registered).toEqual(['p-a']);
  });

  it('reduce(legacy_imported) equals the state after minute-wise watch_credited: sec per pid and channel, pool, viewerView, registered', () => {
    const minutes: KernelEvent[] = [];
    for (let i = 0; i < 60; i += 1) minutes.push(credit(CH1, [{ pid: 'p1', sec: 60 }, { pid: 'p2', sec: 30 }]));
    for (let i = 0; i < 120; i += 1) minutes.push(credit(CH2, [{ pid: 'p2', sec: 60 }]));
    minutes.push(ev(FRAMEWORK_EVENTS.registered, { pid: 'p2' }), ev(FRAMEWORK_EVENTS.registered, { pid: 'p1' }));
    const booked = apply(fresh(), minutes);
    const imported = apply(fresh(), [
      ev(FRAMEWORK_EVENTS.legacyImported, {
        legacySessionId: 'sess_1', status: 'paused', terms: null, registered: ['p2', 'p1'],
        entries: [{ pid: 'p1', channel: CH1, sec: 3600 }, { pid: 'p2', channel: CH1, sec: 1800 }, { pid: 'p2', channel: CH2, sec: 7200 }],
      }),
    ]);
    expect(imported).toEqual(booked);
    expect(k.pool(imported, config)).toEqual(k.pool(booked, config));
    expect(k.pool(imported, config)).toEqual([{ pid: 'p2', weight: 1 }]);
    expect(k.viewerView(imported, 'p2', config)).toEqual(k.viewerView(booked, 'p2', config));
    expect(k.reduce(imported, ev(FRAMEWORK_EVENTS.legacyImported, { entries: 'x' }), config)).toBe(imported);
    expect(k.reduce(imported, ev(FRAMEWORK_EVENTS.legacyImported, null), config)).toBe(imported);
  });

  it('unknown events and malformed payloads leave the state unchanged', () => {
    const s = apply(fresh(), [credit(CH1, [{ pid: 'p1', sec: 60 }])]);
    expect(k.reduce(s, ev('watchtime_other', {}), config)).toBe(s);
    expect(k.reduce(s, ev(FRAMEWORK_EVENTS.watchCredited, null), config)).toBe(s);
    expect(k.reduce(s, ev(FRAMEWORK_EVENTS.watchCredited, { channel: CH1, factor: 1, entries: 'x' }), config)).toBe(s);
  });

  it('viewerView shows total time, coins and time to the next coin', () => {
    const s = apply(fresh(), [credit(CH1, [{ pid: 'p1', sec: 3600 }]), credit(CH2, [{ pid: 'p1', sec: 1800 }]), ev(FRAMEWORK_EVENTS.registered, { pid: 'p1' })]);
    expect(k.viewerView(s, 'p1', config)).toEqual({
      registered: true,
      inPool: false,
      weight: 0,
      lines: [
        { label: 'Zuschauzeit', value: '1 h 30 min' },
        { label: 'Coins', value: '0' },
        { label: 'Bis zum nächsten Coin', value: '30 min' },
      ],
    });
    const two = apply(s, [credit(CH1, [{ pid: 'p1', sec: 1800 }])]);
    expect(k.viewerView(two, 'p1', config)).toMatchObject({ inPool: true, weight: 1, lines: [{ label: 'Zuschauzeit', value: '2 h' }, { label: 'Coins', value: '1' }, { label: 'Bis zum nächsten Coin', value: '2 h' }] });
    expect(k.viewerView(two, 'p9', config)).toEqual({ registered: false, inPool: false, weight: 0, lines: [{ label: 'Zuschauzeit', value: '0 min' }, { label: 'Coins', value: '0' }, { label: 'Bis zum nächsten Coin', value: '2 h' }] });
  });

  it('property: weights are non-negative integers and pool is deterministic', () => {
    for (const seed of [1, 7, 42, 99, 123, 2024, 31337, 65535]) {
      const rng = mulberry32(seed);
      const pick = (n: number) => Math.floor(rng() * n);
      const events: KernelEvent[] = [];
      for (let i = 0; i < 200; i += 1) {
        const pid = `p-${pick(12)}`;
        const ch = pick(2) === 0 ? CH1 : CH2;
        const kind = pick(5);
        events.push(
          kind === 0 ? correct(ch, [{ pid, sec: pick(2) === 0 ? -pick(20000) - 1 : pick(20000) + 1 }])
          : kind === 1 ? chat(ch, [{ pid, sec: pick(10) + 1, lastAt: T0 }], pick(3) + 1)
          : kind === 2 ? ev(FRAMEWORK_EVENTS.registered, { pid })
          : credit(ch, [{ pid, sec: pick(3600) + 1 }], pick(3) + 1),
        );
      }
      const a = k.pool(apply(fresh(), events), config);
      const b = k.pool(apply(fresh(), events), config);
      expect(a).toEqual(b);
      expect(a.map((e) => e.pid)).toEqual([...a.map((e) => e.pid)].sort());
      for (const e of a) {
        expect(Number.isInteger(e.weight)).toBe(true);
        expect(e.weight).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('declares the fixed contract fields', () => {
    expect(k.id).toBe('watchtime');
    expect(k.version).toBe(1);
    expect(k.label).toBe('Zuschauzeit + Follow');
    expect(k.drawMode).toBe('weighted');
    expect(k.supportedGates).toEqual(['follow', 'account_age', 'follow_age', 'presence']);
    expect(k.usesServices).toEqual(['watchtime', 'chatBonus', 'boost', 'registration']);
    expect(k.events).toEqual([]);
    expect(k.commands).toEqual([]);
    expect(k.configSchema.coinBaseSec).toEqual({
      kind: 'int', label: 'Coin-Basis', help: 'So viel Zuschauzeit ergibt einen Coin.', default: 7200, min: 60, max: 360000, unit: 'sec',
    });
    expect(k.display).toEqual({
      icon: '⏱', unit: 'Coins', beta: true, emptyPool: 'Niemand hat genug Zuschauzeit für einen Coin.',
      columns: [{ key: 'watch', label: 'Zuschauzeit' }, { key: 'coins', label: 'Coins' }],
    });
  });
});
