import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import { allowAll, denyUsers } from '../src/framework/giveaway/authorize.js';
import { giveawayStream } from '../src/framework/giveaway/state.js';
import { readStream } from '../src/journal/journal.js';
import { INSTANT_EVENTS, type InstantState } from '../src/kernels/instant/index.js';
import { AT } from './helpers/db.js';
import { kernelsWithPlain, plainKernel } from './helpers/plain-kernel.js';
import { GID, P1, P2, TEAM, at, createOpen, must, openWindow, run, setupGiveaway, state, userOf } from './helpers/giveaway.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function setup(over: Parameters<typeof setupGiveaway>[0] = {}) {
  const s = await setupGiveaway(over);
  closers.push(s.close);
  return s;
}

const SCHEDULER = { actor: 'system:scheduler' };
const closeCmd = { giveawayId: GID, command: { type: 'close_window', args: {} } };

async function code(p: Promise<CommandResult>): Promise<string> {
  const r = await p;
  return r.ok ? 'ok' : r.rejection.code;
}

async function kernelState(rt: Awaited<ReturnType<typeof setup>>['rt']): Promise<InstantState> {
  return (await state(rt)).kernelState as InstantState;
}

describe('Kern-Befehle', () => {
  it('open_window writes instant_window_opened with until from config', async () => {
    const { rt } = await setup();
    await createOpen(rt);
    const events = await openWindow(rt);
    const until = new Date(AT.getTime() + 120_000).toISOString();
    expect(events.map((e) => [e.type, e.payload])).toEqual([[INSTANT_EVENTS.windowOpened, { until }]]);
    expect((await kernelState(rt)).window).toEqual({ until });
  });

  it('open_window twice is rejected by the kernel', async () => {
    const { rt } = await setup();
    await createOpen(rt);
    await openWindow(rt);
    const twice = await run(rt, rt.handlers.kernelCommand, { giveawayId: GID, command: { type: 'open_window', args: {} } });
    expect(twice).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'window_open', message: 'Ein Anmeldefenster ist schon offen. Schließe es zuerst.' },
    });
  });

  it('registration follows the window', async () => {
    const { rt } = await setup();
    await createOpen(rt);
    const reg = { giveawayId: GID, pid: P1 };
    expect(await code(run(rt, rt.handlers.register, reg, { actor: userOf(P1) }))).toBe('window_closed');
    await openWindow(rt);
    expect(await code(run(rt, rt.handlers.register, reg, { actor: userOf(P1) }))).toBe('ok');
    expect((await kernelState(rt)).registered).toEqual([P1]);
  });

  it('rejects registration after until even if window not yet closed', async () => {
    const { rt } = await setup();
    await createOpen(rt);
    await openWindow(rt);
    expect(await code(run(rt, rt.handlers.register, { giveawayId: GID, pid: P1 }, { actor: userOf(P1), now: at(120) }))).toBe('window_closed');
    expect(await code(run(rt, rt.handlers.register, { giveawayId: GID, pid: P1 }, { actor: userOf(P1), now: at(119) }))).toBe('ok');
  });

  it('close_window by scheduler is idempotent', async () => {
    const { pool, rt } = await setup();
    await createOpen(rt);
    await openWindow(rt);
    const first = await must(rt, rt.handlers.kernelCommand, closeCmd, SCHEDULER);
    expect(first.map((e) => [e.type, e.actor])).toEqual([[INSTANT_EVENTS.windowClosed, 'system:scheduler']]);
    expect(await run(rt, rt.handlers.kernelCommand, closeCmd, SCHEDULER)).toEqual({ ok: true, events: [] });
    const closed = (await readStream(pool, rt.registry, giveawayStream(GID))).filter((e) => e.type === INSTANT_EVENTS.windowClosed);
    expect(closed).toHaveLength(1);
    expect((await kernelState(rt)).window).toBeNull();
  });

  it('issuer rules are enforced through the authorizer', async () => {
    const { rt } = await setup({ auth: denyUsers });
    await must(rt, rt.handlers.create, { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1] } }, SCHEDULER);
    await must(rt, rt.handlers.open, { giveawayId: GID }, SCHEDULER);
    const openCmd = { giveawayId: GID, command: { type: 'open_window', args: {} } };
    expect(await code(run(rt, rt.handlers.kernelCommand, openCmd, { actor: userOf(P1) }))).toBe('no_accounts');
    expect(await code(run(rt, rt.handlers.kernelCommand, openCmd, SCHEDULER))).toBe('ok');
    expect(await code(run(rt, rt.handlers.kernelCommand, closeCmd, SCHEDULER))).toBe('ok');

    const all = await setup({ auth: allowAll });
    await createOpen(all.rt);
    const unknown = await run(all.rt, all.rt.handlers.kernelCommand, { giveawayId: GID, command: { type: 'buy', pid: P1, args: {} } }, { actor: userOf(P1) });
    expect(unknown).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'unknown_command', message: 'Diesen Befehl kennt der Kern Sofortverlosung nicht.' },
    });
  });

  it('kernel commands only while open', async () => {
    const { rt } = await setup();
    await createOpen(rt);
    await must(rt, rt.handlers.pause, { giveawayId: GID });
    const r = await run(rt, rt.handlers.kernelCommand, { giveawayId: GID, command: { type: 'open_window', args: {} } });
    expect(r).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'not_open', message: 'Kern-Befehle gehen nur, solange das Giveaway offen ist.' },
    });
  });

  it('participants accumulate across two windows', async () => {
    const { rt } = await setup();
    await createOpen(rt);
    await openWindow(rt);
    await must(rt, rt.handlers.register, { giveawayId: GID, pid: P1 }, { actor: userOf(P1) });
    await must(rt, rt.handlers.kernelCommand, closeCmd, SCHEDULER);
    await openWindow(rt, { now: at(300) });
    await must(rt, rt.handlers.register, { giveawayId: GID, pid: P2 }, { actor: userOf(P2), now: at(310) });
    const s = await state(rt);
    expect(rt.kernels.get('instant').pool(s.kernelState, s.settings.config)).toEqual([
      { pid: P1, weight: 1 },
      { pid: P2, weight: 1 },
    ]);
    expect((s.kernelState as InstantState).windowsOpened).toBe(2);
  });

  it('window_opened can be reverted into window_closed', async () => {
    const { pool, rt } = await setup();
    await createOpen(rt);
    const [opened] = await openWindow(rt);
    await must(rt, rt.handlers.revert, { stream: giveawayStream(GID), eventId: opened!.id, reason: 'Zu früh geöffnet' });
    const events = await readStream(pool, rt.registry, giveawayStream(GID));
    expect(events.at(-1)).toMatchObject({ type: INSTANT_EVENTS.windowClosed, reversesEventId: opened!.id, reason: 'Zu früh geöffnet' });
    expect((await kernelState(rt)).window).toBeNull();
  });
  it('revert of an old window_opened does not close the current window', async () => {
    const { pool, rt } = await setup();
    await createOpen(rt);
    const [first] = await openWindow(rt);
    await must(rt, rt.handlers.kernelCommand, closeCmd, SCHEDULER);
    await openWindow(rt, { now: at(300) });
    const stream = giveawayStream(GID);
    const before = (await readStream(pool, rt.registry, stream)).length;
    const r = await run(rt, rt.handlers.revert, { stream, eventId: first!.id, reason: 'Versehen' });
    expect(r).toEqual({
      ok: false,
      rejection: {
        rejected: true,
        code: 'not_latest_window',
        message: 'Nur das offene Fenster lässt sich zurücknehmen. Dieses Fenster ist schon zu.',
      },
    });
    expect(await readStream(pool, rt.registry, stream)).toHaveLength(before);
    expect((await kernelState(rt)).window).toEqual({ until: at(420).toISOString() });
  });

  it('participant commands only for oneself', async () => {
    const kernels = kernelsWithPlain();
    kernels.register({
      ...plainKernel,
      id: 'selfcmd',
      commands: [{ type: 'ping', label: 'Ping', issuer: 'participant' }],
      decide: () => [],
    });
    const { rt } = await setup({ kernels });
    await createOpen(rt, { kernelId: 'selfcmd', settings: { prize: 'Key', channels: [P1], config: {} } });
    const ping = { giveawayId: GID, command: { type: 'ping', pid: P1, args: {} } };
    expect(await code(run(rt, rt.handlers.kernelCommand, ping, { actor: userOf(P1) }))).toBe('ok');
    expect(await run(rt, rt.handlers.kernelCommand, ping, { actor: userOf(P2) })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'not_you', message: 'Du kannst diesen Befehl nur für dich selbst ausführen.' },
    });
    expect(await code(run(rt, rt.handlers.kernelCommand, { ...ping, command: { ...ping.command, pid: 'x' } }, { actor: userOf(P1) }))).toBe(
      'invalid_id',
    );
  });
});
