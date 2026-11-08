import { describe, expect, it } from 'vitest';
import { FRAMEWORK_EVENTS, isRejection, type KernelEvent, type NewKernelEvent } from '../src/kernel-api/index.js';
import { defaultConfig } from '../src/framework/kernel-config.js';
import { mulberry32 } from '../src/ingest/simulator.js';
import {
  BUY_TICKETS,
  TICKETS_EVENTS,
  coinsAvailable,
  coinsEarned,
  ticketsKernel,
  ticketsOf,
  type TicketPayload,
  type TicketsConfig,
  type TicketsState,
} from '../src/kernels/tickets/index.js';

const T0 = '2026-10-15T12:00:00.000Z';
const CH1 = 'c1';
let seq = 0;
function ev(type: string, payload: unknown, at = T0): KernelEvent {
  seq += 1;
  return { id: `e${seq}`, type, payload, at, reversesEventId: null };
}
const credit = (entries: { pid: string; sec: number }[], factor = 1) => ev(FRAMEWORK_EVENTS.watchCredited, { minute: T0, channel: CH1, factor, entries });
const chat = (entries: { pid: string; sec: number }[], factor = 1) =>
  ev(FRAMEWORK_EVENTS.chatCredited, { minute: T0, channel: CH1, factor, entries: entries.map((e) => ({ ...e, lastAt: T0 })) });
const correct = (entries: { pid: string; sec: number }[]) => ev(FRAMEWORK_EVENTS.watchCorrected, { channel: CH1, entries });
const reg = (pid: string) => ev(FRAMEWORK_EVENTS.registered, { pid });
const bought = (pid: string, count: number, coins: number) => ev(TICKETS_EVENTS.bought, { pid, count, coins });
const refunded = (pid: string, count: number, coins: number) => ev(TICKETS_EVENTS.refunded, { pid, count, coins });
/** Erstattung als Umkehrung eines Kaufs, wie sie revert oder cancel schreiben. */
const refundOf = (b: KernelEvent): KernelEvent => ({ ...ev(TICKETS_EVENTS.refunded, b.payload), reversesEventId: b.id });

const k = ticketsKernel;
/** Coin-Basis 60 s, damit eine Minute ein Coin ist. */
const config: TicketsConfig = { ...defaultConfig(k.configSchema), coinBaseSec: 60 };
const apply = (s: TicketsState, events: KernelEvent[], c = config): TicketsState => events.reduce((acc, e) => k.reduce(acc, e, c), s);
const fresh = (): TicketsState => k.initialState(config);
const buy = (s: TicketsState, pid: string | undefined, args: Record<string, unknown> = {}, c = config) => k.decide!(s, { type: BUY_TICKETS, ...(pid === undefined ? {} : { pid }), args }, c, T0);
const boughtDef = () => k.events.find((d) => d.type === TICKETS_EVENTS.bought)!;
const refundedDef = () => k.events.find((d) => d.type === TICKETS_EVENTS.refunded)!;

describe('Kern C Ticketkauf', () => {
  it('initialState is empty, defaults are 7200 / 1 / 0', () => {
    expect(fresh()).toEqual({ sec: {}, spent: {}, tickets: {}, registered: [], purchases: [] });
    expect(defaultConfig(k.configSchema)).toEqual({ coinBaseSec: 7200, ticketPriceCoins: 1, maxTicketsPerPerson: 0 });
  });

  it('credits fill the wallet: coinsEarned floors, chat_credited and factor count, watch_corrected subtracts', () => {
    const s = apply(fresh(), [credit([{ pid: 'p1', sec: 119 }])]);
    expect(coinsEarned(s, config, 'p1')).toBe(1);
    const more = apply(s, [credit([{ pid: 'p1', sec: 1 }]), chat([{ pid: 'p1', sec: 30 }], 2)]);
    expect(more.sec).toEqual({ p1: 180 });
    expect(coinsEarned(more, config, 'p1')).toBe(3);
    const less = apply(more, [correct([{ pid: 'p1', sec: -60 }])]);
    expect(coinsEarned(less, config, 'p1')).toBe(2);
    expect(coinsEarned(less, config, 'p9')).toBe(0);
    expect(coinsAvailable(less, config, 'p1')).toBe(2);
  });

  it('buy_tickets writes tickets_bought with coins = count × price, reduce moves coins to spent and tickets', () => {
    const price2 = { ...config, ticketPriceCoins: 2 };
    const s = apply(fresh(), [reg('p1'), credit([{ pid: 'p1', sec: 300 }])]);
    const out = buy(s, 'p1', { count: 2 }, price2);
    expect(out).toEqual([{ type: TICKETS_EVENTS.bought, payload: { pid: 'p1', count: 2, coins: 4 } }]);
    const after = apply(s, [bought('p1', 2, 4)], price2);
    expect(ticketsOf(after, 'p1')).toBe(2);
    expect(after.spent).toEqual({ p1: 4 });
    expect(coinsAvailable(after, price2, 'p1')).toBe(1);
  });

  it('buy_tickets: count default 1, rejects invalid_count, unknown_command, pid_required', () => {
    const s = apply(fresh(), [reg('p1'), credit([{ pid: 'p1', sec: 600 }])]);
    expect(buy(s, 'p1')).toEqual([{ type: TICKETS_EVENTS.bought, payload: { pid: 'p1', count: 1, coins: 1 } }]);
    for (const count of [0, 1.5, 10001, 'x', -1]) {
      expect(buy(s, 'p1', { count })).toEqual({ rejected: true, code: 'invalid_count', message: 'Gib eine ganze Zahl von 1 bis 10000 Tickets an.' });
    }
    expect(buy(s, 'p1', { count: 10000 })).toEqual({ rejected: true, code: 'not_enough_coins', message: 'Dir fehlen 9990 Coins für 10000 Tickets.' });
    expect(k.decide!(s, { type: 'sell', pid: 'p1', args: {} }, config, T0)).toEqual({ rejected: true, code: 'unknown_command', message: 'Diesen Befehl kennt der Ticketkauf nicht.' });
    expect(buy(s, undefined)).toEqual({ rejected: true, code: 'pid_required', message: 'Der Befehl braucht eine Teilnehmer-ID.' });
  });

  it('buy_tickets rejects not_registered before coins are checked', () => {
    const rich = apply(fresh(), [credit([{ pid: 'p1', sec: 300 }])]);
    const expected = { rejected: true, code: 'not_registered', message: 'Melde dich erst an, dann kaufe Tickets.' };
    expect(buy(rich, 'p1')).toEqual(expected);
    expect(buy(fresh(), 'p1')).toEqual(expected);
  });

  it('buy_tickets rejects ticket_limit with exact text and allows up to the limit; 0 means no limit', () => {
    const max2 = { ...config, maxTicketsPerPerson: 2 };
    const s = apply(fresh(), [reg('p1'), credit([{ pid: 'p1', sec: 600 }])]);
    expect(buy(s, 'p1', { count: 3 }, max2)).toEqual({ rejected: true, code: 'ticket_limit', message: 'Höchstens 2 Tickets je Person. Du hast 0.' });
    expect(buy(s, 'p1', { count: 2 }, max2)).toEqual([{ type: TICKETS_EVENTS.bought, payload: { pid: 'p1', count: 2, coins: 2 } }]);
    const full = apply(s, [bought('p1', 2, 2)], max2);
    expect(buy(full, 'p1', {}, max2)).toEqual({ rejected: true, code: 'ticket_limit', message: 'Höchstens 2 Tickets je Person. Du hast 2.' });
    expect(buy(s, 'p1', { count: 10 })).toEqual([{ type: TICKETS_EVENTS.bought, payload: { pid: 'p1', count: 10, coins: 10 } }]);
  });

  it('buy_tickets rejects not_enough_coins with the missing coins in the text', () => {
    const price2 = { ...config, ticketPriceCoins: 2 };
    const s = apply(fresh(), [reg('p1'), credit([{ pid: 'p1', sec: 180 }])]);
    expect(buy(s, 'p1', { count: 2 }, price2)).toEqual({ rejected: true, code: 'not_enough_coins', message: 'Dir fehlen 1 Coins für 2 Tickets.' });
    expect(buy(s, 'p1', { count: 1 }, price2)).toEqual([{ type: TICKETS_EVENTS.bought, payload: { pid: 'p1', count: 1, coins: 2 } }]);
  });

  it('negative correction after a purchase keeps tickets, coinsAvailable < 0, next buy rejected, viewerView shows Coins 0', () => {
    const s = apply(fresh(), [reg('p1'), credit([{ pid: 'p1', sec: 120 }]), bought('p1', 2, 2), correct([{ pid: 'p1', sec: -120 }])]);
    expect(coinsEarned(s, config, 'p1')).toBe(0);
    expect(coinsAvailable(s, config, 'p1')).toBe(-2);
    expect(k.pool(s, config)).toEqual([{ pid: 'p1', weight: 2 }]);
    expect(buy(s, 'p1')).toEqual({ rejected: true, code: 'not_enough_coins', message: 'Dir fehlen 3 Coins für 1 Tickets.' });
    expect(k.viewerView(s, 'p1', config)).toEqual({
      registered: true,
      inPool: true,
      weight: 2,
      lines: [
        { label: 'Zuschauzeit', value: '0 min' },
        { label: 'Coins', value: '0' },
        { label: 'Tickets', value: '2' },
      ],
    });
  });

  it('price change: later purchase pays the new price, spent keeps what was paid, inverse refunds the paid price', () => {
    const s = apply(fresh(), [reg('p1'), credit([{ pid: 'p1', sec: 600 }])]);
    const first = buy(s, 'p1') as NewKernelEvent[];
    expect(first[0]!.payload).toEqual({ pid: 'p1', count: 1, coins: 1 });
    const price3 = { ...config, ticketPriceCoins: 3 };
    const s1 = apply(s, [bought('p1', 1, 1)], price3);
    const second = buy(s1, 'p1', {}, price3) as NewKernelEvent[];
    expect(second[0]!.payload).toEqual({ pid: 'p1', count: 1, coins: 3 });
    const s2 = apply(s1, [bought('p1', 1, 3)], price3);
    expect(s2.spent).toEqual({ p1: 4 });
    expect(coinsAvailable(s2, price3, 'p1')).toBe(6);
    const def = boughtDef();
    expect(def.reversal.kind).toBe('compensate');
    if (def.reversal.kind !== 'compensate') return;
    expect(def.reversal.inverse(first[0]!.payload, s2)).toEqual({ type: TICKETS_EVENTS.refunded, payload: { pid: 'p1', count: 1, coins: 1 } });
  });

  it('inverse of tickets_bought rejects not_enough_tickets after a full refund', () => {
    const def = boughtDef();
    if (def.reversal.kind !== 'compensate') throw new Error('compensate erwartet');
    const payload: TicketPayload = { pid: 'p1', count: 2, coins: 2 };
    const s = apply(fresh(), [reg('p1'), credit([{ pid: 'p1', sec: 120 }]), bought('p1', 2, 2)]);
    expect(def.reversal.inverse(payload, s)).toEqual({ type: TICKETS_EVENTS.refunded, payload });
    const after = apply(s, [refunded('p1', 2, 2)]);
    expect(ticketsOf(after, 'p1')).toBe(0);
    expect(coinsAvailable(after, config, 'p1')).toBe(2);
    expect(def.reversal.inverse(payload, after)).toEqual({ rejected: true, code: 'not_enough_tickets', message: 'Diese Tickets sind schon erstattet.' });
  });

  it('tickets_refunded reduce clamps at 0 and is declared none', () => {
    const s = apply(fresh(), [bought('p1', 2, 2), refunded('p1', 5, 5)]);
    expect(s.tickets).toEqual({ p1: 0 });
    expect(s.spent).toEqual({ p1: 0 });
    expect(refundedDef().reversal).toEqual({ kind: 'none', why: 'Eine Erstattung bleibt. Kaufe die Tickets neu.' });
  });

  it('reduce tracks open purchases by event id; a refund that reverses a purchase removes it', () => {
    const b1 = bought('p-b', 2, 2);
    const b2 = bought('p-a', 1, 3);
    const s = apply(fresh(), [b1, b2]);
    expect(s.purchases).toEqual([
      { eventId: b1.id, pid: 'p-b', count: 2, coins: 2 },
      { eventId: b2.id, pid: 'p-a', count: 1, coins: 3 },
    ]);
    const r = apply(s, [refundOf(b1)]);
    expect(r.purchases).toEqual([{ eventId: b2.id, pid: 'p-a', count: 1, coins: 3 }]);
    expect(r.tickets).toEqual({ 'p-b': 0, 'p-a': 1 });
    // Eine Erstattung ohne Bezug bucht nur Tickets und Coins, die Liste bleibt (defensiv).
    const loose = apply(s, [refunded('p-a', 1, 3)]);
    expect(loose.purchases).toHaveLength(2);
    expect(loose.tickets['p-a']).toBe(0);
  });

  it('onCancel refunds every open purchase in journal order with reversesEventId, empty without purchases', () => {
    const b1 = bought('p-b', 2, 2);
    const b2 = bought('p-a', 1, 3);
    const b3 = bought('p-c', 1, 1);
    const s = apply(fresh(), [b1, b2, b3, refundOf(b3)]);
    expect(k.onCancel!(s, config)).toEqual([
      { type: TICKETS_EVENTS.refunded, payload: { pid: 'p-b', count: 2, coins: 2 }, reversesEventId: b1.id },
      { type: TICKETS_EVENTS.refunded, payload: { pid: 'p-a', count: 1, coins: 3 }, reversesEventId: b2.id },
    ]);
    expect(k.onCancel!(fresh(), config)).toEqual([]);
    const after = apply(s, k.onCancel!(s, config).map((e) => ({ ...ev(e.type, e.payload), reversesEventId: e.reversesEventId ?? null })));
    expect(after.tickets).toEqual({ 'p-a': 0, 'p-b': 0, 'p-c': 0 });
    expect(after.purchases).toEqual([]);
    expect(k.onCancel!(after, config)).toEqual([]);
  });

  it('pool lists holders with weight = tickets sorted by pid; viewerView lines Zuschauzeit, Coins, Tickets', () => {
    const s = apply(fresh(), [reg('p-b'), credit([{ pid: 'p-b', sec: 5400 }, { pid: 'p-a', sec: 60 }]), bought('p-b', 3, 3), bought('p-a', 1, 1)]);
    expect(k.pool(s, config)).toEqual([
      { pid: 'p-a', weight: 1 },
      { pid: 'p-b', weight: 3 },
    ]);
    expect(k.viewerView(s, 'p-b', config)).toEqual({
      registered: true,
      inPool: true,
      weight: 3,
      lines: [
        { label: 'Zuschauzeit', value: '1 h 30 min' },
        { label: 'Coins', value: '87' },
        { label: 'Tickets', value: '3' },
      ],
    });
    expect(k.viewerView(s, 'p9', config)).toEqual({ registered: false, inPool: false, weight: 0, lines: [{ label: 'Zuschauzeit', value: '0 min' }, { label: 'Coins', value: '0' }, { label: 'Tickets', value: '0' }] });
  });

  it('registered pids are unique and sorted, withdrawn removes', () => {
    const s = apply(fresh(), [reg('p-b'), reg('p-b'), reg('p-a'), ev(FRAMEWORK_EVENTS.withdrawn, { pid: 'p-b' })]);
    expect(s.registered).toEqual(['p-a']);
  });

  it('unknown events and malformed payloads leave the state object unchanged', () => {
    const s = apply(fresh(), [credit([{ pid: 'p1', sec: 60 }])]);
    expect(k.reduce(s, ev('tickets_other', {}), config)).toBe(s);
    expect(k.reduce(s, ev(TICKETS_EVENTS.bought, null), config)).toBe(s);
    expect(k.reduce(s, ev(TICKETS_EVENTS.bought, { pid: 'p1', count: 'x', coins: 1 }), config)).toBe(s);
    expect(k.reduce(s, ev(FRAMEWORK_EVENTS.watchCredited, { channel: CH1, factor: 1, entries: 'x' }), config)).toBe(s);
    expect(boughtDef().check({ pid: 'p1', count: 1, coins: 1 })).toBeNull();
    expect(boughtDef().check({ pid: 'p1', count: 0, coins: 1 })).toBe('pid, count und coins müssen gesetzt und gültig sein.');
    expect(refundedDef().check({})).toBe('pid, count und coins müssen gesetzt und gültig sein.');
  });

  it('property: weights are positive integers, pool is deterministic, a purchase never exceeds the available coins', () => {
    for (const seed of [1, 7, 42, 99, 123, 2024, 31337, 65535]) {
      const rng = mulberry32(seed);
      const pick = (n: number) => Math.floor(rng() * n);
      const c = { ...config, ticketPriceCoins: pick(3) + 1, maxTicketsPerPerson: pick(2) === 0 ? 0 : pick(5) + 1 };
      const events: KernelEvent[] = [];
      let s = k.initialState(c);
      for (let i = 0; i < 300; i += 1) {
        const pid = `p-${pick(8)}`;
        const kind = pick(6);
        let e: KernelEvent | null = null;
        if (kind === 0) e = correct([{ pid, sec: pick(2) === 0 ? -pick(600) - 1 : pick(600) + 1 }]);
        else if (kind === 1) e = reg(pid);
        else if (kind === 2) {
          const out = buy(s, pid, { count: pick(4) + 1 }, c);
          if (!isRejection(out)) {
            const p = out[0]!.payload as TicketPayload;
            expect(coinsAvailable(s, c, pid)).toBeGreaterThanOrEqual(p.coins);
            e = ev(out[0]!.type, p);
          }
        } else if (kind === 3) {
          const have = ticketsOf(s, pid);
          if (have > 0) e = refunded(pid, 1, (s.spent[pid] ?? 0) >= 1 ? 1 : 0);
        } else e = credit([{ pid, sec: pick(300) + 1 }], pick(3) + 1);
        if (e) {
          events.push(e);
          s = k.reduce(s, e, c);
        }
      }
      const a = k.pool(apply(k.initialState(c), events, c), c);
      expect(a).toEqual(k.pool(s, c));
      expect(a.map((e) => e.pid)).toEqual([...a.map((e) => e.pid)].sort());
      for (const e of a) {
        expect(Number.isInteger(e.weight)).toBe(true);
        expect(e.weight).toBeGreaterThanOrEqual(1);
      }
      for (const pid of Object.keys(s.tickets)) {
        expect(s.tickets[pid]).toBeGreaterThanOrEqual(0);
        expect(s.spent[pid] ?? 0).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('declares the fixed contract fields', () => {
    expect(k.id).toBe('tickets');
    expect(k.version).toBe(1);
    expect(k.label).toBe('Ticketkauf');
    expect(k.drawMode).toBe('weighted');
    expect(k.supportedGates).toEqual(['follow', 'account_age', 'follow_age', 'presence']);
    expect(k.usesServices).toEqual(['watchtime', 'chatBonus', 'boost', 'registration']);
    expect(k.events.map((d) => [d.type, d.version])).toEqual([[TICKETS_EVENTS.bought, 1], [TICKETS_EVENTS.refunded, 1]]);
    expect(k.commands).toEqual([{ type: 'buy_tickets', label: 'Tickets kaufen', issuer: 'participant', chat: { word: '!ticket' } }]);
    expect(k.configSchema).toEqual({
      coinBaseSec: { kind: 'int', label: 'Coin-Basis', help: 'So viel Zuschauzeit ergibt einen Coin.', default: 7200, min: 60, max: 360000, unit: 'sec' },
      ticketPriceCoins: { kind: 'int', label: 'Preis je Ticket', help: 'So viele Coins kostet ein Ticket.', default: 1, min: 1, max: 1000, unit: 'coins' },
      maxTicketsPerPerson: { kind: 'int', label: 'Höchstzahl je Person', help: '0 heißt ohne Grenze.', default: 0, min: 0, max: 10000 },
    });
    expect(k.display).toEqual({
      icon: '🎟', unit: 'Tickets', beta: true, emptyPool: 'Niemand hat ein Ticket gekauft.',
      columns: [{ key: 'coins', label: 'Coins' }, { key: 'tickets', label: 'Tickets' }],
    });
    expect(k.gateRegistration).toBeUndefined();
    expect(k.timers).toBeUndefined();
  });
});
