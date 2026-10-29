import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandContext, CommandHandler, CommandResult } from '../src/framework/command-bus.js';
import { loadStreamState } from '../src/framework/state.js';
import { ACCOUNT_EVENTS, accountReducer, accountStream, type AccountState } from '../src/identity/account/state.js';
import { findIdentity } from '../src/identity/identities.js';
import { createSession, findSession } from '../src/identity/sessions.js';
import { PLATFORM_TERMS_VERSION } from '../src/identity/terms.js';
import { loadChannelToken } from '../src/identity/tokens.js';
import { REQUIRED_CHANNEL_SCOPES } from '../src/identity/twitch.js';
import { attachAccounts, type AccountHandlers } from '../src/identity/runtime.js';
import { readStream } from '../src/journal/journal.js';
import { AT } from './helpers/db.js';
import { ctx } from './helpers/fixtures.js';
import type pg from 'pg';
import type { Runtime } from '../src/framework/runtime.js';
import { setupGiveaway } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const PID = '77777777-7777-4777-8777-777777777777';
const PID2 = '88888888-8888-4888-8888-888888888888';
const SOLO = '55555555-5555-4555-8555-555555555555';
const ALICE = { id: '12345', login: 'alice', displayName: 'Alice' };
const KEY = randomBytes(32);
const me = (pid: string) => `user:${pid}`;
const day = (n: number) => new Date(AT.getTime() + n * 86_400_000);
const SCOPES = [...REQUIRED_CHANNEL_SCOPES];
const token = (over: Partial<{ scopes: string[] }> = {}) => ({ accessToken: 'acc', refreshToken: 'ref', expiresIn: 3600, scopes: SCOPES, ...over });

async function setup() {
  const s = await setupGiveaway();
  close = s.close;
  const accounts = attachAccounts(s.rt, { tokenKey: KEY });
  return { ...s, accounts };
}

async function run<C, S, P, Q>(rt: Runtime, h: CommandHandler<C, S, P, Q>, cmd: C, over: Partial<CommandContext> = {}): Promise<CommandResult> {
  return rt.bus.execute(h, cmd, ctx({ actor: me(PID), ...over }));
}

async function code(p: Promise<CommandResult>): Promise<string> {
  const r = await p;
  return r.ok ? 'ok' : r.rejection.code;
}

async function must<C, S, P, Q>(rt: Runtime, h: CommandHandler<C, S, P, Q>, cmd: C, over: Partial<CommandContext> = {}) {
  const r = await run(rt, h, cmd, over);
  if (!r.ok) throw new Error(`${h.type} abgelehnt: ${r.rejection.code}: ${r.rejection.message}`);
  return r.events;
}

async function signIn(rt: Runtime, a: AccountHandlers, over: Partial<{ pid: string; soloTeamId: string; user: typeof ALICE }> = {}, now = AT) {
  return must(rt, a.signIn, { pid: PID, soloTeamId: SOLO, user: ALICE, ...over }, { actor: 'system:twitch', now });
}

async function fullAccount(rt: Runtime, a: AccountHandlers) {
  await signIn(rt, a);
  await must(rt, a.acceptTerms, { pid: PID, version: PLATFORM_TERMS_VERSION });
  await must(rt, a.connectChannel, { pid: PID, twitchId: ALICE.id, token: token() });
}

async function state(pool: pg.Pool, rt: Runtime, pid = PID): Promise<AccountState> {
  const c = await pool.connect();
  try {
    return await loadStreamState(c, rt.registry, accountStream(pid), accountReducer);
  } finally {
    c.release();
  }
}

describe('Konto-Strom', () => {
  it('sign-in creates identity, account_created and the accounts row; second sign-in writes no event but updates last_seen_at', async () => {
    const { pool, rt, accounts } = await setup();
    const events = await signIn(rt, accounts);
    expect(events.map((e) => e.type)).toEqual([ACCOUNT_EVENTS.created]);
    expect(events[0]!.payload).toEqual({ soloTeamId: SOLO });
    expect(await findIdentity(pool, PID)).toMatchObject({ twitchId: '12345', login: 'alice', displayName: 'Alice', lastSeenAt: AT });
    const row = (await pool.query('SELECT * FROM accounts WHERE pid = $1', [PID])).rows[0];
    expect(row).toMatchObject({ pid: PID, solo_team_id: SOLO, terms_version: 0, channel_connected: false, legal: { impressumUrl: null, terms: null, privacyUrl: null }, deleted: false, last_seq: 1 });

    const again = await signIn(rt, accounts, { soloTeamId: PID2, user: { ...ALICE, displayName: 'Alice II' } }, day(1));
    expect(again).toEqual([]);
    expect(await findIdentity(pool, PID)).toMatchObject({ displayName: 'Alice II', lastSeenAt: day(1) });
    expect((await state(pool, rt)).soloTeamId).toBe(SOLO);
  });

  it('sign-in with a foreign candidate pid for a known twitch_id is rejected with pid_mismatch and writes nothing', async () => {
    const { pool, rt, accounts } = await setup();
    await signIn(rt, accounts);
    const r = await run(rt, accounts.signIn, { pid: PID2, soloTeamId: PID2, user: ALICE }, { actor: 'system:twitch' });
    expect(r).toMatchObject({ ok: false, rejection: { code: 'pid_mismatch' } });
    expect(await findIdentity(pool, PID2)).toBeNull();
    expect((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0]).toEqual({ n: 1 });
  });

  it('payloads of the whole account stream contain neither login nor twitch id', async () => {
    const { pool, rt, accounts } = await setup();
    await fullAccount(rt, accounts);
    await must(rt, accounts.updateProfile, { pid: PID, legal: { impressumUrl: 'https://streamer.example/impressum' } });
    await must(rt, accounts.disconnectChannel, { pid: PID });
    await must(rt, accounts.deleteAccount, { pid: PID });
    const c = await pool.connect();
    const events = await readStream(c, rt.registry, accountStream(PID));
    c.release();
    const text = JSON.stringify(events.map((e) => e.payload));
    expect(text).not.toContain('alice');
    expect(text).not.toContain('12345');
    expect(text).not.toContain('acc');
    expect(events.map((e) => e.type)).toEqual([
      ACCOUNT_EVENTS.created, ACCOUNT_EVENTS.termsAccepted, ACCOUNT_EVENTS.channelConnected,
      ACCOUNT_EVENTS.profileUpdated, ACCOUNT_EVENTS.channelDisconnected, ACCOUNT_EVENTS.deleted,
    ]);
  });

  it('accept terms: stale version rejected, current accepted once, second time no event; revert withdraws', async () => {
    const { pool, rt, accounts } = await setup();
    await signIn(rt, accounts);
    expect(await code(run(rt, accounts.acceptTerms, { pid: PID, version: PLATFORM_TERMS_VERSION + 1 }))).toBe('terms_version_stale');
    const [accepted] = await must(rt, accounts.acceptTerms, { pid: PID, version: PLATFORM_TERMS_VERSION });
    expect(accepted!.payload).toEqual({ version: PLATFORM_TERMS_VERSION, previous: 0 });
    expect(await must(rt, accounts.acceptTerms, { pid: PID, version: PLATFORM_TERMS_VERSION })).toEqual([]);
    expect((await pool.query('SELECT terms_version FROM accounts WHERE pid = $1', [PID])).rows[0]).toEqual({ terms_version: PLATFORM_TERMS_VERSION });

    const [withdrawn] = await must(rt, accounts.revert, { stream: accountStream(PID), eventId: accepted!.id, reason: 'Versehen' });
    expect(withdrawn!.type).toBe(ACCOUNT_EVENTS.termsWithdrawn);
    expect(withdrawn!.reversesEventId).toBe(accepted!.id);
    expect((await state(pool, rt)).termsVersion).toBe(0);
    expect((await pool.query('SELECT terms_version FROM accounts WHERE pid = $1', [PID])).rows[0]).toEqual({ terms_version: 0 });
  });

  it('update profile merges fields, rejects bad urls, no event on no change', async () => {
    const { pool, rt, accounts } = await setup();
    await signIn(rt, accounts);
    const [e1] = await must(rt, accounts.updateProfile, { pid: PID, legal: { impressumUrl: 'https://alice.example/impressum' } });
    expect(e1!.payload).toEqual({
      before: { impressumUrl: null, terms: null, privacyUrl: null },
      after: { impressumUrl: 'https://alice.example/impressum', terms: null, privacyUrl: null },
    });
    await must(rt, accounts.updateProfile, { pid: PID, legal: { terms: { text: 'Teilnahme ab 18.' }, privacyUrl: 'https://alice.example/datenschutz' } });
    expect((await state(pool, rt)).legal).toEqual({
      impressumUrl: 'https://alice.example/impressum', terms: { text: 'Teilnahme ab 18.' }, privacyUrl: 'https://alice.example/datenschutz',
    });
    expect((await pool.query('SELECT legal FROM accounts WHERE pid = $1', [PID])).rows[0]!.legal).toMatchObject({ terms: { text: 'Teilnahme ab 18.' } });
    expect(await must(rt, accounts.updateProfile, { pid: PID, legal: { privacyUrl: 'https://alice.example/datenschutz' } })).toEqual([]);
    expect(await code(run(rt, accounts.updateProfile, { pid: PID, legal: { impressumUrl: 'javascript:alert(1)' } }))).toBe('invalid_url');
    expect(await code(run(rt, accounts.updateProfile, { pid: PID, legal: { terms: { text: 'x'.repeat(20001) } } }))).toBe('terms_too_long');
    expect(await code(run(rt, accounts.updateProfile, { pid: PID, legal: { terms: 'nur text' } as never }))).toBe('invalid_legal');
  });

  it('connect channel stores encrypted token, requires all three scopes, rejects a foreign twitch account and rolls the token back', async () => {
    const { pool, rt, accounts } = await setup();
    await signIn(rt, accounts);
    expect(await code(run(rt, accounts.connectChannel, { pid: PID, twitchId: ALICE.id, token: token({ scopes: ['channel:bot'] }) }))).toBe('scopes_missing');
    expect(await loadChannelToken(pool, PID, KEY)).toBeNull();
    expect(await code(run(rt, accounts.connectChannel, { pid: PID, twitchId: '999', token: token() }))).toBe('wrong_twitch_account');
    expect(await loadChannelToken(pool, PID, KEY)).toBeNull();

    const [connected] = await must(rt, accounts.connectChannel, { pid: PID, twitchId: ALICE.id, token: token({ scopes: ['extra', ...SCOPES] }) });
    expect(connected!.payload).toEqual({ scopes: SCOPES });
    expect(await loadChannelToken(pool, PID, KEY)).toEqual({
      accessToken: 'acc', refreshToken: 'ref', scopes: ['extra', ...SCOPES], expiresAt: new Date(AT.getTime() + 3600_000), status: 'ok',
    });
    expect((await pool.query('SELECT channel_connected FROM accounts WHERE pid = $1', [PID])).rows[0]).toEqual({ channel_connected: true });

    // Erneut verbinden: kein Ereignis, aber frischer Token.
    expect(await must(rt, accounts.connectChannel, { pid: PID, twitchId: ALICE.id, token: { ...token(), accessToken: 'neu' } })).toEqual([]);
    expect((await loadChannelToken(pool, PID, KEY))?.accessToken).toBe('neu');
  });

  it('disconnect deletes the token, revert of channel_disconnected is not possible, revert of channel_connected disconnects', async () => {
    const { pool, rt, accounts } = await setup();
    await fullAccount(rt, accounts);
    const [disconnected] = await must(rt, accounts.disconnectChannel, { pid: PID });
    expect(disconnected!.payload).toEqual({ scopes: SCOPES });
    expect(await loadChannelToken(pool, PID, KEY)).toBeNull();
    expect((await pool.query('SELECT channel_connected FROM accounts WHERE pid = $1', [PID])).rows[0]).toEqual({ channel_connected: false });
    expect(await code(run(rt, accounts.disconnectChannel, { pid: PID }))).toBe('not_connected');
    expect(await code(run(rt, accounts.revert, { stream: accountStream(PID), eventId: disconnected!.id, reason: 'doch' }))).toBe('not_reversible');

    const [connected] = await must(rt, accounts.connectChannel, { pid: PID, twitchId: ALICE.id, token: token() });
    const [undone] = await must(rt, accounts.revert, { stream: accountStream(PID), eventId: connected!.id, reason: 'Versehen' });
    expect(undone!.type).toBe(ACCOUNT_EVENTS.channelDisconnected);
    expect(await loadChannelToken(pool, PID, KEY)).toBeNull();
  });

  it('delete removes identities, sessions and channel_tokens, keeps the journal, blocks every further command', async () => {
    const { pool, rt, accounts } = await setup();
    await fullAccount(rt, accounts);
    const sid = await createSession(pool, PID, AT);
    const [deleted] = await must(rt, accounts.deleteAccount, { pid: PID });
    expect(deleted!.type).toBe(ACCOUNT_EVENTS.deleted);
    expect(await findIdentity(pool, PID)).toBeNull();
    expect(await findSession(pool, sid, AT)).toBeNull();
    expect(await loadChannelToken(pool, PID, KEY)).toBeNull();
    expect((await pool.query('SELECT deleted FROM accounts WHERE pid = $1', [PID])).rows[0]).toEqual({ deleted: true });
    expect((await pool.query('SELECT count(*)::int AS n FROM events WHERE stream = $1', [accountStream(PID)])).rows[0]).toEqual({ n: 4 });
    expect(await code(run(rt, accounts.deleteAccount, { pid: PID }))).toBe('already_deleted');
    expect(await code(run(rt, accounts.acceptTerms, { pid: PID, version: PLATFORM_TERMS_VERSION }))).toBe('no_account');
    expect(await code(run(rt, accounts.updateProfile, { pid: PID, legal: {} }))).toBe('no_account');
    expect(await code(run(rt, accounts.connectChannel, { pid: PID, twitchId: ALICE.id, token: token() }))).toBe('no_account');
    expect(await code(run(rt, accounts.signIn, { pid: PID, soloTeamId: SOLO, user: ALICE }, { actor: 'system:twitch' }))).toBe('account_deleted');
    expect(await code(run(rt, accounts.revert, { stream: accountStream(PID), eventId: deleted!.id, reason: 'doch' }))).toBe('not_reversible');
  });

  it('only the user themself (or the allowed system actor) may run account commands', async () => {
    const { rt, accounts } = await setup();
    await signIn(rt, accounts);
    const other = { actor: me(PID2) };
    expect(await code(run(rt, accounts.acceptTerms, { pid: PID, version: PLATFORM_TERMS_VERSION }, other))).toBe('not_you');
    expect(await code(run(rt, accounts.updateProfile, { pid: PID, legal: {} }, other))).toBe('not_you');
    expect(await code(run(rt, accounts.connectChannel, { pid: PID, twitchId: ALICE.id, token: token() }, other))).toBe('not_you');
    expect(await code(run(rt, accounts.disconnectChannel, { pid: PID }, other))).toBe('not_you');
    expect(await code(run(rt, accounts.deleteAccount, { pid: PID }, other))).toBe('not_you');
    expect(await code(run(rt, accounts.revert, { stream: accountStream(PID), eventId: '1', reason: 'x' }, other))).toBe('not_you');
    expect(await code(run(rt, accounts.signIn, { pid: PID, soloTeamId: SOLO, user: ALICE }, other))).toBe('not_you');
    expect(await code(run(rt, accounts.signIn, { pid: PID, soloTeamId: SOLO, user: ALICE }, { actor: 'system:scheduler' }))).toBe('not_you');
    expect(await code(run(rt, accounts.deleteAccount, { pid: PID }, { actor: 'system:scheduler' }))).toBe('ok');
  });

  it('attachAccounts twice throws', async () => {
    const { rt } = await setup();
    expect(() => attachAccounts(rt, { tokenKey: KEY })).toThrow(/doppelt/);
  });
});
