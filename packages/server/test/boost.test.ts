import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import { SERVICE_EVENT_TYPES } from '../src/framework/giveaway/services.js';
import { noActivity, type IdentityResolver } from '../src/framework/giveaway/signals.js';
import { giveawayStream } from '../src/framework/giveaway/state.js';
import { FRAMEWORK_EVENTS } from '../src/kernel-api/index.js';
import { minuteOf } from '../src/ingest/bundler.js';
import type { SignalUser } from '../src/ingest/signals.js';
import type { WatchtimeState } from '../src/kernels/watchtime/index.js';
import { AT } from './helpers/db.js';
import { GID, P1, P2, STREAMER, at, createOpen, must, run, setupGiveaway, state } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const ALICE: SignalUser = { id: '12345', login: 'alice', displayName: 'Alice' };
const INGEST = { actor: 'system:ingest' };
const SCHEDULER = { actor: 'system:scheduler' };
const iso = (sec: number) => at(sec).toISOString();

const resolver: IdentityResolver = {
  resolve: vi.fn(async (_c, ids: string[]) => new Map(ids.filter((id) => id === ALICE.id).map((id) => [id, P2]))),
  create: vi.fn(async () => new Map()),
  touch: vi.fn(async () => {}),
};

async function setup(over: Parameters<typeof setupGiveaway>[0] = {}) {
  const s = await setupGiveaway({ identities: resolver, ...over });
  close = s.close;
  await createOpen(s.rt, { kernelId: 'watchtime', settings: { prize: 'Key', channels: [P1], config: { coinBaseSec: 120 }, counting: 'first_seen' } });
  return s;
}

async function code(p: Promise<CommandResult>): Promise<string> {
  const r = await p;
  return r.ok ? 'ok' : r.rejection.code;
}

async function timerRows(pool: pg.Pool) {
  return (await pool.query('SELECT key, due_at, command FROM timers WHERE stream = $1 ORDER BY key', [giveawayStream(GID)])).rows;
}

const boost = (factor = 3, durationSec = 600) => ({ giveawayId: GID, factor, durationSec });
const presence = (sec: number) => ({ giveawayId: GID, channel: P1, minute: minuteOf(at(sec)), presence: [ALICE], chat: [], follows: [] });

describe('Boost', () => {
  it('start_boost writes boost_started with until and needs an active channel', async () => {
    const { pool, rt } = await setup();
    const events = await must(rt, rt.handlers.startBoost, boost());
    expect(events.map((e) => [e.type, e.payload])).toEqual([[SERVICE_EVENT_TYPES.boostStarted, { factor: 3, until: iso(600) }]]);
    expect((await state(rt)).boost).toEqual({ factor: 3, since: AT.toISOString(), until: iso(600), eventId: events[0]!.id });
    expect((await pool.query('SELECT boost FROM giveaways WHERE id = $1', [GID])).rows[0]).toEqual({ boost: { factor: 3, since: AT.toISOString(), until: iso(600), eventId: events[0]!.id } });
    expect(await timerRows(pool)).toEqual([{ key: 'boost_end', due_at: at(600), command: { type: 'framework:stop_boost', args: {} } }]);
    await close?.();
    close = undefined;
    const quiet = await setup({ activity: noActivity });
    const r = await run(quiet.rt, quiet.rt.handlers.startBoost, boost());
    expect(r).toEqual({ ok: false, rejection: { rejected: true, code: 'no_signal', message: 'Kein Kanal des Giveaways ist live und liefert Signale. Ein Boost startet nur mit Signalen.' } });
  });

  it('start_boost rejects bad factor or duration, a running boost and a paused giveaway', async () => {
    const { rt } = await setup();
    for (const cmd of [boost(1), boost(11), boost(2.5), boost(3, 59), boost(3, 86_401), boost(3, 60.5)]) {
      const r = await run(rt, rt.handlers.startBoost, cmd);
      expect(r).toEqual({ ok: false, rejection: { rejected: true, code: 'invalid_boost', message: 'Der Faktor liegt zwischen 2 und 10, die Dauer zwischen 1 Minute und 24 Stunden.' } });
    }
    await must(rt, rt.handlers.startBoost, boost(2, 60));
    expect(await run(rt, rt.handlers.startBoost, boost())).toEqual({ ok: false, rejection: { rejected: true, code: 'boost_active', message: 'Ein Boost läuft schon. Stoppe ihn zuerst.' } });
    await must(rt, rt.handlers.stopBoost, { giveawayId: GID });
    await must(rt, rt.handlers.pause, { giveawayId: GID });
    expect(await run(rt, rt.handlers.startBoost, boost())).toEqual({ ok: false, rejection: { rejected: true, code: 'not_open', message: 'Ein Boost startet nur, solange das Giveaway offen ist.' } });
  });

  it('stop_boost works for the streamer and the scheduler, rejects without boost', async () => {
    const { pool, rt } = await setup();
    expect(await run(rt, rt.handlers.stopBoost, { giveawayId: GID })).toEqual({ ok: false, rejection: { rejected: true, code: 'no_boost', message: 'Es läuft kein Boost.' } });
    await must(rt, rt.handlers.startBoost, boost());
    await must(rt, rt.handlers.pause, { giveawayId: GID });
    // Der Boost läuft über die Pause hinweg, sein Zeitgeber bleibt.
    expect(await timerRows(pool)).toHaveLength(1);
    const ended = await must(rt, rt.handlers.stopBoost, { giveawayId: GID }, SCHEDULER);
    expect(ended.map((e) => [e.type, e.payload, e.actor])).toEqual([[SERVICE_EVENT_TYPES.boostEnded, {}, 'system:scheduler']]);
    expect((await state(rt)).boost).toBeNull();
    expect(await timerRows(pool)).toEqual([]);
    await must(rt, rt.handlers.resume, { giveawayId: GID });
    await must(rt, rt.handlers.startBoost, boost());
    expect(await code(run(rt, rt.handlers.stopBoost, { giveawayId: GID }, { actor: STREAMER }))).toBe('ok');
    expect(await code(run(rt, rt.handlers.stopBoost, { giveawayId: P2 }, SCHEDULER))).toBe('giveaway_not_found');
  });

  it('revert of boost_started ends the boost, revert of boost_ended is refused', async () => {
    const { rt } = await setup();
    const [started] = await must(rt, rt.handlers.startBoost, boost());
    const [ended] = await must(rt, rt.handlers.revert, { stream: giveawayStream(GID), eventId: started!.id, reason: 'Versehen' });
    expect(ended).toMatchObject({ type: SERVICE_EVENT_TYPES.boostEnded, reversesEventId: started!.id, reason: 'Versehen' });
    expect((await state(rt)).boost).toBeNull();
    const r = await run(rt, rt.handlers.revert, { stream: giveawayStream(GID), eventId: ended!.id, reason: 'Doch nicht' });
    expect(r).toMatchObject({ ok: false, rejection: { code: 'not_reversible', message: 'Ein beendeter Boost bleibt beendet. Starte einen neuen Boost.' } });
    expect(await code(run(rt, rt.handlers.revert, { stream: giveawayStream(GID), eventId: started!.id, reason: 'Nochmal' }))).toBe('already_reverted');
  });

  it('correct_watch writes watch_corrected with reason and the kernel subtracts', async () => {
    const { rt } = await setup();
    await must(rt, rt.handlers.applySignals, presence(0), INGEST);
    await must(rt, rt.handlers.applySignals, presence(60), { ...INGEST, now: at(65) });
    expect(((await state(rt)).kernelState as WatchtimeState).sec).toEqual({ [P2]: { [P1]: 120 } });
    const [corrected] = await must(rt, rt.handlers.correctWatch, { giveawayId: GID, channel: P1, pid: P2, sec: -60, reason: 'Doppelt gezählt' });
    expect(corrected).toMatchObject({ type: FRAMEWORK_EVENTS.watchCorrected, payload: { channel: P1, entries: [{ pid: P2, sec: -60 }] }, reason: 'Doppelt gezählt' });
    const s = await state(rt);
    expect((s.kernelState as WatchtimeState).sec).toEqual({ [P2]: { [P1]: 60 } });
    expect(rt.kernels.get('watchtime').pool(s.kernelState, s.settings.config)).toEqual([]);
    const [back] = await must(rt, rt.handlers.revert, { stream: giveawayStream(GID), eventId: corrected!.id, reason: 'War richtig' });
    expect(back).toMatchObject({ type: FRAMEWORK_EVENTS.watchCorrected, payload: { channel: P1, entries: [{ pid: P2, sec: 60 }] } });
    expect(((await state(rt)).kernelState as WatchtimeState).sec).toEqual({ [P2]: { [P1]: 120 } });
  });

  it('start_boost and correct_watch are refused for a kernel without the service', async () => {
    const { rt } = await setup();
    const gid2 = '66666666-6666-4666-8666-666666666670';
    await createOpen(rt, { giveawayId: gid2, kernelId: 'instant', settings: { prize: 'Key', channels: [P1] } });
    expect(await run(rt, rt.handlers.startBoost, { giveawayId: gid2, factor: 2, durationSec: 60 })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'service_unsupported', message: 'Der Kern Sofortverlosung kennt diesen Dienst nicht.' },
    });
    expect(await code(run(rt, rt.handlers.correctWatch, { giveawayId: gid2, channel: P1, pid: P2, sec: 60, reason: 'x' }))).toBe('service_unsupported');
  });

  it('correct_watch rejects after cancel, foreign channel, zero and missing reason', async () => {
    const { rt } = await setup();
    const cmd = { giveawayId: GID, channel: P1, pid: P2, sec: 60, reason: 'Nachtrag' };
    expect(await code(run(rt, rt.handlers.correctWatch, { ...cmd, channel: P2 }))).toBe('channel_not_in_giveaway');
    expect(await code(run(rt, rt.handlers.correctWatch, { ...cmd, sec: 0 }))).toBe('invalid_correction');
    expect(await code(run(rt, rt.handlers.correctWatch, { ...cmd, sec: 1.5 }))).toBe('invalid_correction');
    expect(await code(run(rt, rt.handlers.correctWatch, { ...cmd, sec: 360_001 }))).toBe('invalid_correction');
    expect(await code(run(rt, rt.handlers.correctWatch, { ...cmd, reason: ' ' }))).toBe('reason_required');
    expect(await code(run(rt, rt.handlers.correctWatch, { ...cmd, pid: 'wer' }))).toBe('invalid_id');
    expect(await code(run(rt, rt.handlers.correctWatch, cmd))).toBe('ok');
    await must(rt, rt.handlers.cancel, { giveawayId: GID });
    const r = await run(rt, rt.handlers.correctWatch, cmd);
    expect(r).toEqual({ ok: false, rejection: { rejected: true, code: 'correction_locked', message: 'Nach Ziehung oder Abbruch korrigierst du keine Zuschauzeit mehr.' } });
  });
});
