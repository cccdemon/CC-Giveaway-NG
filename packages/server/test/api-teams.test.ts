import { afterEach, describe, expect, it } from 'vitest';
import { INVITE_TTL_DAYS } from '../src/framework/team/state.js';
import { accountTeamAuthorizer } from '../src/identity/account/authorizer.js';
import type { TwitchUser } from '../src/identity/identities.js';
import { pgBanDirectory, pgTeamDirectory } from '../src/identity/team-directory.js';
import { AT } from './helpers/db.js';
import { ALICE, BOB, PUBLIC_URL, connect, login, setupApi, type ApiSetup } from './helpers/api.js';
import { P1, at } from './helpers/giveaway.js';

let s: ApiSetup | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const CAROL: TwitchUser = { id: '13579', login: 'carol', displayName: 'Carol' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNKNOWN = '55555555-5555-4555-8555-55555555555a';

async function setup() {
  s = await setupApi({ teamAuth: accountTeamAuthorizer(), teamDirectory: pgTeamDirectory(), bans: pgBanDirectory() });
  return s;
}

/** Anmelden, Nutzungsbedingungen, Kanal: ein vollständiges Konto. */
async function complete(api: ApiSetup, user: TwitchUser) {
  const { cookie } = await login(api, user);
  const h = { cookie, 'content-type': 'application/json' };
  await api.app.inject({ method: 'POST', url: '/me/terms', headers: h, payload: { version: 1 } });
  await connect(api, cookie, user);
  const me = (await api.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
  return { cookie, h, pid: me.pid as string, soloTeamId: me.soloTeamId as string };
}

async function createTeam(api: ApiSetup, h: Record<string, string>, name = 'Werwölfe'): Promise<string> {
  const r = await api.app.inject({ method: 'POST', url: '/teams', headers: h, payload: { name } });
  expect(r.statusCode).toBe(201);
  return r.json().teamId as string;
}

describe('/teams', () => {
  it('POST /teams creates a team, GET /me/teams lists solo and the team, GET /teams/:id shows members with display names', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const teamId = await createTeam(api, alice.h);
    expect(teamId).toMatch(UUID);
    const mine = (await api.app.inject({ method: 'GET', url: '/me/teams', headers: { cookie: alice.cookie } })).json();
    expect(mine).toEqual({ solo: { teamId: alice.soloTeamId }, teams: [{ teamId, name: 'Werwölfe', active: true, memberCount: 1 }] });
    const team = await api.app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: { cookie: alice.cookie } });
    expect(team.statusCode).toBe(200);
    expect(team.json()).toEqual({ teamId, name: 'Werwölfe', active: true, members: [{ pid: alice.pid, displayName: 'Alice' }], invites: [], banned: [] });
  });

  it('invite link: POST invites returns url and expiresAt, GET join shows name and validity, BOB joins via POST', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const teamId = await createTeam(api, alice.h);
    const inv = await api.app.inject({ method: 'POST', url: `/teams/${teamId}/invites`, headers: { cookie: alice.cookie } });
    expect(inv.statusCode).toBe(201);
    const { inviteId, url, expiresAt } = inv.json();
    expect(inviteId).toMatch(UUID);
    expect(url).toBe(`${PUBLIC_URL}/teams/join/${inviteId}`);
    expect(expiresAt).toBe(at(INVITE_TTL_DAYS * 86_400).toISOString());
    const peek = await api.app.inject({ method: 'GET', url: `/teams/join/${inviteId}` });
    expect(peek.statusCode).toBe(200);
    expect(peek.json()).toEqual({ teamId, name: 'Werwölfe', valid: true });
    expect((await api.app.inject({ method: 'GET', url: `/teams/join/${UNKNOWN}` })).statusCode).toBe(404);
    expect((await api.app.inject({ method: 'POST', url: `/teams/join/${inviteId}` })).statusCode).toBe(401);

    const bob = await complete(api, BOB);
    expect((await api.app.inject({ method: 'POST', url: `/teams/join/${inviteId}`, headers: { cookie: bob.cookie } })).statusCode).toBe(204);
    const team = (await api.app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: { cookie: bob.cookie } })).json();
    // Beide traten zur selben Testzeit bei, die Reihenfolge hängt dann an den zufälligen pids.
    const byName = (list: { displayName: string }[]) => [...list].sort((a, b) => a.displayName.localeCompare(b.displayName));
    expect(byName(team.members)).toEqual([
      { pid: alice.pid, displayName: 'Alice' },
      { pid: bob.pid, displayName: 'Bob' },
    ]);
    expect(team.invites).toEqual([{ inviteId, expiresAt }]);
    const mine = (await api.app.inject({ method: 'GET', url: '/me/teams', headers: { cookie: bob.cookie } })).json();
    expect(mine.teams).toEqual([{ teamId, name: 'Werwölfe', active: true, memberCount: 2 }]);

    expect((await api.app.inject({ method: 'DELETE', url: `/teams/${teamId}/invites/${inviteId}`, headers: { cookie: alice.cookie } })).statusCode).toBe(204);
    expect((await api.app.inject({ method: 'GET', url: `/teams/join/${inviteId}` })).json()).toEqual({ teamId, name: 'Werwölfe', valid: false });
    const carol = await complete(api, CAROL);
    const late = await api.app.inject({ method: 'POST', url: `/teams/join/${inviteId}`, headers: { cookie: carol.cookie } });
    expect(late.statusCode).toBe(400);
    expect(late.json().code).toBe('invite_revoked');
    expect((await api.app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: { cookie: alice.cookie } })).json().invites).toEqual([]);
  });

  it('a non-member gets 403 not_member on GET /teams/:id and on rename; unknown team is 404', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const carol = await complete(api, CAROL);
    const teamId = await createTeam(api, alice.h);
    const view = await api.app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: { cookie: carol.cookie } });
    expect(view.statusCode).toBe(403);
    expect(view.json()).toEqual({ code: 'not_member', message: 'Du bist kein Mitglied dieses Teams.' });
    expect((await api.app.inject({ method: 'PUT', url: `/teams/${teamId}/name`, headers: carol.h, payload: { name: 'Neu' } })).statusCode).toBe(403);
    const unknown = await api.app.inject({ method: 'GET', url: `/teams/${UNKNOWN}`, headers: { cookie: alice.cookie } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('team_not_found');
    expect((await api.app.inject({ method: 'GET', url: '/teams/nope', headers: { cookie: alice.cookie } })).statusCode).toBe(404);
    expect((await api.app.inject({ method: 'GET', url: `/teams/${teamId}` })).statusCode).toBe(401);
  });

  it('leave, deactivate, reactivate, rename, ban and unban run through the bus and show in GET /teams/:id', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    const teamId = await createTeam(api, alice.h);
    const { inviteId } = (await api.app.inject({ method: 'POST', url: `/teams/${teamId}/invites`, headers: { cookie: alice.cookie } })).json();
    expect((await api.app.inject({ method: 'POST', url: `/teams/join/${inviteId}`, headers: { cookie: bob.cookie } })).statusCode).toBe(204);
    const view = async () => (await api.app.inject({ method: 'GET', url: `/teams/${teamId}`, headers: { cookie: alice.cookie } })).json();

    expect((await api.app.inject({ method: 'POST', url: `/teams/${teamId}/bans`, headers: bob.h, payload: { pid: P1 } })).statusCode).toBe(204);
    expect((await view()).banned).toEqual([P1]);
    expect((await api.app.inject({ method: 'DELETE', url: `/teams/${teamId}/bans/${P1}`, headers: { cookie: alice.cookie } })).statusCode).toBe(204);
    expect((await view()).banned).toEqual([]);
    const notBanned = await api.app.inject({ method: 'DELETE', url: `/teams/${teamId}/bans/${P1}`, headers: { cookie: alice.cookie } });
    expect(notBanned.statusCode).toBe(400);
    expect(notBanned.json().code).toBe('not_banned');

    expect((await api.app.inject({ method: 'PUT', url: `/teams/${teamId}/name`, headers: bob.h, payload: { name: 'Neu' } })).statusCode).toBe(204);
    expect((await view()).name).toBe('Neu');

    expect((await api.app.inject({ method: 'POST', url: `/teams/${teamId}/leave`, headers: { cookie: bob.cookie } })).statusCode).toBe(204);
    expect((await view()).members).toEqual([{ pid: alice.pid, displayName: 'Alice' }]);
    const last = await api.app.inject({ method: 'POST', url: `/teams/${teamId}/leave`, headers: { cookie: alice.cookie } });
    expect(last.statusCode).toBe(400);
    expect(last.json().code).toBe('last_member');

    expect((await api.app.inject({ method: 'POST', url: `/teams/${teamId}/deactivate`, headers: { cookie: alice.cookie } })).statusCode).toBe(204);
    expect((await view()).active).toBe(false);
    expect((await api.app.inject({ method: 'GET', url: '/me/teams', headers: { cookie: alice.cookie } })).json().teams[0]).toMatchObject({ active: false, memberCount: 1 });
    expect((await api.app.inject({ method: 'POST', url: `/teams/${teamId}/reactivate`, headers: { cookie: alice.cookie } })).statusCode).toBe(204);
    expect((await view()).active).toBe(true);
  });

  it('without terms or channel POST /teams is rejected with the account texts, without session 401', async () => {
    const api = await setup();
    expect((await api.app.inject({ method: 'POST', url: '/teams', payload: { name: 'x' } })).statusCode).toBe(401);
    const { cookie } = await login(api, ALICE);
    const h = { cookie, 'content-type': 'application/json' };
    const noTerms = await api.app.inject({ method: 'POST', url: '/teams', headers: h, payload: { name: 'Werwölfe' } });
    expect(noTerms.statusCode).toBe(400);
    expect(noTerms.json()).toEqual({ code: 'terms_required', message: 'Akzeptiere zuerst die Nutzungsbedingungen.' });
    await api.app.inject({ method: 'POST', url: '/me/terms', headers: h, payload: { version: 1 } });
    const noChannel = await api.app.inject({ method: 'POST', url: '/teams', headers: h, payload: { name: 'Werwölfe' } });
    expect(noChannel.json()).toEqual({ code: 'channel_required', message: 'Verbinde zuerst deinen Kanal.' });
    await connect(api, cookie, ALICE);
    const bad = await api.app.inject({ method: 'POST', url: '/teams', headers: h, payload: { name: '' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('team_name_invalid');
    expect(AT.toISOString()).toBe('2026-10-15T12:00:00.000Z');
  });
});
