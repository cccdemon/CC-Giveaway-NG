import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import { GIVEAWAY_EVENTS, giveawayStream } from '../src/framework/giveaway/state.js';
import { readStream } from '../src/journal/journal.js';
import { TICKETS_EVENTS, type TicketsState } from '../src/kernels/tickets/index.js';
import { kernelsWithPlain, plainKernel } from './helpers/plain-kernel.js';
import { GID, P1, P2, P3, createOpen, must, run, setupGiveaway, state, userOf } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const STREAM = giveawayStream(GID);
const buy = (pid: string, count?: number) => ({ giveawayId: GID, command: { type: 'buy_tickets', pid, args: count === undefined ? {} : { count } } });
const types = (events: { type: string }[]) => events.map((e) => e.type);

async function code(p: Promise<CommandResult>): Promise<string> {
  const r = await p;
  return r.ok ? 'ok' : r.rejection.code;
}

/** Offenes Ticket-Giveaway mit Coin-Basis 60 s. P2 ist angemeldet und hat 5 Coins. */
async function setup(config: Record<string, unknown> = {}, over: Parameters<typeof setupGiveaway>[0] = {}) {
  const s = await setupGiveaway(over);
  close = s.close;
  await createOpen(s.rt, { kernelId: 'tickets', settings: { prize: 'Key', channels: [P1], config: { coinBaseSec: 60, ...config } } });
  await must(s.rt, s.rt.handlers.register, { giveawayId: GID, pid: P2 }, { actor: userOf(P2) });
  await must(s.rt, s.rt.handlers.correctWatch, { giveawayId: GID, channel: P1, pid: P2, sec: 300, reason: 'Test' });
  return s;
}

const kernel = async (rt: Awaited<ReturnType<typeof setup>>['rt']) => (await state(rt)).kernelState as TicketsState;

describe('Ticketkauf über den Bus', () => {
  it('buy_tickets via kernel_command writes tickets_bought, weights follow the tickets', async () => {
    const { pool, rt } = await setup();
    const events = await must(rt, rt.handlers.kernelCommand, buy(P2, 2), { actor: userOf(P2) });
    expect(events.map((e) => [e.type, e.payload, e.actor])).toEqual([[TICKETS_EVENTS.bought, { pid: P2, count: 2, coins: 2 }, userOf(P2)]]);
    const s = await state(rt);
    expect((s.kernelState as TicketsState).tickets).toEqual({ [P2]: 2 });
    expect(rt.kernels.get('tickets').pool(s.kernelState, s.settings.config)).toEqual([{ pid: P2, weight: 2 }]);
    const row = await pool.query('SELECT registered, in_pool, weight FROM giveaway_participants WHERE giveaway_id = $1 AND pid = $2', [GID, P2]);
    expect(row.rows[0]).toEqual({ registered: true, in_pool: true, weight: 2 });
    const g = await pool.query('SELECT pool_size, pool_weight FROM giveaways WHERE id = $1', [GID]);
    expect(g.rows[0]).toEqual({ pool_size: 1, pool_weight: 2 });
  });

  it('a participant buys only for themself', async () => {
    const { rt } = await setup();
    expect(await run(rt, rt.handlers.kernelCommand, buy(P2, 1), { actor: userOf(P3) })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'not_you', message: 'Du kannst diesen Befehl nur für dich selbst ausführen.' },
    });
  });

  it('rejections reach the caller with exact code and message', async () => {
    const { rt } = await setup({ maxTicketsPerPerson: 1 });
    const r = async (pid: string, count?: number) => {
      const out = await run(rt, rt.handlers.kernelCommand, buy(pid, count), { actor: userOf(pid) });
      return out.ok ? 'ok' : [out.rejection.code, out.rejection.message];
    };
    expect(await r(P3)).toEqual(['not_registered', 'Melde dich erst an, dann kaufe Tickets.']);
    expect(await r(P2, 0)).toEqual(['invalid_count', 'Gib eine ganze Zahl von 1 bis 10000 Tickets an.']);
    expect(await r(P2, 2)).toEqual(['ticket_limit', 'Höchstens 1 Tickets je Person. Du hast 0.']);
    await must(rt, rt.handlers.changeSettings, { giveawayId: GID, settings: { config: { maxTicketsPerPerson: 0 } } });
    expect(await r(P2, 6)).toEqual(['not_enough_coins', 'Dir fehlen 1 Coins für 6 Tickets.']);
    expect(await r(P2, 5)).toBe('ok');
    expect(await r(P2, 1)).toEqual(['not_enough_coins', 'Dir fehlen 1 Coins für 1 Tickets.']);
  });

  it('revert of tickets_bought writes tickets_refunded with the paid price even after a price change', async () => {
    const { pool, rt } = await setup();
    const [bought] = await must(rt, rt.handlers.kernelCommand, buy(P2, 1), { actor: userOf(P2) });
    await must(rt, rt.handlers.changeSettings, { giveawayId: GID, settings: { config: { ticketPriceCoins: 3 } } });
    await must(rt, rt.handlers.revert, { stream: STREAM, eventId: bought!.id, reason: 'Versehen' });
    const last = (await readStream(pool, rt.registry, STREAM)).at(-1)!;
    expect(last).toMatchObject({ type: TICKETS_EVENTS.refunded, payload: { pid: P2, count: 1, coins: 1 }, reversesEventId: bought!.id, reason: 'Versehen' });
    expect(await kernel(rt)).toMatchObject({ tickets: { [P2]: 0 }, spent: { [P2]: 0 } });
    const second = await must(rt, rt.handlers.kernelCommand, buy(P2, 1), { actor: userOf(P2) });
    expect(second[0]!.payload).toEqual({ pid: P2, count: 1, coins: 3 });
  });

  it('revert of an older purchase works after a later one; a refund is not reversible; a reverted purchase stays reverted', async () => {
    const { rt } = await setup();
    const [first] = await must(rt, rt.handlers.kernelCommand, buy(P2, 2), { actor: userOf(P2) });
    const [second] = await must(rt, rt.handlers.kernelCommand, buy(P2, 1), { actor: userOf(P2) });
    const [refund] = await must(rt, rt.handlers.revert, { stream: STREAM, eventId: first!.id, reason: 'Zu viel' });
    expect(refund!.payload).toEqual({ pid: P2, count: 2, coins: 2 });
    expect((await kernel(rt)).tickets).toEqual({ [P2]: 1 });
    expect(await run(rt, rt.handlers.revert, { stream: STREAM, eventId: refund!.id, reason: 'x' })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'not_reversible', message: 'Eine Erstattung bleibt. Kaufe die Tickets neu.' },
    });
    expect(await code(run(rt, rt.handlers.revert, { stream: STREAM, eventId: first!.id, reason: 'x' }))).toBe('already_reverted');
    await must(rt, rt.handlers.revert, { stream: STREAM, eventId: second!.id, reason: 'x' });
    expect((await kernel(rt)).tickets).toEqual({ [P2]: 0 });
    expect((await kernel(rt)).spent).toEqual({ [P2]: 0 });
  });

  it('cancel writes giveaway_status_changed then one tickets_refunded per open purchase, each reversing its purchase', async () => {
    const { pool, rt } = await setup();
    await must(rt, rt.handlers.register, { giveawayId: GID, pid: P3 }, { actor: userOf(P3) });
    await must(rt, rt.handlers.correctWatch, { giveawayId: GID, channel: P1, pid: P3, sec: 120, reason: 'Test' });
    const [b1] = await must(rt, rt.handlers.kernelCommand, buy(P3, 1), { actor: userOf(P3) });
    const [b2] = await must(rt, rt.handlers.kernelCommand, buy(P2, 2), { actor: userOf(P2) });
    const [b3] = await must(rt, rt.handlers.kernelCommand, buy(P2, 1), { actor: userOf(P2) });
    const events = await must(rt, rt.handlers.cancel, { giveawayId: GID });
    expect(events.map((e) => [e.type, e.payload, e.reversesEventId, e.reason])).toEqual([
      [GIVEAWAY_EVENTS.statusChanged, { from: 'open', to: 'cancelled' }, null, null],
      [TICKETS_EVENTS.refunded, { pid: P3, count: 1, coins: 1 }, b1!.id, 'Abbruch des Giveaways.'],
      [TICKETS_EVENTS.refunded, { pid: P2, count: 2, coins: 2 }, b2!.id, 'Abbruch des Giveaways.'],
      [TICKETS_EVENTS.refunded, { pid: P2, count: 1, coins: 1 }, b3!.id, 'Abbruch des Giveaways.'],
    ]);
    const s = await state(rt);
    expect(s.status).toBe('cancelled');
    expect((s.kernelState as TicketsState).tickets).toEqual({ [P2]: 0, [P3]: 0 });
    expect((s.kernelState as TicketsState).purchases).toEqual([]);
    const rows = await pool.query('SELECT pid, weight, in_pool FROM giveaway_participants WHERE giveaway_id = $1 ORDER BY pid', [GID]);
    expect(rows.rows).toEqual([
      { pid: P2, weight: 0, in_pool: false },
      { pid: P3, weight: 0, in_pool: false },
    ]);
    // Der Kauf ist durch die Erstattung schon aufgehoben: das meldet der Bus vor der Sperre des Zustands.
    expect(await code(run(rt, rt.handlers.revert, { stream: STREAM, eventId: b3!.id, reason: 'x' }))).toBe('already_reverted');
  });

  it('after a cancel, an open kernel entry of the instant kernel is kernel_locked with a text that names the cancel', async () => {
    const other = await setupGiveaway();
    try {
      await createOpen(other.rt);
      const [opened] = await must(other.rt, other.rt.handlers.kernelCommand, { giveawayId: GID, command: { type: 'open_window', args: {} } });
      await must(other.rt, other.rt.handlers.cancel, { giveawayId: GID });
      expect(await run(other.rt, other.rt.handlers.revert, { stream: STREAM, eventId: opened!.id, reason: 'x' })).toEqual({
        ok: false,
        rejection: { rejected: true, code: 'kernel_locked', message: 'Nach Ziehung oder Abbruch änderst du keine Kern-Einträge mehr.' },
      });
    } finally {
      await other.close();
    }
  });

  it('revert of the cancel reopens without tickets; the old purchase stays reverted; a new cancel refunds only new purchases', async () => {
    const { rt } = await setup();
    const [old] = await must(rt, rt.handlers.kernelCommand, buy(P2, 2), { actor: userOf(P2) });
    const [cancelled] = await must(rt, rt.handlers.cancel, { giveawayId: GID });
    await must(rt, rt.handlers.revert, { stream: STREAM, eventId: cancelled!.id, reason: 'Versehen' });
    const s = await state(rt);
    expect(s.status).toBe('open');
    expect((s.kernelState as TicketsState).tickets).toEqual({ [P2]: 0 });
    expect(await code(run(rt, rt.handlers.revert, { stream: STREAM, eventId: old!.id, reason: 'x' }))).toBe('already_reverted');
    // Die Coins sind wieder da: 5 Coins, Kauf von 3 geht, Kauf von 6 nicht.
    const [fresh] = await must(rt, rt.handlers.kernelCommand, buy(P2, 3), { actor: userOf(P2) });
    expect(await code(run(rt, rt.handlers.kernelCommand, buy(P2, 3), { actor: userOf(P2) }))).toBe('not_enough_coins');
    const again = await must(rt, rt.handlers.cancel, { giveawayId: GID });
    expect(again.map((e) => [e.type, e.payload, e.reversesEventId])).toEqual([
      [GIVEAWAY_EVENTS.statusChanged, { from: 'open', to: 'cancelled' }, null],
      [TICKETS_EVENTS.refunded, { pid: P2, count: 3, coins: 3 }, fresh!.id],
    ]);
    expect((await kernel(rt)).tickets).toEqual({ [P2]: 0 });
  });

  it('cancel without purchases and cancel of an instant giveaway write only giveaway_status_changed', async () => {
    const { rt } = await setup();
    expect(types(await must(rt, rt.handlers.cancel, { giveawayId: GID }))).toEqual([GIVEAWAY_EVENTS.statusChanged]);
    const other = await setupGiveaway();
    try {
      await createOpen(other.rt);
      expect(types(await must(other.rt, other.rt.handlers.cancel, { giveawayId: GID }))).toEqual([GIVEAWAY_EVENTS.statusChanged]);
    } finally {
      await other.close();
    }
  });

  it('after close + draw, revert of tickets_bought is kernel_locked; before the draw in closed it works', async () => {
    const { rt } = await setup();
    const [first] = await must(rt, rt.handlers.kernelCommand, buy(P2, 1), { actor: userOf(P2) });
    const [second] = await must(rt, rt.handlers.kernelCommand, buy(P2, 1), { actor: userOf(P2) });
    await must(rt, rt.handlers.close, { giveawayId: GID });
    expect(await code(run(rt, rt.handlers.revert, { stream: STREAM, eventId: first!.id, reason: 'x' }))).toBe('ok');
    await must(rt, rt.handlers.draw, { giveawayId: GID });
    expect(await run(rt, rt.handlers.revert, { stream: STREAM, eventId: second!.id, reason: 'x' })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'kernel_locked', message: 'Nach Ziehung oder Abbruch änderst du keine Kern-Einträge mehr.' },
    });
    // Ein fehlender Grund wird vor der Sperre gemeldet.
    expect(await code(run(rt, rt.handlers.revert, { stream: STREAM, eventId: second!.id, reason: ' ' }))).toBe('reason_required');
    expect((await kernel(rt)).tickets).toEqual({ [P2]: 1 });
  });

  it('kernel_command on a kernel that produces a foreign event type throws', async () => {
    const kernels = kernelsWithPlain();
    kernels.register({
      ...plainKernel,
      id: 'foreign',
      commands: [{ type: 'ping', label: 'Ping', issuer: 'participant' }],
      decide: () => [{ type: 'other_x', payload: {} }],
    });
    const s = await setupGiveaway({ kernels });
    close = s.close;
    await createOpen(s.rt, { kernelId: 'foreign', settings: { prize: 'Key', channels: [P1], config: {} } });
    await expect(run(s.rt, s.rt.handlers.kernelCommand, { giveawayId: GID, command: { type: 'ping', pid: P1, args: {} } }, { actor: userOf(P1) })).rejects.toThrow(/fremdes Ereignis/);
  });
});
