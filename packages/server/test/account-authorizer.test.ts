import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import { accountAuthorizer } from '../src/identity/account/authorizer.js';
import { attachAccounts } from '../src/identity/runtime.js';
import { PLATFORM_TERMS_VERSION } from '../src/identity/terms.js';
import { REQUIRED_CHANNEL_SCOPES } from '../src/identity/twitch.js';
import type { Runtime } from '../src/framework/runtime.js';
import { ctx } from './helpers/fixtures.js';
import { GID, P1, setupGiveaway } from './helpers/giveaway.js';

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
