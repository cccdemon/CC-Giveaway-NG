import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTx } from '../src/db/pool.js';
import type { ApplySignalsCmd, IdentityResolver } from '../src/framework/giveaway/signals.js';
import { findIdentity, upsertIdentity } from '../src/identity/identities.js';
import { identityResolver } from '../src/identity/resolver.js';
import { minuteOf } from '../src/ingest/bundler.js';
import type { SignalUser } from '../src/ingest/signals.js';
import { AT, freshDb } from './helpers/db.js';
import { GID, P1, P2, P3, STREAMER, createOpen, must, run, setupGiveaway } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const ALICE: SignalUser = { id: '12345', login: 'alice', displayName: 'Alice' };
const BOB: SignalUser = { id: '67890', login: 'bob', displayName: 'Bob' };
const GHOST: SignalUser = { id: '99', login: 'ghost', displayName: 'Ghost' };
const INGEST = { actor: 'system:ingest' };
const at = (sec: number) => new Date(AT.getTime() + sec * 1000);

function stubResolver(): IdentityResolver & { resolve: ReturnType<typeof vi.fn>; touch: ReturnType<typeof vi.fn> } {
  return {
    resolve: vi.fn(async (_c, ids: string[]) => new Map(ids.filter((id) => id === ALICE.id || id === BOB.id).map((id) => [id, id === ALICE.id ? P2 : P3]))),
    touch: vi.fn(async () => {}),
  };
}

function signals(over: Partial<ApplySignalsCmd> = {}): ApplySignalsCmd {
  return { giveawayId: GID, channel: P1, minute: minuteOf(AT), presence: [ALICE, GHOST], chat: [{ user: BOB, at: at(5).toISOString(), text: 'hi', messageId: 'm1' }], follows: [], ...over };
}

async function setup() {
  const identities = stubResolver();
  const s = await setupGiveaway({ identities });
  close = s.close;
  await createOpen(s.rt);
  return { ...s, identities };
}

describe('apply_signals', () => {
  it('accepts signals for an open giveaway from system:ingest, writes no event, resolves known users and drops unknown ones', async () => {
    const s = await setup();
    const r = await run(s.rt, s.rt.handlers.applySignals, signals(), INGEST);
    expect(r).toEqual({ ok: true, events: [] });
    expect(s.identities.resolve).toHaveBeenCalledOnce();
    expect(s.identities.resolve.mock.calls[0]![1]).toEqual([ALICE.id, GHOST.id, BOB.id]);
    expect(s.identities.touch.mock.calls[0]![1]).toEqual([P2]);
    const events = (await s.pool.query("SELECT count(*)::int AS n FROM events WHERE type NOT LIKE 'giveaway_%'")).rows[0];
    expect(events).toEqual({ n: 0 });
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
    expect(await run(s.rt, s.rt.handlers.applySignals, signals({ minute: at(1).toISOString() }), INGEST)).toMatchObject({ ok: false, rejection: { code: 'invalid_minute' } });
    expect(await run(s.rt, s.rt.handlers.applySignals, signals({ channel: 'kanal' }), INGEST)).toMatchObject({ ok: false, rejection: { code: 'invalid_id' } });
    expect(await run(s.rt, s.rt.handlers.applySignals, signals({ chat: 'x' as never }), INGEST)).toMatchObject({ ok: false, rejection: { code: 'invalid_signals' } });
  });

  it('prepare touches last_seen_at only for present users', async () => {
    const s = await setup();
    await run(s.rt, s.rt.handlers.applySignals, signals({ presence: null }), INGEST);
    expect(s.identities.touch.mock.calls[0]![1]).toEqual([]);
  });

  it('identityResolver maps twitch ids to pids from identities and touches last_seen_at at most once per hour', async () => {
    const db = await freshDb();
    close = db.close;
    await withTx(db.pool, (c) => upsertIdentity(c, ALICE, P2, at(-7200)));
    const r = identityResolver();
    expect(await r.resolve(db.pool, [ALICE.id, GHOST.id])).toEqual(new Map([[ALICE.id, P2]]));
    await r.touch(db.pool, [P2], AT);
    expect((await findIdentity(db.pool, P2))!.lastSeenAt).toEqual(AT);
    await r.touch(db.pool, [P2], at(60));
    expect((await findIdentity(db.pool, P2))!.lastSeenAt).toEqual(AT);
  });
});
