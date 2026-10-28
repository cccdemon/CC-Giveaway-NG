import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import { GIVEAWAY_EVENTS, giveawayStream } from '../src/framework/giveaway/state.js';
import { readStream } from '../src/journal/journal.js';
import { AT } from './helpers/db.js';
import { GID, P1, P2, createOpen, must, run, setupGiveaway, state, userOf } from './helpers/giveaway.js';
import { kernelsWithPlain } from './helpers/plain-kernel.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

async function setup() {
  const s = await setupGiveaway({ kernels: kernelsWithPlain() });
  close = s.close;
  return s;
}

const PLAIN = { kernelId: 'plain', settings: { prize: 'Key', channels: [P1], config: {} } };
const me = { actor: userOf(P1) };
const cmd = { giveawayId: GID, pid: P1 };

async function code(p: Promise<CommandResult>): Promise<string> {
  const r = await p;
  return r.ok ? 'ok' : r.rejection.code;
}

async function countOf(pool: Parameters<typeof readStream>[0], rt: Awaited<ReturnType<typeof setup>>['rt'], type: string) {
  return (await readStream(pool, rt.registry, giveawayStream(GID))).filter((e) => e.type === type).length;
}

describe('Anmeldung und Rückzug', () => {
  it('register writes participant_registered and the kernel sees it', async () => {
    const { rt } = await setup();
    await createOpen(rt, PLAIN);
    const events = await must(rt, rt.handlers.register, cmd, me);
    expect(events.map((e) => [e.type, e.payload, e.actor])).toEqual([[GIVEAWAY_EVENTS.registered, { pid: P1 }, userOf(P1)]]);
    const s = await state(rt);
    expect(s.registered[P1]!.since).toBe(AT.toISOString());
    expect(s.kernelState).toEqual({ registered: [P1] });
  });

  it('register rejects when not open, twice, as someone else', async () => {
    const { pool, rt } = await setup();
    await must(rt, rt.handlers.create, { giveawayId: GID, teamId: '55555555-5555-4555-8555-555555555555', ...PLAIN });
    expect(await code(run(rt, rt.handlers.register, cmd, me))).toBe('not_open');
    await must(rt, rt.handlers.open, { giveawayId: GID });
    await must(rt, rt.handlers.pause, { giveawayId: GID });
    const paused = await run(rt, rt.handlers.register, cmd, me);
    expect(paused).toEqual({ ok: false, rejection: { rejected: true, code: 'not_open', message: 'Das Giveaway nimmt gerade keine Anmeldungen an.' } });
    await must(rt, rt.handlers.resume, { giveawayId: GID });
    await must(rt, rt.handlers.register, cmd, me);
    const twice = await run(rt, rt.handlers.register, cmd, me);
    expect(twice).toEqual({ ok: false, rejection: { rejected: true, code: 'already_registered', message: 'Du bist schon angemeldet.' } });
    const before = (await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n;
    const other = await run(rt, rt.handlers.register, { giveawayId: GID, pid: P2 }, me);
    expect(other).toEqual({ ok: false, rejection: { rejected: true, code: 'not_you', message: 'Du kannst nur dich selbst anmelden oder abmelden.' } });
    expect(await code(run(rt, rt.handlers.register, cmd, { actor: userOf(P2) }))).toBe('not_you');
    expect((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(before);
    expect(Object.keys((await state(rt)).registered)).toEqual([P1]);
  });

  it('withdraw works until drawn, reversal re-registers only while open', async () => {
    const { pool, rt } = await setup();
    await createOpen(rt, PLAIN);
    const notYet = await run(rt, rt.handlers.withdraw, cmd, me);
    expect(notYet).toEqual({ ok: false, rejection: { rejected: true, code: 'not_registered', message: 'Du bist nicht angemeldet.' } });
    await must(rt, rt.handlers.register, cmd, me);
    await must(rt, rt.handlers.pause, { giveawayId: GID });
    const [withdrawn] = await must(rt, rt.handlers.withdraw, cmd, me);
    expect(withdrawn!.type).toBe(GIVEAWAY_EVENTS.withdrawn);
    expect(withdrawn!.payload).toEqual({ pid: P1 });
    let s = await state(rt);
    expect(s.registered).toEqual({});
    expect(s.kernelState).toEqual({ registered: [] });
    const revert = { stream: giveawayStream(GID), eventId: withdrawn!.id, reason: 'Versehen' };
    expect(await code(run(rt, rt.handlers.revert, revert))).toBe('not_open');
    await must(rt, rt.handlers.resume, { giveawayId: GID });
    await must(rt, rt.handlers.revert, revert);
    s = await state(rt);
    expect(Object.keys(s.registered)).toEqual([P1]);
    expect(s.kernelState).toEqual({ registered: [P1] });
    expect(await countOf(pool, rt, GIVEAWAY_EVENTS.registered)).toBe(2);
  });

  it('parallel register of same pid yields one event', async () => {
    const { pool, rt } = await setup();
    await createOpen(rt, PLAIN);
    const results = await Promise.all(Array.from({ length: 10 }, () => code(run(rt, rt.handlers.register, cmd, me))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'already_registered')).toHaveLength(9);
    expect(await countOf(pool, rt, GIVEAWAY_EVENTS.registered)).toBe(1);
  });

  it('system actor may register on behalf (simulator path)', async () => {
    const { rt } = await setup();
    await createOpen(rt, PLAIN);
    const events = await must(rt, rt.handlers.register, cmd, { actor: 'system:ingest' });
    expect(events.map((e) => [e.type, e.actor])).toEqual([[GIVEAWAY_EVENTS.registered, 'system:ingest']]);
    expect(Object.keys((await state(rt)).registered)).toEqual([P1]);
  });
});
