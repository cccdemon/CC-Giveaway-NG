import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { loadChannelToken, saveChannelToken } from '../src/identity/tokens.js';
import { TwitchError, type TwitchAuthClient } from '../src/identity/twitch.js';
import { TOKEN_REFRESH_BEFORE_SEC, channelTokenProvider } from '../src/ingest/twitch/tokens.js';
import { AT, freshDb } from './helpers/db.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const PID = '77777777-7777-4777-8777-777777777777';
const KEY = randomBytes(32);
const at = (sec: number) => new Date(AT.getTime() + sec * 1000);

async function setup(expiresInSec: number, refresh: TwitchAuthClient['refresh']) {
  const db = await freshDb();
  close = db.close;
  await withTx(db.pool, (c) => saveChannelToken(c, PID, { accessToken: 'acc-1', refreshToken: 'ref-1', scopes: ['s'], expiresAt: at(expiresInSec) }, KEY, AT));
  const auth: TwitchAuthClient = { authorizeUrl: () => '', exchangeCode: async () => { throw new Error('nicht im Test'); }, refresh, getUser: async () => { throw new Error('nicht im Test'); } };
  const clock = { now: AT };
  const log = { error: vi.fn() };
  const tokens = channelTokenProvider({ pool: db.pool, key: KEY, auth, now: () => clock.now, log });
  return { db, tokens, clock, log };
}

describe('channelTokenProvider', () => {
  it('returns the stored token while it is fresh', async () => {
    const refresh = vi.fn();
    const s = await setup(3600, refresh);
    expect(await s.tokens.accessTokenFor(PID)).toBe('acc-1');
    expect(refresh).not.toHaveBeenCalled();
    expect(await s.tokens.accessTokenFor('88888888-8888-4888-8888-888888888888')).toBeNull();
  });

  it('refreshes a token that expires within 5 minutes and stores the new one', async () => {
    const refresh = vi.fn(async () => ({ accessToken: 'acc-2', refreshToken: 'ref-2', expiresIn: 7200, scopes: ['s'] }));
    const s = await setup(TOKEN_REFRESH_BEFORE_SEC - 1, refresh);
    expect(await s.tokens.accessTokenFor(PID)).toBe('acc-2');
    expect(refresh).toHaveBeenCalledWith('ref-1');
    expect(await loadChannelToken(s.db.pool, PID, KEY)).toEqual({ accessToken: 'acc-2', refreshToken: 'ref-2', scopes: ['s'], expiresAt: at(7200), status: 'ok' });
    expect(await s.tokens.accessTokenFor(PID)).toBe('acc-2');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('twitch_denied on refresh marks the token invalid and returns null, later calls do not call twitch again', async () => {
    const refresh = vi.fn(async () => { throw new TwitchError('twitch_denied'); });
    const s = await setup(10, refresh);
    expect(await s.tokens.accessTokenFor(PID)).toBeNull();
    expect((await loadChannelToken(s.db.pool, PID, KEY))!.status).toBe('invalid');
    expect(await s.tokens.accessTokenFor(PID)).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
    expect(s.log.error).toHaveBeenCalledOnce();
  });

  it('twitch_unreachable keeps the old token until it is expired', async () => {
    const refresh = vi.fn(async () => { throw new TwitchError('twitch_unreachable'); });
    const s = await setup(10, refresh);
    expect(await s.tokens.accessTokenFor(PID)).toBe('acc-1');
    expect((await loadChannelToken(s.db.pool, PID, KEY))!.status).toBe('ok');
    s.clock.now = at(11);
    expect(await s.tokens.accessTokenFor(PID)).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('refreshes one pid only once at a time', async () => {
    let resolve: (t: { accessToken: string; refreshToken: string; expiresIn: number; scopes: string[] }) => void = () => {};
    const refresh = vi.fn(() => new Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scopes: string[] }>((r) => { resolve = r; }));
    const s = await setup(10, refresh);
    const a = s.tokens.accessTokenFor(PID);
    const b = s.tokens.accessTokenFor(PID);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    resolve({ accessToken: 'acc-2', refreshToken: 'ref-2', expiresIn: 7200, scopes: ['s'] });
    expect(await Promise.all([a, b])).toEqual(['acc-2', 'acc-2']);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('invalidate marks the token invalid', async () => {
    const s = await setup(3600, vi.fn());
    await s.tokens.invalidate(PID);
    expect((await loadChannelToken(s.db.pool, PID, KEY))!.status).toBe('invalid');
    expect(await s.tokens.accessTokenFor(PID)).toBeNull();
  });
});
