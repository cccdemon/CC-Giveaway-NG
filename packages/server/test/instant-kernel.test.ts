import { describe, expect, it } from 'vitest';
import { FRAMEWORK_EVENTS, isRejection, type KernelEvent, type NewKernelEvent, type Rejection } from '../src/kernel-api/index.js';
import { defaultConfig } from '../src/framework/kernel-config.js';
import { INSTANT_EVENTS, instantKernel, type InstantState } from '../src/kernels/instant/index.js';

const T0 = '2026-10-15T12:00:00.000Z';
const plus = (sec: number): string => new Date(Date.parse(T0) + sec * 1000).toISOString();
let seq = 0;
function ev(type: string, payload: unknown, at = T0): KernelEvent {
  seq += 1;
  return { id: `e${seq}`, type, payload, at, reversesEventId: null };
}

const config = defaultConfig(instantKernel.configSchema);
const k = instantKernel;
const decide = k.decide!;
const apply = (s: InstantState, events: KernelEvent[]): InstantState => events.reduce((acc, e) => k.reduce(acc, e, config), s);
const fresh = (): InstantState => k.initialState(config);
const opened = (until = plus(120)): InstantState => apply(fresh(), [ev(INSTANT_EVENTS.windowOpened, { until })]);

function code(r: NewKernelEvent[] | Rejection | null): string | null {
  return r && isRejection(r) ? r.code : null;
}

describe('Kern B Sofortverlosung', () => {
  it('initialState', () => {
    expect(fresh()).toEqual({ registered: [], window: null, windowsOpened: 0 });
  });

  it('registered pids are unique and sorted', () => {
    const s0 = fresh();
    const s = apply(s0, [
      ev(FRAMEWORK_EVENTS.registered, { pid: 'p-b' }),
      ev(FRAMEWORK_EVENTS.registered, { pid: 'p-b' }),
      ev(FRAMEWORK_EVENTS.registered, { pid: 'p-a' }),
    ]);
    expect(s.registered).toEqual(['p-a', 'p-b']);
    expect(s0.registered).toEqual([]);
    const w = apply(s, [ev(FRAMEWORK_EVENTS.withdrawn, { pid: 'p-a' })]);
    expect(w.registered).toEqual(['p-b']);
    expect(s.registered).toEqual(['p-a', 'p-b']);
  });

  it('unknown event types leave the state unchanged', () => {
    const s = opened();
    expect(k.reduce(s, ev('instant_other', {}), config)).toEqual(s);
  });

  it('open_window uses config or args', () => {
    expect(decide(fresh(), { type: 'open_window', args: {} }, config, T0)).toEqual([
      { type: 'instant_window_opened', payload: { until: plus(120) } },
    ]);
    expect(decide(fresh(), { type: 'open_window', args: { windowSec: 30 } }, config, T0)).toEqual([
      { type: 'instant_window_opened', payload: { until: plus(30) } },
    ]);
    const bad = decide(fresh(), { type: 'open_window', args: { windowSec: 5 } }, config, T0);
    expect(bad).toEqual({ rejected: true, code: 'invalid_window', message: 'Die Fensterlänge muss zwischen 10 und 3600 Sekunden liegen.' });
    const open = decide(opened(), { type: 'open_window', args: {} }, config, T0);
    expect(open).toEqual({ rejected: true, code: 'window_open', message: 'Ein Anmeldefenster ist schon offen. Schließe es zuerst.' });
  });

  it('unknown command is rejected', () => {
    expect(decide(fresh(), { type: 'nope', args: {} }, config, T0)).toEqual({
      rejected: true,
      code: 'unknown_command',
      message: 'Diesen Befehl kennt die Sofortverlosung nicht.',
    });
  });

  it('close_window is a no-op without window', () => {
    expect(decide(fresh(), { type: 'close_window', args: {} }, config, T0)).toEqual([]);
    expect(decide(opened(), { type: 'close_window', args: {} }, config, T0)).toEqual([
      { type: 'instant_window_closed', payload: {} },
    ]);
  });

  it('gateRegistration', () => {
    const gate = k.gateRegistration!;
    expect(gate(fresh(), config, T0)).toEqual({
      rejected: true,
      code: 'window_closed',
      message: 'Das Anmeldefenster ist zu. Warte auf das nächste Fenster.',
    });
    expect(gate(opened(), config, plus(60))).toBeNull();
    expect(code(gate(opened(), config, plus(120)))).toBe('window_closed');
  });

  it('timers follow the window', () => {
    expect(k.timers!(opened(), config)).toEqual([
      { key: 'window_end', dueAt: plus(120), command: { type: 'close_window', args: {} } },
    ]);
    const closed = apply(opened(), [ev(INSTANT_EVENTS.windowClosed, {})]);
    expect(k.timers!(closed, config)).toEqual([]);
  });

  it('pool weighs everyone 1 and participants accumulate across windows', () => {
    const s = apply(fresh(), [
      ev(INSTANT_EVENTS.windowOpened, { until: plus(120) }),
      ev(FRAMEWORK_EVENTS.registered, { pid: 'p-1' }, plus(10)),
      ev(INSTANT_EVENTS.windowClosed, {}, plus(120)),
      ev(INSTANT_EVENTS.windowOpened, { until: plus(400) }, plus(200)),
      ev(FRAMEWORK_EVENTS.registered, { pid: 'p-2' }, plus(210)),
    ]);
    expect(s.windowsOpened).toBe(2);
    expect(k.pool(s, config)).toEqual([
      { pid: 'p-1', weight: 1 },
      { pid: 'p-2', weight: 1 },
    ]);
  });

  it('viewerView shows window and pool state', () => {
    const s = apply(opened(), [ev(FRAMEWORK_EVENTS.registered, { pid: 'p-1' })]);
    expect(k.viewerView(s, 'p-1', config)).toEqual({
      registered: true,
      inPool: true,
      weight: 1,
      lines: [{ label: 'Anmeldefenster', value: `offen bis ${plus(120)}` }],
    });
    const closed = apply(s, [ev(INSTANT_EVENTS.windowClosed, {})]);
    expect(k.viewerView(closed, 'p-2', config)).toEqual({
      registered: false,
      inPool: false,
      weight: 0,
      lines: [{ label: 'Anmeldefenster', value: 'geschlossen' }],
    });
  });

  it('declares the fixed contract fields', () => {
    expect(k.id).toBe('instant');
    expect(k.version).toBe(1);
    expect(k.label).toBe('Sofortverlosung');
    expect(k.drawMode).toBe('equal');
    expect(k.supportedGates).toEqual(['follow', 'account_age']);
    expect(k.usesServices).toEqual(['registration']);
    expect(k.configSchema.windowSec).toEqual({
      kind: 'int', label: 'Fensterlänge', help: 'So lange ist das Anmeldefenster offen.', default: 120, min: 10, max: 3600, unit: 'sec',
    });
    expect(k.commands).toEqual([
      { type: 'open_window', label: 'Anmeldefenster öffnen', issuer: 'streamer' },
      { type: 'close_window', label: 'Anmeldefenster schließen', issuer: 'scheduler' },
    ]);
    expect(k.display).toEqual({
      icon: '⚡', unit: null, beta: true, emptyPool: 'Niemand hat sich im Anmeldefenster angemeldet.', columns: [{ key: 'registered', label: 'Angemeldet' }],
    });
  });

  it('event checks', () => {
    const open = k.events.find((e) => e.type === INSTANT_EVENTS.windowOpened)!;
    const close = k.events.find((e) => e.type === INSTANT_EVENTS.windowClosed)!;
    expect(open.version).toBe(1);
    expect(close.version).toBe(1);
    expect(open.check({ until: T0 })).toBeNull();
    expect(open.check({ until: 'gestern' })).not.toBeNull();
    expect(open.check({})).not.toBeNull();
    expect(open.check(null)).not.toBeNull();
    expect(close.check({})).toBeNull();
    expect(close.reversal).toEqual({ kind: 'none', why: 'Ein geschlossenes Fenster bleibt zu. Öffne ein neues Fenster.' });
  });

  it('reversal of window_opened is window_closed', () => {
    const def = k.events.find((e) => e.type === INSTANT_EVENTS.windowOpened)!;
    expect(def.reversal.kind).toBe('compensate');
    if (def.reversal.kind !== 'compensate') return;
    expect(def.reversal.inverse({ until: plus(120) })).toEqual({ type: 'instant_window_closed', payload: {} });
  });

  it('property: pool deterministic, weights >= 0, registered sorted and unique', () => {
    const seeds = [1, 7, 42, 99, 123, 256, 777, 1001, 2024, 3141, 4242, 5555, 6789, 8080, 9001, 10007, 31337, 65535, 99991, 123457];
    expect(seeds).toHaveLength(20);
    for (const seed of seeds) {
      let x = seed;
      const next = (n: number): number => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return x % n;
      };
      let s = fresh();
      for (let i = 0; i < 40; i += 1) {
        const pid = `p-${next(8)}`;
        const at = plus(i * 10);
        const pick = next(4);
        const e =
          pick === 0 ? ev(FRAMEWORK_EVENTS.registered, { pid }, at)
          : pick === 1 ? ev(FRAMEWORK_EVENTS.withdrawn, { pid }, at)
          : pick === 2 ? ev(INSTANT_EVENTS.windowOpened, { until: plus(i * 10 + 60) }, at)
          : ev(INSTANT_EVENTS.windowClosed, {}, at);
        s = k.reduce(s, e, config);
        const sorted = [...new Set(s.registered)].sort();
        expect(s.registered).toEqual(sorted);
        const pool = k.pool(s, config);
        expect(k.pool(structuredClone(s), config)).toEqual(pool);
        expect(pool.every((p) => p.weight >= 0)).toBe(true);
      }
    }
  });
});
