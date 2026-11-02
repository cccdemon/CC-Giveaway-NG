import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { noActivity, type ApplySignalsCmd, type IdentityResolver } from '../src/framework/giveaway/signals.js';
import { FRAMEWORK_EVENTS } from '../src/kernel-api/index.js';
import { findIdentity, upsertIdentity } from '../src/identity/identities.js';
import { identityResolver } from '../src/identity/resolver.js';
import { minuteOf } from '../src/ingest/bundler.js';
import type { SignalUser } from '../src/ingest/signals.js';
import type { WatchtimeState } from '../src/kernels/watchtime/index.js';
import { AT, freshDb } from './helpers/db.js';
import { GID, P1, P2, P3, STREAMER, createOpen, must, run, setupGiveaway, state, userOf } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const ALICE: SignalUser = { id: '12345', login: 'alice', displayName: 'Alice' };
const BOB: SignalUser = { id: '67890', login: 'bob', displayName: 'Bob' };
const GHOST: SignalUser = { id: '99', login: 'ghost', displayName: 'Ghost' };
const PG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa99';
const INGEST = { actor: 'system:ingest' };
const at = (sec: number) => new Date(AT.getTime() + sec * 1000);
const iso = (sec: number) => at(sec).toISOString();
const MINUTE = minuteOf(AT);
const MINUTE2 = minuteOf(at(60));

type Stub = IdentityResolver & { resolve: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; touch: ReturnType<typeof vi.fn> };

/** Kennt ALICE und BOB. `create` vergibt GHOST die feste pid PG und merkt sich neue Nutzer für spätere Auflösungen. */
function stubResolver(): Stub {
  const known = new Map<string, string>([[ALICE.id, P2], [BOB.id, P3]]);
  return {
    resolve: vi.fn(async (_c, ids: string[]) => new Map(ids.filter((id) => known.has(id)).map((id) => [id, known.get(id)!]))),
    create: vi.fn(async (_c, users: SignalUser[]) => {
      for (const u of users) known.set(u.id, u.id === GHOST.id ? PG : `bbbbbbbb-bbbb-4bbb-8bbb-${u.id.padStart(12, '0')}`);
      return new Map(users.map((u) => [u.id, known.get(u.id)!]));
    }),
    touch: vi.fn(async () => {}),
  };
}

const chatMsg = (user: SignalUser, text: string, sec: number, messageId = `m${sec}`) => ({ user, at: iso(sec), text, messageId });

function signals(over: Partial<ApplySignalsCmd> = {}): ApplySignalsCmd {
  return { giveawayId: GID, channel: P1, minute: MINUTE, presence: [ALICE, GHOST], chat: [], follows: [], ...over };
}

async function setup(settings: Record<string, unknown> = {}, over: Parameters<typeof setupGiveaway>[0] = {}) {
  const identities = stubResolver();
  const s = await setupGiveaway({ identities, ...over });
  close = s.close;
  await createOpen(s.rt, { kernelId: 'watchtime', settings: { prize: 'Key', channels: [P1], config: {}, counting: 'first_seen', keyword: '!go', ...settings } });
  return { ...s, identities };
}

const types = (events: { type: string }[]) => events.map((e) => e.type);
const kernel = async (rt: Awaited<ReturnType<typeof setup>>['rt']) => (await state(rt)).kernelState as WatchtimeState;

async function participantRows(pool: pg.Pool) {
  return (await pool.query('SELECT pid, registered, in_pool, weight, seen FROM giveaway_participants WHERE giveaway_id = $1 ORDER BY pid', [GID])).rows;
}

describe('apply_signals', () => {
  it('presence credits 60 s per present pid in one watch_credited with factor 1', async () => {
    const s = await setup();
    const events = await must(s.rt, s.rt.handlers.applySignals, signals({ presence: [ALICE, BOB] }), INGEST);
    expect(events.map((e) => [e.type, e.payload, e.actor])).toEqual([
      [FRAMEWORK_EVENTS.watchCredited, { minute: MINUTE, channel: P1, factor: 1, entries: [{ pid: P2, sec: 60 }, { pid: P3, sec: 60 }] }, 'system:ingest'],
    ]);
    expect(s.identities.touch.mock.calls[0]![1]).toEqual([P2, P3]);
    expect(s.identities.create).not.toHaveBeenCalled();
    expect((await kernel(s.rt)).sec).toEqual({ [P2]: { [P1]: 60 }, [P3]: { [P1]: 60 } });
  });

  it('first_seen creates identities for unknown present users and credits them', async () => {
    const s = await setup();
    const events = await must(s.rt, s.rt.handlers.applySignals, signals(), INGEST);
    expect(s.identities.create).toHaveBeenCalledOnce();
    expect(s.identities.create.mock.calls[0]![1]).toEqual([GHOST]);
    expect(events[0]!.payload).toMatchObject({ entries: [{ pid: P2, sec: 60 }, { pid: PG, sec: 60 }] });
    expect(s.identities.touch.mock.calls[0]![1]).toEqual([P2, PG]);
    expect(await participantRows(s.pool)).toEqual([
      { pid: P2, registered: false, in_pool: false, weight: 0, seen: true },
      { pid: PG, registered: false, in_pool: false, weight: 0, seen: true },
    ]);
    expect((await state(s.rt)).seen[PG]).toEqual({ since: AT.toISOString(), channels: [P1] });
  });

  it('registered counting credits only registered pids and creates no identity for an unknown chatter', async () => {
    const s = await setup({ counting: 'registered' });
    await must(s.rt, s.rt.handlers.register, { giveawayId: GID, pid: P2 }, { actor: userOf(P2) });
    const events = await must(
      s.rt,
      s.rt.handlers.applySignals,
      signals({ presence: [ALICE, BOB, GHOST], chat: [chatMsg(GHOST, 'hallo zusammen alle da', 3), chatMsg(BOB, 'hallo zusammen alle da', 4)] }),
      INGEST,
    );
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      [FRAMEWORK_EVENTS.watchCredited, { minute: MINUTE, channel: P1, factor: 1, entries: [{ pid: P2, sec: 60 }] }],
    ]);
    expect(s.identities.create).not.toHaveBeenCalled();
  });

  it('keyword in registered counting creates the identity and registers, then credits the same minute', async () => {
    const s = await setup({ counting: 'registered' });
    const events = await must(s.rt, s.rt.handlers.applySignals, signals({ presence: [GHOST, ALICE], chat: [chatMsg(GHOST, '!go', 5)] }), INGEST);
    expect(events.map((e) => [e.type, e.payload, e.actor])).toEqual([
      [FRAMEWORK_EVENTS.registered, { pid: PG }, 'system:ingest'],
      [FRAMEWORK_EVENTS.watchCredited, { minute: MINUTE, channel: P1, factor: 1, entries: [{ pid: PG, sec: 60 }] }, 'system:ingest'],
    ]);
    expect(s.identities.create.mock.calls[0]![1]).toEqual([GHOST]);
    const st = await state(s.rt);
    expect(st.registered[PG]).toMatchObject({ eventId: events[0]!.id });
    expect((await kernel(s.rt)).registered).toEqual([PG]);
  });

  it('keyword respects gateRegistration of the kernel and ignores already registered pids', async () => {
    const s = await setup({ counting: 'registered' });
    await must(s.rt, s.rt.handlers.register, { giveawayId: GID, pid: P2 }, { actor: userOf(P2) });
    expect(await must(s.rt, s.rt.handlers.applySignals, signals({ presence: null, chat: [chatMsg(ALICE, '!GO', 1), chatMsg(ALICE, '!go bitte', 2)] }), INGEST)).toEqual([]);
    // Kern B ohne offenes Fenster lehnt die Anmeldung ab: kein Ereignis, keine Ablehnung des Bündels.
    const gid2 = '66666666-6666-4666-8666-666666666670';
    await createOpen(s.rt, { giveawayId: gid2, kernelId: 'instant', settings: { prize: 'Key', channels: [P1], keyword: '!go' } });
    expect(await must(s.rt, s.rt.handlers.applySignals, signals({ giveawayId: gid2, presence: null, chat: [chatMsg(ALICE, '!go', 1)] }), INGEST)).toEqual([]);
  });

  it('a second bundle for the same channel and minute credits no watch time again', async () => {
    const s = await setup();
    await must(s.rt, s.rt.handlers.applySignals, signals({ presence: [ALICE] }), INGEST);
    expect(await must(s.rt, s.rt.handlers.applySignals, signals({ presence: [ALICE, BOB] }), INGEST)).toEqual([]);
    const next = await must(s.rt, s.rt.handlers.applySignals, signals({ presence: [ALICE], minute: MINUTE2 }), { ...INGEST, now: at(65) });
    expect(types(next)).toEqual([FRAMEWORK_EVENTS.watchCredited]);
    expect((await kernel(s.rt)).sec).toEqual({ [P2]: { [P1]: 120 } });
    expect((await state(s.rt)).watchMinutes).toEqual({ [P1]: MINUTE2 });
  });

  it('chat bonus: 4 words earn 2 s, 3 words nothing, cooldown 10 s across two bundles', async () => {
    const s = await setup();
    const first = await must(
      s.rt,
      s.rt.handlers.applySignals,
      signals({ presence: null, chat: [chatMsg(ALICE, 'eins zwei drei vier', 0), chatMsg(BOB, 'eins zwei drei', 1), chatMsg(ALICE, 'noch ein paar Wörter', 5), chatMsg(ALICE, 'a  b c   d', 12)] }),
      INGEST,
    );
    expect(first.map((e) => [e.type, e.payload])).toEqual([
      [FRAMEWORK_EVENTS.chatCredited, { minute: MINUTE, channel: P1, factor: 1, entries: [{ pid: P2, sec: 4, lastAt: iso(12) }] }],
    ]);
    expect((await state(s.rt)).chatLast).toEqual({ [P2]: iso(12) });
    expect(await must(s.rt, s.rt.handlers.applySignals, signals({ presence: null, chat: [chatMsg(ALICE, 'eins zwei drei vier', 17)] }), INGEST)).toEqual([]);
    const third = await must(s.rt, s.rt.handlers.applySignals, signals({ presence: null, chat: [chatMsg(ALICE, 'eins zwei drei vier', 22)] }), INGEST);
    expect(third[0]!.payload).toMatchObject({ entries: [{ pid: P2, sec: 2, lastAt: iso(22) }] });
    expect((await kernel(s.rt)).sec).toEqual({ [P2]: { [P1]: 6 } });
    expect((await state(s.rt)).seen[P2]).toEqual({ since: AT.toISOString(), channels: [P1] });
  });

  it('boost factor applies to watch and chat, factor 1 after until', async () => {
    const s = await setup();
    await must(s.rt, s.rt.handlers.startBoost, { giveawayId: GID, factor: 2, durationSec: 120 });
    const boosted = await must(s.rt, s.rt.handlers.applySignals, signals({ presence: [ALICE], chat: [chatMsg(ALICE, 'eins zwei drei vier', 3)] }), INGEST);
    expect(boosted.map((e) => [e.type, (e.payload as { factor: number }).factor])).toEqual([[FRAMEWORK_EVENTS.watchCredited, 2], [FRAMEWORK_EVENTS.chatCredited, 2]]);
    expect((await kernel(s.rt)).sec).toEqual({ [P2]: { [P1]: 124 } });
    // until = AT + 120 s: die Minute ab 12:02 liegt nicht mehr im Boost, auch wenn der Scheduler ihn noch nicht beendet hat.
    const after = await must(s.rt, s.rt.handlers.applySignals, signals({ presence: [ALICE], minute: minuteOf(at(120)) }), { ...INGEST, now: at(125) });
    expect(after.map((e) => [e.type, (e.payload as { factor: number }).factor])).toEqual([[FRAMEWORK_EVENTS.watchCredited, 1]]);
    expect((await state(s.rt)).boost).not.toBeNull();
  });

  it('chat bonus needs an active channel and enabled setting', async () => {
    const quiet = await setup({}, { activity: noActivity });
    const events = await must(quiet.rt, quiet.rt.handlers.applySignals, signals({ presence: [ALICE], chat: [chatMsg(ALICE, 'eins zwei drei vier', 0)] }), INGEST);
    expect(types(events)).toEqual([FRAMEWORK_EVENTS.watchCredited]);
    await close?.();
    close = undefined;
    const off = await setup({ chatBonus: { enabled: false, sec: 2, minWords: 4, cooldownSec: 10 } });
    expect(await must(off.rt, off.rt.handlers.applySignals, signals({ presence: null, chat: [chatMsg(ALICE, 'eins zwei drei vier', 0)] }), INGEST)).toEqual([]);
  });

  it('participants projection lists unregistered seen pids and the pool weight after two minutes', async () => {
    const s = await setup({ config: { coinBaseSec: 120 } });
    await must(s.rt, s.rt.handlers.applySignals, signals({ presence: [ALICE] }), INGEST);
    await must(s.rt, s.rt.handlers.applySignals, signals({ presence: [ALICE], minute: MINUTE2 }), { ...INGEST, now: at(65) });
    expect(await participantRows(s.pool)).toEqual([{ pid: P2, registered: false, in_pool: true, weight: 1, seen: true }]);
    expect((await s.pool.query('SELECT pool_size, pool_weight, registered_count FROM giveaways WHERE id = $1', [GID])).rows[0]).toEqual({ pool_size: 1, pool_weight: 1, registered_count: 0 });
  });

  it('rejects any actor other than system:ingest with not_ingest, also the streamer', async () => {
    const s = await setup();
    for (const actor of [STREAMER, 'system:scheduler', 'system:twitch']) {
      const r = await run(s.rt, s.rt.handlers.applySignals, signals(), { actor });
      expect(r).toMatchObject({ ok: false, rejection: { code: 'not_ingest', message: 'Signale nimmt nur der Ingest an.' } });
    }
    expect(s.identities.resolve).not.toHaveBeenCalled();
  });

  it('rejects a paused giveaway with not_open and a foreign channel with channel_not_in_giveaway', async () => {
    const s = await setup();
    const foreign = await run(s.rt, s.rt.handlers.applySignals, signals({ channel: P2 }), INGEST);
    expect(foreign).toMatchObject({ ok: false, rejection: { code: 'channel_not_in_giveaway' } });
    await must(s.rt, s.rt.handlers.pause, { giveawayId: GID });
    s.identities.resolve.mockClear();
    const paused = await run(s.rt, s.rt.handlers.applySignals, signals(), INGEST);
    expect(paused).toMatchObject({ ok: false, rejection: { code: 'not_open', message: 'Das Giveaway sammelt gerade nicht. Signale gehen nur im Zustand Offen.' } });
    expect(s.identities.resolve).not.toHaveBeenCalled();
    const missing = await run(s.rt, s.rt.handlers.applySignals, signals({ giveawayId: P3 }), INGEST);
    expect(missing).toMatchObject({ ok: false, rejection: { code: 'giveaway_not_found' } });
  });

  it('rejects a minute that is not on the full minute and a non-uuid channel', async () => {
    const s = await setup();
    expect(await run(s.rt, s.rt.handlers.applySignals, signals({ minute: iso(1) }), INGEST)).toMatchObject({ ok: false, rejection: { code: 'invalid_minute' } });
    expect(await run(s.rt, s.rt.handlers.applySignals, signals({ channel: 'kanal' }), INGEST)).toMatchObject({ ok: false, rejection: { code: 'invalid_id' } });
    expect(await run(s.rt, s.rt.handlers.applySignals, signals({ chat: 'x' as never }), INGEST)).toMatchObject({ ok: false, rejection: { code: 'invalid_signals' } });
  });

  it('identityResolver maps twitch ids, creates missing ones and touches last_seen_at at most once per hour', async () => {
    const db = await freshDb();
    close = db.close;
    await withTx(db.pool, (c) => upsertIdentity(c, ALICE, P2, at(-7200)));
    const r = identityResolver();
    expect(await r.resolve(db.pool, [ALICE.id, GHOST.id])).toEqual(new Map([[ALICE.id, P2]]));
    const created = await withTx(db.pool, (c) => r.create(c, [GHOST, ALICE], AT));
    expect(created.get(ALICE.id)).toBe(P2);
    const ghostPid = created.get(GHOST.id)!;
    expect(ghostPid).toMatch(/^[0-9a-f-]{36}$/);
    expect(await findIdentity(db.pool, ghostPid)).toMatchObject({ twitchId: GHOST.id, login: 'ghost', displayName: 'Ghost', createdAt: AT });
    await r.touch(db.pool, [P2], AT);
    expect((await findIdentity(db.pool, P2))!.lastSeenAt).toEqual(AT);
    await r.touch(db.pool, [P2], at(60));
    expect((await findIdentity(db.pool, P2))!.lastSeenAt).toEqual(AT);
  });
});
