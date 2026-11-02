import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { GateCheckError, type GateCheckInput } from '../src/framework/giveaway/gates.js';
import { upsertIdentity } from '../src/identity/identities.js';
import { helixGateChecker } from '../src/ingest/twitch/gates.js';
import { HelixError, type HelixClient } from '../src/ingest/twitch/helix.js';
import type { ChannelTokenProvider } from '../src/ingest/twitch/tokens.js';
import { AT, freshDb } from './helpers/db.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const PA = '77777777-7777-4777-8777-777777777777';
const PB = '88888888-8888-4888-8888-888888888888';
const PX = '99999999-9999-4999-8999-999999999999';
const CHAN = '11111111-1111-4111-8111-111111111111';
const CHAN2 = '22222222-2222-4222-8222-222222222222';
const ALICE = { id: '12345', login: 'alice', displayName: 'Alice' };
const BOB = { id: '67890', login: 'bob', displayName: 'Bob' };
const OWNER = { id: '1001', login: 'owner', displayName: 'Owner' };
const day = (n: number) => new Date(AT.getTime() - n * 86_400_000).toISOString();

function fakes() {
  const isFollower = vi.fn(async (_b: string, u: string) => ({ userId: u, follows: u === ALICE.id, since: u === ALICE.id ? day(100) : null }));
  const getUsers = vi.fn(async (ids: string[]) => ids.map((id) => ({ id, login: 'x', displayName: 'X', createdAt: id === ALICE.id ? day(400) : day(5) })));
  const helix = { isFollower, getUsers } as unknown as HelixClient;
  const tokens: ChannelTokenProvider & { accessTokenFor: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> } = {
    accessTokenFor: vi.fn(async () => 'tok'),
    invalidate: vi.fn(async () => {}),
  };
  return { helix, isFollower, getUsers, tokens, checker: helixGateChecker({ helix, tokens }) };
}

async function setup() {
  const db = await freshDb();
  close = db.close;
  await withTx(db.pool, async (c) => {
    await upsertIdentity(c, ALICE, PA, AT);
    await upsertIdentity(c, BOB, PB, AT);
    await upsertIdentity(c, OWNER, CHAN, AT);
  });
  return db;
}

const input = (over: Partial<GateCheckInput> = {}): GateCheckInput => ({
  channels: [CHAN],
  gates: [{ id: 'follow', mode: 'all' }, { id: 'account_age', days: 30 }],
  pids: [PA, PB, PX],
  seen: {},
  now: AT,
  ...over,
});

describe('helixGateChecker', () => {
  it('builds follow and account facts and evaluates', async () => {
    const db = await setup();
    const f = fakes();
    expect(await f.checker.check(db.pool, input())).toEqual([
      { pid: PA, ok: true, reasons: [] },
      { pid: PB, ok: false, reasons: [`follow:${CHAN}`, 'account_age'] },
      { pid: PX, ok: false, reasons: ['identity_deleted'] },
    ]);
    expect(f.tokens.accessTokenFor).toHaveBeenCalledWith(CHAN);
    expect(f.isFollower.mock.calls.map((c) => c.slice(0, 3))).toEqual([[OWNER.id, ALICE.id, 'tok'], [OWNER.id, BOB.id, 'tok']]);
    expect(f.getUsers).toHaveBeenCalledOnce();
    expect(f.getUsers.mock.calls[0]![0]).toEqual([ALICE.id, BOB.id]);
  });

  it('asks only for what the gates need: no gates → no Helix, presence → seen only, channel mode → that channel only', async () => {
    const db = await setup();
    const f = fakes();
    expect(await f.checker.check(db.pool, input({ gates: [] }))).toEqual([PA, PB, PX].map((pid) => ({ pid, ok: true, reasons: [] })));
    expect(f.isFollower).not.toHaveBeenCalled();
    expect(f.getUsers).not.toHaveBeenCalled();
    expect(f.tokens.accessTokenFor).not.toHaveBeenCalled();
    expect(await f.checker.check(db.pool, input({ gates: [{ id: 'presence', minChannels: 1 }], pids: [PA, PB], seen: { [PA]: [CHAN] } }))).toEqual([
      { pid: PA, ok: true, reasons: [] },
      { pid: PB, ok: false, reasons: ['presence'] },
    ]);
    expect(f.isFollower).not.toHaveBeenCalled();
    await f.checker.check(db.pool, input({ channels: [CHAN, CHAN2], gates: [{ id: 'follow', mode: 'channel', channel: CHAN }], pids: [PA] }));
    expect(f.tokens.accessTokenFor.mock.calls).toEqual([[CHAN]]);
  });

  it('missing channel token → token_invalid, HelixError → twitch_unreachable, unauthorized invalidates the token', async () => {
    const db = await setup();
    const f = fakes();
    f.tokens.accessTokenFor.mockResolvedValueOnce(null);
    await expect(f.checker.check(db.pool, input())).rejects.toEqual(new GateCheckError('token_invalid', 'Ein Kanal des Giveaways ist nicht verbunden. Verbinde ihn neu, dann ziehe.'));
    // Kanal ohne Identität (CHAN2) ist genauso nicht verbunden.
    await expect(f.checker.check(db.pool, input({ channels: [CHAN2] }))).rejects.toMatchObject({ code: 'token_invalid' });
    f.isFollower.mockRejectedValueOnce(new HelixError('helix_unreachable', null, null));
    await expect(f.checker.check(db.pool, input())).rejects.toEqual(new GateCheckError('twitch_unreachable', 'Twitch antwortet nicht. Versuche die Ziehung später erneut.'));
    f.isFollower.mockRejectedValueOnce(new HelixError('helix_unauthorized', 401, null));
    await expect(f.checker.check(db.pool, input())).rejects.toMatchObject({ code: 'token_invalid' });
    expect(f.tokens.invalidate).toHaveBeenCalledWith(CHAN);
    f.isFollower.mockRejectedValueOnce(new HelixError('helix_forbidden', 403, null));
    await expect(f.checker.check(db.pool, input())).rejects.toMatchObject({ code: 'token_invalid' });
    expect(f.tokens.invalidate).toHaveBeenCalledTimes(2);
    f.getUsers.mockRejectedValueOnce(new HelixError('helix_error', 500, null));
    await expect(f.checker.check(db.pool, input({ gates: [{ id: 'account_age', days: 30 }] }))).rejects.toMatchObject({ code: 'twitch_unreachable' });
  });
});
