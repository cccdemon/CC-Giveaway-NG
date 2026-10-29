import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { deleteIdentity, displayNameOf, findIdentity, findPidByTwitchId, upsertIdentity } from '../src/identity/identities.js';
import { SESSION_TTL_DAYS, createSession, deleteSession, deleteSessionsOf, findSession, purgeExpiredSessions } from '../src/identity/sessions.js';
import { deleteChannelToken, loadChannelToken, markTokenInvalid, saveChannelToken } from '../src/identity/tokens.js';
import { AT, freshDb } from './helpers/db.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const PID = '77777777-7777-4777-8777-777777777777';
const PID2 = '88888888-8888-4888-8888-888888888888';
const ALICE = { id: '12345', login: 'alice', displayName: 'Alice' };
const day = (n: number) => new Date(AT.getTime() + n * 86_400_000);

describe('identities', () => {
  it('creates with the candidate pid, then reuses the pid of the same twitch_id and updates login and last_seen_at', async () => {
    const db = await freshDb();
    close = db.close;
    const first = await withTx(db.pool, (c) => upsertIdentity(c, ALICE, PID, AT));
    expect(first).toBe(PID);
    const second = await withTx(db.pool, (c) => upsertIdentity(c, { ...ALICE, login: 'alice2', displayName: 'Alice II' }, PID2, day(1)));
    expect(second).toBe(PID);
    expect(await findIdentity(db.pool, PID)).toEqual({
      pid: PID, twitchId: '12345', login: 'alice2', displayName: 'Alice II', createdAt: AT, lastSeenAt: day(1),
    });
    expect(await findIdentity(db.pool, PID2)).toBeNull();
    expect(await findPidByTwitchId(db.pool, '12345')).toBe(PID);
    expect(await findPidByTwitchId(db.pool, '999')).toBeNull();
  });

  it('deleteIdentity removes the row', async () => {
    const db = await freshDb();
    close = db.close;
    await withTx(db.pool, (c) => upsertIdentity(c, ALICE, PID, AT));
    await withTx(db.pool, (c) => deleteIdentity(c, PID));
    expect(await findIdentity(db.pool, PID)).toBeNull();
  });

  it('displayNameOf falls back to „gelöschter Teilnehmer #<8 Zeichen>“', () => {
    expect(displayNameOf({ pid: PID, twitchId: '1', login: 'a', displayName: 'Alice', createdAt: AT, lastSeenAt: AT }, PID)).toBe('Alice');
    expect(displayNameOf(null, PID)).toBe('gelöschter Teilnehmer #77777777');
  });
});

describe('sessions', () => {
  it('creates a random id, finds it until it expires, purge counts expired ones', async () => {
    const db = await freshDb();
    close = db.close;
    const id = await createSession(db.pool, PID, AT);
    const other = await createSession(db.pool, PID, AT);
    expect(id).not.toBe(other);
    expect(id).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(await findSession(db.pool, id, AT)).toEqual({ pid: PID });
    expect(await findSession(db.pool, id, day(SESSION_TTL_DAYS - 1))).toEqual({ pid: PID });
    expect(await findSession(db.pool, id, day(SESSION_TTL_DAYS))).toBeNull();
    expect(await findSession(db.pool, 'unbekannt', AT)).toBeNull();
    expect(await purgeExpiredSessions(db.pool, day(SESSION_TTL_DAYS))).toBe(2);
    expect(await purgeExpiredSessions(db.pool, day(SESSION_TTL_DAYS))).toBe(0);
  });

  it('deleteSession and deleteSessionsOf', async () => {
    const db = await freshDb();
    close = db.close;
    const a = await createSession(db.pool, PID, AT);
    const b = await createSession(db.pool, PID, AT);
    const c = await createSession(db.pool, PID2, AT);
    await deleteSession(db.pool, a);
    expect(await findSession(db.pool, a, AT)).toBeNull();
    expect(await findSession(db.pool, b, AT)).toEqual({ pid: PID });
    await deleteSessionsOf(db.pool, PID);
    expect(await findSession(db.pool, b, AT)).toBeNull();
    expect(await findSession(db.pool, c, AT)).toEqual({ pid: PID2 });
  });
});

describe('channel tokens', () => {
  const key = randomBytes(32);
  const token = { accessToken: 'secret-access', refreshToken: 'secret-refresh', scopes: ['channel:bot'], expiresAt: day(1) };

  it('round-trips encrypted, the table never holds the plaintext', async () => {
    const db = await freshDb();
    close = db.close;
    await withTx(db.pool, (c) => saveChannelToken(c, PID, token, key, AT));
    expect(await loadChannelToken(db.pool, PID, key)).toEqual({ ...token, status: 'ok' });
    const raw = (await db.pool.query<{ access_token: Buffer; refresh_token: Buffer }>('SELECT access_token, refresh_token FROM channel_tokens')).rows[0]!;
    expect(raw.access_token.toString('latin1')).not.toContain('secret');
    expect(raw.refresh_token.toString('latin1')).not.toContain('secret');
    expect(await loadChannelToken(db.pool, PID2, key)).toBeNull();
  });

  it('save replaces, markTokenInvalid flags, delete removes', async () => {
    const db = await freshDb();
    close = db.close;
    await withTx(db.pool, (c) => saveChannelToken(c, PID, token, key, AT));
    await withTx(db.pool, (c) => saveChannelToken(c, PID, { ...token, accessToken: 'neu' }, key, day(1)));
    expect((await loadChannelToken(db.pool, PID, key))?.accessToken).toBe('neu');
    await markTokenInvalid(db.pool, PID, day(2));
    expect((await loadChannelToken(db.pool, PID, key))?.status).toBe('invalid');
    await withTx(db.pool, (c) => deleteChannelToken(c, PID));
    expect(await loadChannelToken(db.pool, PID, key)).toBeNull();
  });
});
