import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import { poolHash, rngFrom, type GateChecker, type WinnerStatusCmd } from '../src/framework/giveaway/draw.js';
import { defaultKernels } from '../src/framework/kernel-registry.js';
import { GIVEAWAY_EVENTS, giveawayStream } from '../src/framework/giveaway/state.js';
import { EVENT_VOIDED } from '../src/framework/revert.js';
import { readStream } from '../src/journal/journal.js';
import { plainKernel } from './helpers/plain-kernel.js';
import { GID, P1, P2, P3, createOpen, must, openWindow, run, setupGiveaway, state, userOf } from './helpers/giveaway.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function setup(random: number[] = [0.5, 0.5, 0.5, 0.5], over: Parameters<typeof setupGiveaway>[0] = {}) {
  const s = await setupGiveaway({ rng: rngFrom(random), ...over });
  closers.push(s.close);
  return s;
}

type Rt = Awaited<ReturnType<typeof setup>>['rt'];

async function code(p: Promise<CommandResult>): Promise<string> {
  const r = await p;
  return r.ok ? 'ok' : r.rejection.code;
}

/** Öffnet, meldet die Teilnehmer an und schließt. */
async function closedWith(rt: Rt, pids: string[], winnersCount?: number): Promise<void> {
  await createOpen(rt);
  if (winnersCount !== undefined) await must(rt, rt.handlers.changeSettings, { giveawayId: GID, settings: { winnersCount } });
  await openWindow(rt);
  for (const pid of pids) await must(rt, rt.handlers.register, { giveawayId: GID, pid }, { actor: userOf(pid) });
  await must(rt, rt.handlers.close, { giveawayId: GID });
}

const draw = { giveawayId: GID };
const ok = (pid: string) => ({ pid, ok: true, reasons: [] });
const set = (pid: string, status: string) => ({ giveawayId: GID, pid, status }) as WinnerStatusCmd;
const EMPTY = { rejected: true, code: 'empty_pool', message: 'Niemand hat sich im Anmeldefenster angemeldet.' };

describe('Ziehung', () => {
  it('draw needs closed', async () => {
    const { rt } = await setup();
    await createOpen(rt);
    const r = await run(rt, rt.handlers.draw, draw);
    expect(r).toEqual({ ok: false, rejection: { rejected: true, code: 'not_closed', message: 'Schließe das Giveaway, bevor du ziehst.' } });
  });

  it('draw writes the proof', async () => {
    const { rt } = await setup([0.5]);
    await closedWith(rt, [P1, P2, P3]);
    const events = await must(rt, rt.handlers.draw, draw);
    const pool = [P1, P2, P3].map((pid) => ({ pid, weight: 1 }));
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      [
        GIVEAWAY_EVENTS.drawn,
        { mode: 'equal', winners: [P2], pool, poolHash: poolHash(pool), random: [0.5], gates: [ok(P1), ok(P2), ok(P3)], excluded: [] },
      ],
    ]);
    const s = await state(rt);
    expect(s.status).toBe('drawn');
    expect(s.winners).toEqual({ [P2]: 'pending' });
  });

  it('empty pool is explained', async () => {
    const { pool, rt } = await setup();
    await closedWith(rt, []);
    expect(await run(rt, rt.handlers.draw, draw)).toEqual({ ok: false, rejection: EMPTY });
    const types = (await readStream(pool, rt.registry, giveawayStream(GID))).map((e) => e.type);
    expect(types).not.toContain(GIVEAWAY_EVENTS.drawn);
    expect((await state(rt)).status).toBe('closed');
  });

  it('withdraw after draw is too late', async () => {
    const { rt } = await setup([0.5]);
    await closedWith(rt, [P1, P2]);
    await must(rt, rt.handlers.draw, draw);
    expect(await code(run(rt, rt.handlers.withdraw, { giveawayId: GID, pid: P1 }, { actor: userOf(P1) }))).toBe('too_late');
  });

  it('redraw voids and redraws without the old winner in one command', async () => {
    const { rt } = await setup([0.5, 0]);
    await closedWith(rt, [P1, P2, P3]);
    const [first] = await must(rt, rt.handlers.draw, draw);
    expect(first!.payload).toMatchObject({ winners: [P2] });
    expect(await code(run(rt, rt.handlers.redraw, { giveawayId: GID, replace: P2, reason: '  ' }))).toBe('reason_required');
    const notWinner = await run(rt, rt.handlers.redraw, { giveawayId: GID, replace: P1, reason: 'x' });
    expect(notWinner).toEqual({ ok: false, rejection: { rejected: true, code: 'not_a_winner', message: 'Diese Person ist kein Gewinner.' } });

    const events = await must(rt, rt.handlers.redraw, { giveawayId: GID, replace: P2, reason: 'Keine Meldung' });
    expect(events.map((e) => e.type)).toEqual([GIVEAWAY_EVENTS.drawn, EVENT_VOIDED]);
    const pool = [P1, P3].map((pid) => ({ pid, weight: 1 }));
    expect(events[0]!.payload).toEqual({
      mode: 'equal', winners: [P1], pool, poolHash: poolHash(pool), random: [0], gates: [ok(P1), ok(P2), ok(P3)], excluded: [P2],
    });
    expect(events[1]!.payload).toEqual({ targetType: GIVEAWAY_EVENTS.drawn });
    expect(events[1]!.reason).toBe('Keine Meldung');
    expect(events[1]!.reversesEventId).toBe(first!.id);
    const s = await state(rt);
    expect(s.draws[0]!.voided).toBe(true);
    expect(s.draws[1]).toEqual({ eventId: events[0]!.id, winners: [P1], excluded: [P2], voided: false });
    expect(s.status).toBe('drawn');
    expect(s.winners).toEqual({ [P1]: 'pending' });
  });

  it('redraw keeps earlier exclusions out of the pool', async () => {
    const { rt } = await setup([0, 0, 0]);
    await closedWith(rt, [P1, P2, P3]);
    await must(rt, rt.handlers.draw, draw); // P1
    await must(rt, rt.handlers.redraw, { giveawayId: GID, replace: P1, reason: 'Keine Meldung' }); // P2
    const events = await must(rt, rt.handlers.redraw, { giveawayId: GID, replace: P2, reason: 'Keine Meldung' });
    expect(events[0]!.payload).toMatchObject({ winners: [P3], pool: [{ pid: P3, weight: 1 }], excluded: [P2, P1] });
    expect(await run(rt, rt.handlers.redraw, { giveawayId: GID, replace: P3, reason: 'Keine Meldung' })).toEqual({ ok: false, rejection: EMPTY });
  });

  it('redraw with nobody else leaves the old draw valid', async () => {
    const { pool, rt } = await setup();
    await closedWith(rt, [P1]);
    await must(rt, rt.handlers.draw, draw);
    const before = await readStream(pool, rt.registry, giveawayStream(GID));
    const r = await run(rt, rt.handlers.redraw, { giveawayId: GID, replace: P1, reason: 'Keine Meldung' });
    expect(r).toEqual({ ok: false, rejection: EMPTY });
    expect(await readStream(pool, rt.registry, giveawayStream(GID))).toHaveLength(before.length);
    const s = await state(rt);
    expect(s.status).toBe('drawn');
    expect(s.draws[0]!.voided).toBe(false);
  });

  it('redraw needs a valid draw', async () => {
    const { rt } = await setup();
    await closedWith(rt, [P1]);
    const r = await run(rt, rt.handlers.redraw, { giveawayId: GID, replace: P1, reason: 'x' });
    expect(r).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'not_drawn', message: 'Es gibt keine gültige Ziehung, die du ersetzen könntest.' },
    });
  });

  it('revert of a draw falls back to closed and reopen is possible', async () => {
    const { rt } = await setup();
    await closedWith(rt, [P1, P2]);
    const [drawn] = await must(rt, rt.handlers.draw, draw);
    const events = await must(rt, rt.handlers.revert, { stream: giveawayStream(GID), eventId: drawn!.id, reason: 'Falscher Preis' });
    expect(events.map((e) => [e.type, e.reversesEventId])).toEqual([[EVENT_VOIDED, drawn!.id]]);
    const s = await state(rt);
    expect(s.status).toBe('closed');
    expect(s.winners).toEqual({});
    await must(rt, rt.handlers.reopen, { giveawayId: GID });
    expect((await state(rt)).status).toBe('open');
  });

  it('winners_count 2 draws two distinct winners', async () => {
    const { rt } = await setup([0.1, 0.9]);
    await closedWith(rt, [P1, P2, P3], 2);
    const [e] = await must(rt, rt.handlers.draw, draw);
    const p = e!.payload as { winners: string[]; random: number[] };
    expect(p.winners).toEqual([P1, P3]);
    expect(p.random).toEqual([0.1, 0.9]);
    expect((await state(rt)).winners).toEqual({ [P1]: 'pending', [P3]: 'pending' });
  });

  it('winner status and complete', async () => {
    const { rt } = await setup([0.1, 0.9]);
    await closedWith(rt, [P1, P2, P3], 2);
    const [drawn] = await must(rt, rt.handlers.draw, draw);

    const done = await must(rt, rt.handlers.setWinnerStatus, set(P1, 'done'));
    expect(done.map((e) => [e.type, e.payload])).toEqual([[GIVEAWAY_EVENTS.winnerStatusSet, { pid: P1, from: 'pending', to: 'done' }]]);
    expect(await must(rt, rt.handlers.setWinnerStatus, set(P1, 'done'))).toEqual([]);
    expect(await code(run(rt, rt.handlers.complete, { giveawayId: GID }))).toBe('winners_open');

    await must(rt, rt.handlers.setWinnerStatus, set(P3, 'forfeited'));
    await must(rt, rt.handlers.complete, { giveawayId: GID });
    expect((await state(rt)).status).toBe('completed');
    expect(await code(run(rt, rt.handlers.cancel, { giveawayId: GID }))).toBe('invalid_transition');
    expect(await code(run(rt, rt.handlers.setWinnerStatus, set(P1, 'shipped')))).toBe('not_drawn');
    const revert = await run(rt, rt.handlers.revert, { stream: giveawayStream(GID), eventId: drawn!.id, reason: 'zu spät' });
    expect(revert).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'not_drawn', message: 'Nur im Zustand Gezogen lässt sich eine Ziehung aufheben.' },
    });
    expect((await state(rt)).status).toBe('completed');
  });

  it('set_winner_status rejects non-winner and non-drawn', async () => {
    const { rt } = await setup([0.5]);
    await closedWith(rt, [P1, P2, P3]);
    expect(await code(run(rt, rt.handlers.setWinnerStatus, set(P2, 'done')))).toBe('not_drawn');
    await must(rt, rt.handlers.draw, draw); // P2
    const r = await run(rt, rt.handlers.setWinnerStatus, set(P1, 'done'));
    expect(r).toEqual({ ok: false, rejection: { rejected: true, code: 'not_a_winner', message: 'Diese Person ist kein Gewinner.' } });
    expect(await code(run(rt, rt.handlers.setWinnerStatus, set(P2, 'pending')))).toBe('invalid_winner_status');
    expect(await code(run(rt, rt.handlers.setWinnerStatus, set(P2, 'nope')))).toBe('invalid_winner_status');
  });

  it('pool with only zero weights is empty and writes nothing', async () => {
    const kernels = defaultKernels();
    kernels.register({ ...plainKernel, id: 'zero', pool: (st) => st.registered.map((pid: string) => ({ pid, weight: 0 })) });
    const { pool, rt } = await setup([0.5], { kernels });
    await createOpen(rt, { kernelId: 'zero' });
    await must(rt, rt.handlers.register, { giveawayId: GID, pid: P1 }, { actor: userOf(P1) });
    await must(rt, rt.handlers.close, { giveawayId: GID });
    expect(await run(rt, rt.handlers.draw, draw)).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'empty_pool', message: 'Niemand ist angemeldet.' },
    });
    const types = (await readStream(pool, rt.registry, giveawayStream(GID))).map((e) => e.type);
    expect(types).not.toContain(GIVEAWAY_EVENTS.drawn);
    expect((await state(rt)).status).toBe('closed');
  });

  it('a pool pid without gate result is not eligible and named in the proof', async () => {
    const X = '12121212-1212-4212-8212-121212121212';
    const gates: GateChecker = { check: async () => [ok(P3), ok(P1), ok(X), { pid: P1, ok: false, reasons: ['dup'] }] };
    const { rt } = await setup([0], { gates });
    await closedWith(rt, [P1, P2, P3]);
    const [e] = await must(rt, rt.handlers.draw, draw);
    expect(e!.payload).toMatchObject({
      winners: [P1],
      pool: [{ pid: P1, weight: 1 }, { pid: P3, weight: 1 }],
      gates: [ok(P1), { pid: P2, ok: false, reasons: ['no_result'] }, ok(P3)],
    });
  });
});
