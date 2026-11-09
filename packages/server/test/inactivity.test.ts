import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_EVENTS } from '../src/identity/account/state.js';
import { findIdentity } from '../src/identity/identities.js';
import { INACTIVE_DAYS, purgeInactiveAccounts } from '../src/identity/inactivity.js';
import { attachAccounts } from '../src/identity/runtime.js';
import { allAdmins } from '../src/platform/admin.js';
import { attachPlatform } from '../src/platform/runtime.js';
import { AT } from './helpers/db.js';
import { ctx } from './helpers/fixtures.js';
import { setupGiveaway } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const OLD = '77777777-7777-4777-8777-777777777777';
const FRESH = '88888888-8888-4888-8888-888888888888';
const day = (n: number) => new Date(AT.getTime() + n * 86_400_000);

describe('purgeInactiveAccounts', () => {
  it('deletes accounts unseen for 365 days and leaves recent ones, runs are idempotent', async () => {
    const s = await setupGiveaway();
    close = s.close;
    const accounts = attachAccounts(s.rt, { tokenKey: randomBytes(32) });
    const signIn = (pid: string, id: string, now: Date) =>
      s.rt.bus.execute(accounts.signIn, { pid, soloTeamId: pid, user: { id, login: `u${id}`, displayName: `U${id}` } }, ctx({ actor: 'system:twitch', now }));
    expect((await signIn(OLD, '1', AT)).ok).toBe(true);
    expect((await signIn(FRESH, '2', day(2))).ok).toBe(true);

    const notYet = await purgeInactiveAccounts(s.pool, s.rt, accounts, day(INACTIVE_DAYS));
    expect(notYet).toEqual({ deleted: [], failed: 0 });

    const r = await purgeInactiveAccounts(s.pool, s.rt, accounts, day(INACTIVE_DAYS + 1));
    expect(r).toEqual({ deleted: [OLD], failed: 0 });
    expect(await findIdentity(s.pool, OLD)).toBeNull();
    expect(await findIdentity(s.pool, FRESH)).not.toBeNull();
    const last = (await s.pool.query('SELECT type, actor FROM events ORDER BY id DESC LIMIT 1')).rows[0];
    expect(last).toEqual({ type: ACCOUNT_EVENTS.deleted, actor: 'system:scheduler' });

    expect(await purgeInactiveAccounts(s.pool, s.rt, accounts, day(INACTIVE_DAYS + 1))).toEqual({ deleted: [], failed: 0 });
  });

  it('keeps an identity that is banned in a team, even when unseen for 365 days', async () => {
    const s = await setupGiveaway();
    close = s.close;
    const accounts = attachAccounts(s.rt, { tokenKey: randomBytes(32) });
    const signIn = (pid: string, id: string) =>
      s.rt.bus.execute(accounts.signIn, { pid, soloTeamId: pid, user: { id, login: `u${id}`, displayName: `U${id}` } }, ctx({ actor: 'system:twitch', now: AT }));
    expect((await signIn(OLD, '1')).ok).toBe(true);
    expect((await signIn(FRESH, '2')).ok).toBe(true);
    const TEAM = '55555555-5555-4555-8555-555555555555';
    expect((await s.rt.bus.execute(s.rt.teams.create, { teamId: TEAM, name: 'Werwölfe' }, ctx({ actor: `user:${FRESH}` }))).ok).toBe(true);
    expect((await s.rt.bus.execute(s.rt.teams.ban, { teamId: TEAM, pid: OLD }, ctx({ actor: `user:${FRESH}` }))).ok).toBe(true);
    const r = await purgeInactiveAccounts(s.pool, s.rt, accounts, day(INACTIVE_DAYS + 1));
    expect(r).toEqual({ deleted: [FRESH], failed: 0 });
    expect(await findIdentity(s.pool, OLD)).not.toBeNull();
  });

  it('keeps an identity with a platform ban, even when unseen for 365 days', async () => {
    const s = await setupGiveaway();
    close = s.close;
    const accounts = attachAccounts(s.rt, { tokenKey: randomBytes(32) });
    const platform = attachPlatform(s.rt, { admins: allAdmins });
    const signIn = (pid: string, id: string) =>
      s.rt.bus.execute(accounts.signIn, { pid, soloTeamId: pid, user: { id, login: `u${id}`, displayName: `U${id}` } }, ctx({ actor: 'system:twitch', now: AT }));
    expect((await signIn(OLD, '1')).ok).toBe(true);
    expect((await signIn(FRESH, '2')).ok).toBe(true);
    expect((await s.rt.bus.execute(platform.ban, { pid: OLD, reason: 'Bot-Verhalten' }, ctx({ actor: `user:${FRESH}` }))).ok).toBe(true);
    const r = await purgeInactiveAccounts(s.pool, s.rt, accounts, day(INACTIVE_DAYS + 1));
    expect(r).toEqual({ deleted: [FRESH], failed: 0 });
    expect(await findIdentity(s.pool, OLD)).not.toBeNull();
  });
});
