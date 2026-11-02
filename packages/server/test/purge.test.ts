import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { dueForPurge, purgeUnregisteredAll } from '../src/framework/giveaway/purge.js';
import { SERVICE_EVENT_TYPES } from '../src/framework/giveaway/services.js';
import { findIdentity, findPidByTwitchId, upsertIdentity } from '../src/identity/identities.js';
import { identityResolver } from '../src/identity/resolver.js';
import { attachAccounts } from '../src/identity/runtime.js';
import { minuteOf } from '../src/ingest/bundler.js';
import type { SignalUser } from '../src/ingest/signals.js';
import { AT } from './helpers/db.js';
import { ctx } from './helpers/fixtures.js';
import { GID, GID2, GID3, GID4, P1, P2, P3, createOpen, must, run, setupGiveaway, state, userOf } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const ALICE: SignalUser = { id: '12345', login: 'alice', displayName: 'Alice' };
const BOB: SignalUser = { id: '67890', login: 'bob', displayName: 'Bob' };
const GHOST: SignalUser = { id: '99', login: 'ghost', displayName: 'Ghost' };
const INGEST = { actor: 'system:ingest' };
const SCHEDULER = { actor: 'system:scheduler' };
const day = (n: number) => new Date(AT.getTime() + n * 86_400_000);

async function setup() {
  const s = await setupGiveaway({ identities: identityResolver() });
  close = s.close;
  const accounts = attachAccounts(s.rt, { tokenKey: randomBytes(32) });
  await withTx(s.pool, async (c) => {
    await upsertIdentity(c, ALICE, P2, AT);
    await upsertIdentity(c, BOB, P3, AT);
  });
  return { ...s, accounts };
}

const firstSeen = (giveawayId: string, purgeDays = 7) => ({ giveawayId, kernelId: 'watchtime', settings: { prize: 'Key', channels: [P1], config: {}, counting: 'first_seen' as const, purgeDays } });
const presence = (giveawayId: string, users: SignalUser[]) => ({ giveawayId, channel: P1, minute: minuteOf(AT), presence: users, chat: [], follows: [] });
const purge = (giveawayId = GID) => ({ giveawayId });

describe('purge_unregistered', () => {
  it('purges unregistered seen pids after close + purgeDays, identities rows vanish, registered pids stay', async () => {
    const s = await setup();
    await createOpen(s.rt, firstSeen(GID));
    await must(s.rt, s.rt.handlers.register, { giveawayId: GID, pid: P3 }, { actor: userOf(P3) });
    await must(s.rt, s.rt.handlers.applySignals, presence(GID, [ALICE, BOB, GHOST]), INGEST);
    const pg = (await findPidByTwitchId(s.pool, GHOST.id))!;
    await must(s.rt, s.rt.handlers.close, purge());
    const events = await must(s.rt, s.rt.handlers.purgeUnregistered, purge(), { ...SCHEDULER, now: day(7) });
    expect(events.map((e) => [e.type, e.payload, e.actor])).toEqual([[SERVICE_EVENT_TYPES.unregisteredPurged, { pids: [P2, pg].sort() }, 'system:scheduler']]);
    expect(await findIdentity(s.pool, P2)).toBeNull();
    expect(await findIdentity(s.pool, pg)).toBeNull();
    expect(await findIdentity(s.pool, P3)).not.toBeNull();
    expect((await state(s.rt)).purgedAt).toBe(day(7).toISOString());
    expect((await s.pool.query('SELECT purged_at FROM giveaways WHERE id = $1', [GID])).rows[0]).toEqual({ purged_at: day(7) });
  });

  it('keeps a pid with an account and a pid seen in another running giveaway', async () => {
    const s = await setup();
    const signedIn = await s.rt.bus.execute(s.accounts.signIn, { pid: P2, soloTeamId: P2, user: ALICE }, ctx({ actor: 'system:twitch' }));
    expect(signedIn.ok).toBe(true);
    await createOpen(s.rt, firstSeen(GID));
    await createOpen(s.rt, firstSeen(GID2));
    await must(s.rt, s.rt.handlers.applySignals, presence(GID, [ALICE, BOB, GHOST]), INGEST);
    await must(s.rt, s.rt.handlers.applySignals, presence(GID2, [BOB]), INGEST);
    const pg = (await findPidByTwitchId(s.pool, GHOST.id))!;
    await must(s.rt, s.rt.handlers.close, purge());
    const events = await must(s.rt, s.rt.handlers.purgeUnregistered, purge(), { ...SCHEDULER, now: day(7) });
    expect(events[0]!.payload).toEqual({ pids: [pg] });
    expect(await findIdentity(s.pool, P2)).not.toBeNull();
    expect(await findIdentity(s.pool, P3)).not.toBeNull();
    expect(await findIdentity(s.pool, pg)).toBeNull();
  });

  it('keeps a pid that is registered or a winner in a giveaway that is no longer running', async () => {
    const s = await setup();
    await createOpen(s.rt, firstSeen(GID));
    // BOB (P3) hat kein Konto, gewinnt aber Giveaway 2 (Kern B, Zustand Gezogen).
    await createOpen(s.rt, { giveawayId: GID2, settings: { prize: 'Key', channels: [P1] } });
    await must(s.rt, s.rt.handlers.kernelCommand, { giveawayId: GID2, command: { type: 'open_window', args: {} } });
    await must(s.rt, s.rt.handlers.register, { giveawayId: GID2, pid: P3 }, { actor: userOf(P3) });
    await must(s.rt, s.rt.handlers.close, { giveawayId: GID2 });
    await must(s.rt, s.rt.handlers.draw, { giveawayId: GID2 });
    expect((await state(s.rt, GID2)).status).toBe('drawn');
    await must(s.rt, s.rt.handlers.applySignals, presence(GID, [BOB, GHOST]), INGEST);
    const pg = (await findPidByTwitchId(s.pool, GHOST.id))!;
    await must(s.rt, s.rt.handlers.close, purge());
    const events = await must(s.rt, s.rt.handlers.purgeUnregistered, purge(), { ...SCHEDULER, now: day(7) });
    expect(events[0]!.payload).toEqual({ pids: [pg] });
    expect(await findIdentity(s.pool, P3)).not.toBeNull();
  });

  it('rejects before the deadline, before closing and a second time, streamer may run it too', async () => {
    const s = await setup();
    await createOpen(s.rt, firstSeen(GID));
    await must(s.rt, s.rt.handlers.applySignals, presence(GID, [ALICE]), INGEST);
    expect(await run(s.rt, s.rt.handlers.purgeUnregistered, purge(), { ...SCHEDULER, now: day(8) })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'purge_not_closed', message: 'Die Löschung läuft erst nach dem Schließen.' },
    });
    await must(s.rt, s.rt.handlers.close, purge());
    expect(await run(s.rt, s.rt.handlers.purgeUnregistered, purge(), { ...SCHEDULER, now: day(6) })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'purge_not_due', message: 'Die Löschfrist ist noch nicht um.' },
    });
    expect((await run(s.rt, s.rt.handlers.purgeUnregistered, purge(), { now: day(7) })).ok).toBe(true);
    expect(await run(s.rt, s.rt.handlers.purgeUnregistered, purge(), { ...SCHEDULER, now: day(8) })).toMatchObject({ ok: false, rejection: { code: 'already_purged' } });
    expect(await run(s.rt, s.rt.handlers.purgeUnregistered, purge(GID2), SCHEDULER)).toMatchObject({ ok: false, rejection: { code: 'giveaway_not_found' } });
  });

  it('dueForPurge lists only first_seen giveaways past the deadline without purged_at', async () => {
    const s = await setup();
    await createOpen(s.rt, firstSeen(GID));
    await createOpen(s.rt, { giveawayId: GID2, settings: { prize: 'Key', channels: [P1] } });
    await createOpen(s.rt, firstSeen(GID3));
    await createOpen(s.rt, firstSeen(GID4, 30));
    for (const giveawayId of [GID, GID2, GID4]) await must(s.rt, s.rt.handlers.close, { giveawayId });
    expect(await dueForPurge(s.pool, day(6))).toEqual([]);
    expect(await dueForPurge(s.pool, day(7))).toEqual([GID]);
    await must(s.rt, s.rt.handlers.purgeUnregistered, purge(), { ...SCHEDULER, now: day(7) });
    expect(await dueForPurge(s.pool, day(7))).toEqual([]);
    expect(await dueForPurge(s.pool, day(30))).toEqual([GID4]);
    await must(s.rt, s.rt.handlers.cancel, { giveawayId: GID3 }, { now: day(1) });
    expect(await dueForPurge(s.pool, day(8))).toEqual([GID3]);
  });

  it('purgeUnregisteredAll runs as system:scheduler and counts', async () => {
    const s = await setup();
    await createOpen(s.rt, firstSeen(GID));
    await must(s.rt, s.rt.handlers.applySignals, presence(GID, [ALICE, GHOST]), INGEST);
    await must(s.rt, s.rt.handlers.close, purge());
    expect(await purgeUnregisteredAll(s.pool, s.rt, day(6))).toEqual({ purged: 0, pids: 0, failed: 0 });
    expect(await purgeUnregisteredAll(s.pool, s.rt, day(7))).toEqual({ purged: 1, pids: 2, failed: 0 });
    const last = (await s.pool.query('SELECT type, actor FROM events ORDER BY id DESC LIMIT 1')).rows[0];
    expect(last).toEqual({ type: SERVICE_EVENT_TYPES.unregisteredPurged, actor: 'system:scheduler' });
    expect(await purgeUnregisteredAll(s.pool, s.rt, day(7))).toEqual({ purged: 0, pids: 0, failed: 0 });
  });
});
