import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import { accountAuthorizer, accountTeamAuthorizer } from '../src/identity/account/authorizer.js';
import { attachAccounts } from '../src/identity/runtime.js';
import { allAdmins } from '../src/platform/admin.js';
import { attachPlatform } from '../src/platform/runtime.js';
import { TERMS_FALLBACK_VERSION as PLATFORM_TERMS_VERSION } from '../src/platform/terms.js';
import { REQUIRED_CHANNEL_SCOPES } from '../src/identity/twitch.js';
import type { Runtime } from '../src/framework/runtime.js';
import { ctx } from './helpers/fixtures.js';
import { GID, GID2, P1, setupGiveaway } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const PID = '77777777-7777-4777-8777-777777777777';
const SOLO = '55555555-5555-4555-8555-555555555555';
const OTHER_TEAM = '66666666-6666-4666-8666-666666666666';
const ALICE = { id: '12345', login: 'alice', displayName: 'Alice' };
const token = { accessToken: 'acc', refreshToken: 'ref', expiresIn: 3600, scopes: [...REQUIRED_CHANNEL_SCOPES] };

async function setup() {
  const s = await setupGiveaway({ auth: accountAuthorizer() });
  close = s.close;
  const accounts = attachAccounts(s.rt, { tokenKey: randomBytes(32) });
  return { ...s, accounts };
}

const codeOf = (r: CommandResult) => (r.ok ? 'ok' : r.rejection.code);

function create(rt: Runtime, actor: string, teamId = SOLO, giveawayId = GID): Promise<CommandResult> {
  return rt.bus.execute(rt.handlers.create, { giveawayId, teamId, kernelId: 'instant', settings: { prize: 'Key', channels: [P1] } }, ctx({ actor }));
}

async function must<T extends CommandResult>(p: Promise<T>) {
  const r = await p;
  if (!r.ok) throw new Error(`${r.rejection.code}: ${r.rejection.message}`);
}

describe('accountAuthorizer', () => {
  it('stranger: no_account; own solo team without terms: terms_required; without channel: channel_required; complete: ok', async () => {
    const { rt, accounts } = await setup();
    const me = `user:${PID}`;
    expect(codeOf(await create(rt, me))).toBe('no_account');
    await must(rt.bus.execute(accounts.signIn, { pid: PID, soloTeamId: SOLO, user: ALICE }, ctx({ actor: 'system:twitch' })));
    const r1 = await create(rt, me);
    expect(r1).toMatchObject({ ok: false, rejection: { code: 'terms_required', message: 'Akzeptiere zuerst die Nutzungsbedingungen.' } });
    await must(rt.bus.execute(accounts.acceptTerms, { pid: PID, version: PLATFORM_TERMS_VERSION }, ctx({ actor: me })));
    const r2 = await create(rt, me);
    expect(r2).toMatchObject({ ok: false, rejection: { code: 'channel_required', message: 'Verbinde zuerst deinen Kanal.' } });
    await must(rt.bus.execute(accounts.connectChannel, { pid: PID, twitchId: ALICE.id, token }, ctx({ actor: me })));
    expect(codeOf(await create(rt, me))).toBe('ok');
    expect(codeOf(await rt.bus.execute(rt.handlers.open, { giveawayId: GID }, ctx({ actor: me })))).toBe('ok');
    expect(codeOf(await rt.bus.execute(rt.handlers.pause, { giveawayId: GID }, ctx({ actor: `user:88888888-8888-4888-8888-888888888888` })))).toBe('no_account');
  });

  it('foreign team is not_your_team even with a complete account', async () => {
    const { rt, accounts } = await setup();
    const me = `user:${PID}`;
    await must(rt.bus.execute(accounts.signIn, { pid: PID, soloTeamId: SOLO, user: ALICE }, ctx({ actor: 'system:twitch' })));
    await must(rt.bus.execute(accounts.acceptTerms, { pid: PID, version: PLATFORM_TERMS_VERSION }, ctx({ actor: me })));
    await must(rt.bus.execute(accounts.connectChannel, { pid: PID, twitchId: ALICE.id, token }, ctx({ actor: me })));
    const r = await create(rt, me, OTHER_TEAM);
    expect(r).toMatchObject({ ok: false, rejection: { code: 'not_your_team', message: 'Dieses Giveaway gehört nicht zu deinem Team.' } });
  });

  it('system actors pass', async () => {
    const { rt } = await setup();
    expect(codeOf(await create(rt, 'system:scheduler', OTHER_TEAM))).toBe('ok');
    expect(codeOf(await create(rt, 'system:migration', OTHER_TEAM, '66666666-6666-4666-8666-666666666667'))).toBe('ok');
  });

  it('a member of a real team controls its giveaways, a non-member gets not_your_team, a deactivated team keeps control', async () => {
    const { rt, accounts, pool } = await setup();
    const BOB_PID = '88888888-8888-4888-8888-888888888888';
    const CAROL_PID = '99999999-9999-4999-8999-999999999999';
    const complete = async (pid: string, solo: string, user: { id: string; login: string; displayName: string }) => {
      const actor = `user:${pid}`;
      await must(rt.bus.execute(accounts.signIn, { pid, soloTeamId: solo, user }, ctx({ actor: 'system:twitch' })));
      await must(rt.bus.execute(accounts.acceptTerms, { pid, version: PLATFORM_TERMS_VERSION }, ctx({ actor })));
      await must(rt.bus.execute(accounts.connectChannel, { pid, twitchId: user.id, token }, ctx({ actor })));
      return actor;
    };
    const alice = await complete(PID, SOLO, ALICE);
    const bob = await complete(BOB_PID, '55555555-5555-4555-8555-555555555557', { id: '67890', login: 'bob', displayName: 'Bob' });
    const carol = await complete(CAROL_PID, '55555555-5555-4555-8555-555555555558', { id: '13579', login: 'carol', displayName: 'Carol' });
    const INVITE = '11111111-1111-4111-8111-111111111111';
    await must(rt.bus.execute(rt.teams.create, { teamId: OTHER_TEAM, name: 'Werwölfe' }, ctx({ actor: alice })));
    await must(rt.bus.execute(rt.teams.createInvite, { teamId: OTHER_TEAM, inviteId: INVITE }, ctx({ actor: alice })));
    await must(rt.bus.execute(rt.teams.join, { teamId: OTHER_TEAM, inviteId: INVITE, pid: BOB_PID }, ctx({ actor: bob })));
    expect(codeOf(await create(rt, alice, OTHER_TEAM))).toBe('ok');
    expect(codeOf(await rt.bus.execute(rt.handlers.open, { giveawayId: GID }, ctx({ actor: bob })))).toBe('ok');
    expect(codeOf(await rt.bus.execute(rt.handlers.pause, { giveawayId: GID }, ctx({ actor: bob })))).toBe('ok');
    expect(await create(rt, carol, OTHER_TEAM, '66666666-6666-4666-8666-666666666667')).toMatchObject({
      ok: false,
      rejection: { code: 'not_your_team', message: 'Dieses Giveaway gehört nicht zu deinem Team.' },
    });
    await must(rt.bus.execute(rt.teams.deactivate, { teamId: OTHER_TEAM }, ctx({ actor: bob })));
    expect((await pool.query('SELECT active FROM teams WHERE id = $1', [OTHER_TEAM])).rows[0]!.active).toBe(false);
    expect(codeOf(await rt.bus.execute(rt.handlers.close, { giveawayId: GID }, ctx({ actor: bob })))).toBe('ok');
    // Austritt nimmt die Rechte: BOB verlässt, danach ist Alice allein.
    await must(rt.bus.execute(rt.teams.leave, { teamId: OTHER_TEAM, pid: BOB_PID }, ctx({ actor: bob })));
    expect(codeOf(await rt.bus.execute(rt.handlers.reopen, { giveawayId: GID }, ctx({ actor: bob })))).toBe('not_your_team');
    expect(codeOf(await rt.bus.execute(rt.handlers.reopen, { giveawayId: GID }, ctx({ actor: alice })))).toBe('ok');
  });

  it('accountTeamAuthorizer: canFound needs account, terms and channel; isMember needs a team_members row; a deleted account loses both', async () => {
    const { rt, accounts, pool } = await setup();
    const auth = accountTeamAuthorizer();
    const me = `user:${PID}`;
    const c = await pool.connect();
    try {
      const codeOrOk = (r: Awaited<ReturnType<typeof auth.canFound>>) => (r === null ? 'ok' : r.code);
      expect(codeOrOk(await auth.canFound(c, me))).toBe('no_account');
      expect(codeOrOk(await auth.isMember(c, me, OTHER_TEAM))).toBe('no_account');
      await must(rt.bus.execute(accounts.signIn, { pid: PID, soloTeamId: SOLO, user: ALICE }, ctx({ actor: 'system:twitch' })));
      expect(codeOrOk(await auth.canFound(c, me))).toBe('terms_required');
      await must(rt.bus.execute(accounts.acceptTerms, { pid: PID, version: PLATFORM_TERMS_VERSION }, ctx({ actor: me })));
      expect(codeOrOk(await auth.canFound(c, me))).toBe('channel_required');
      await must(rt.bus.execute(accounts.connectChannel, { pid: PID, twitchId: ALICE.id, token }, ctx({ actor: me })));
      expect(codeOrOk(await auth.canFound(c, me))).toBe('ok');
      expect(await auth.isMember(c, me, OTHER_TEAM)).toEqual({ rejected: true, code: 'not_member', message: 'Du bist kein Mitglied dieses Teams.' });
      await must(rt.bus.execute(rt.teams.create, { teamId: OTHER_TEAM, name: 'Werwölfe' }, ctx({ actor: me })));
      expect(codeOrOk(await auth.isMember(c, me, OTHER_TEAM))).toBe('ok');
      expect(codeOrOk(await auth.isMember(c, 'system:migration', OTHER_TEAM))).toBe('ok');
      expect(codeOrOk(await auth.canFound(c, 'system:migration'))).toBe('ok');
      expect(codeOrOk(await auth.isMember(c, me, 'nope'))).toBe('not_member');
      await must(rt.bus.execute(accounts.deleteAccount, { pid: PID }, ctx({ actor: me })));
      expect(codeOrOk(await auth.canFound(c, me))).toBe('no_account');
      expect(codeOrOk(await auth.isMember(c, me, OTHER_TEAM))).toBe('no_account');
    } finally {
      c.release();
    }
  });

  it('a deleted account loses control', async () => {
    const { rt, accounts } = await setup();
    const me = `user:${PID}`;
    await must(rt.bus.execute(accounts.signIn, { pid: PID, soloTeamId: SOLO, user: ALICE }, ctx({ actor: 'system:twitch' })));
    await must(rt.bus.execute(accounts.acceptTerms, { pid: PID, version: PLATFORM_TERMS_VERSION }, ctx({ actor: me })));
    await must(rt.bus.execute(accounts.connectChannel, { pid: PID, twitchId: ALICE.id, token }, ctx({ actor: me })));
    await must(create(rt, me));
    await must(rt.bus.execute(accounts.deleteAccount, { pid: PID }, ctx({ actor: me })));
    expect(codeOf(await rt.bus.execute(rt.handlers.open, { giveawayId: GID }, ctx({ actor: me })))).toBe('no_account');
  });
});

describe('Plattform-Sperre und Fassungen der Nutzungsbedingungen (Teilprojekt 8c)', () => {
  const ADMIN = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const BANNED_TEXT = 'Dein Konto ist gesperrt. Grund: Bot-Verhalten. Wende dich an den Betreiber.';

  async function completeAccount(rt: Runtime, accounts: ReturnType<typeof attachAccounts>, me: string, version = 1) {
    await must(rt.bus.execute(accounts.signIn, { pid: PID, soloTeamId: SOLO, user: ALICE }, ctx({ actor: 'system:twitch' })));
    await must(rt.bus.execute(accounts.acceptTerms, { pid: PID, version }, ctx({ actor: me })));
    await must(rt.bus.execute(accounts.connectChannel, { pid: PID, twitchId: ALICE.id, token }, ctx({ actor: me })));
  }

  it('a banned streamer gets account_banned with the reason on controls and canFound; after unban both pass again', async () => {
    const { rt, accounts, pool } = await setup();
    const platform = attachPlatform(rt, { admins: allAdmins });
    const me = `user:${PID}`;
    await completeAccount(rt, accounts, me);
    expect(codeOf(await create(rt, me))).toBe('ok');
    await must(rt.bus.execute(platform.ban, { pid: PID, reason: 'Bot-Verhalten' }, ctx({ actor: ADMIN })));
    expect(await create(rt, me, SOLO, GID2)).toMatchObject({ ok: false, rejection: { code: 'account_banned', message: BANNED_TEXT } });
    expect(codeOf(await rt.bus.execute(rt.handlers.open, { giveawayId: GID }, ctx({ actor: me })))).toBe('account_banned');
    const c = await pool.connect();
    try {
      expect(await accountTeamAuthorizer().canFound(c, me)).toMatchObject({ code: 'account_banned' });
      // Auch Team-Verwaltung (einladen, sperren, umbenennen) bleibt einer gesperrten Person verwehrt.
      expect(await accountTeamAuthorizer().isMember(c, me, SOLO)).toMatchObject({ code: 'account_banned' });
    } finally {
      c.release();
    }
    await must(rt.bus.execute(platform.unban, { pid: PID, reason: 'Geklärt' }, ctx({ actor: ADMIN })));
    expect(codeOf(await create(rt, me, SOLO, GID2))).toBe('ok');
  });

  it('after publish_terms the streamer needs the new version: controls → terms_required, accept_terms with the old version → terms_version_stale, with the new one → ok', async () => {
    const { rt, accounts } = await setup();
    const platform = attachPlatform(rt, { admins: allAdmins });
    const me = `user:${PID}`;
    await completeAccount(rt, accounts, me);
    expect(codeOf(await create(rt, me))).toBe('ok');
    await must(rt.bus.execute(platform.publishTerms, { text: 'Fassung zwei.' }, ctx({ actor: ADMIN })));
    expect(codeOf(await create(rt, me, SOLO, GID2))).toBe('terms_required');
    expect(codeOf(await rt.bus.execute(accounts.acceptTerms, { pid: PID, version: 1 }, ctx({ actor: me })))).toBe('terms_version_stale');
    expect(codeOf(await rt.bus.execute(accounts.acceptTerms, { pid: PID, version: 2 }, ctx({ actor: me })))).toBe('ok');
    expect(codeOf(await create(rt, me, SOLO, GID2))).toBe('ok');
  });
});
