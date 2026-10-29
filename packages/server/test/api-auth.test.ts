import { afterEach, describe, expect, it } from 'vitest';
import { findPidByTwitchId } from '../src/identity/identities.js';
import { SESSION_TTL_DAYS } from '../src/identity/sessions.js';
import { loadChannelToken } from '../src/identity/tokens.js';
import { TwitchError } from '../src/identity/twitch.js';
import { AT } from './helpers/db.js';
import { ALICE, BOB, KEY, PUBLIC_URL, connect, cookieHeader, cookiesOf, login, setupApi, type ApiSetup } from './helpers/api.js';

let s: ApiSetup | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe('Twitch-Anmeldung', () => {
  it('login redirects to twitch with state cookie, callback creates identity and session, GET /me answers', async () => {
    s = await setupApi();
    const start = await s.app.inject({ method: 'GET', url: '/auth/twitch/login?return=%2Fdashboard' });
    expect(start.statusCode).toBe(302);
    const loc = new URL(start.headers.location as string);
    expect(loc.origin).toBe('https://id.stub');
    expect(loc.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/auth/twitch/callback`);
    expect(loc.searchParams.get('scope')).toBe('');
    const state = loc.searchParams.get('state')!;
    expect(state.length).toBeGreaterThanOrEqual(32);
    const setCookie = String(start.headers['set-cookie']);
    expect(setCookie).toMatch(/^ccg_oauth=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);

    const oauth = cookiesOf(start).ccg_oauth!;
    const cb = await s.app.inject({ method: 'GET', url: `/auth/twitch/callback?code=c1&state=${state}`, headers: { cookie: `ccg_oauth=${oauth}` } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/dashboard');
    expect(s.twitch.exchanged).toEqual(['c1']);
    const cookies = cookiesOf(cb);
    expect(cookies.ccg_session).toBeTruthy();
    expect(String(cb.headers['set-cookie'])).toMatch(/ccg_oauth=;.*Max-Age=0/);

    const pid = await findPidByTwitchId(s.pool, ALICE.id);
    expect(pid).toBeTruthy();
    const me = await s.app.inject({ method: 'GET', url: '/me', headers: { cookie: cookieHeader({ ccg_session: cookies.ccg_session! }) } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ pid, login: 'alice', displayName: 'Alice', termsVersion: 0, currentTermsVersion: 1, channelConnected: false });
    expect(me.json().soloTeamId).toMatch(/^[0-9a-f-]{36}$/);
    expect(me.json().legal).toEqual({ impressumUrl: null, terms: null, privacyUrl: null });
  });

  it('callback with wrong state is rejected and exchanges no code', async () => {
    s = await setupApi();
    const start = await s.app.inject({ method: 'GET', url: '/auth/twitch/login' });
    const oauth = cookiesOf(start).ccg_oauth!;
    const wrong = await s.app.inject({ method: 'GET', url: '/auth/twitch/callback?code=c1&state=falsch', headers: { cookie: `ccg_oauth=${oauth}` } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ code: 'oauth_state', message: 'Die Anmeldung ist abgelaufen. Starte sie neu.' });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const noCookie = await s.app.inject({ method: 'GET', url: `/auth/twitch/callback?code=c1&state=${state}` });
    expect(noCookie.statusCode).toBe(400);
    expect(noCookie.json().code).toBe('oauth_state');
    expect(s.twitch.exchanged).toEqual([]);
  });

  it('callback with ?error answers twitch_denied, exchange failure answers with the twitch code', async () => {
    s = await setupApi();
    const start = await s.app.inject({ method: 'GET', url: '/auth/twitch/login' });
    const oauth = cookiesOf(start).ccg_oauth!;
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const denied = await s.app.inject({ method: 'GET', url: `/auth/twitch/callback?error=access_denied&state=${state}`, headers: { cookie: `ccg_oauth=${oauth}` } });
    expect(denied.statusCode).toBe(400);
    expect(denied.json()).toEqual({ code: 'twitch_denied', message: 'Twitch hat die Anmeldung abgelehnt. Starte die Anmeldung neu.' });

    const again = await s.app.inject({ method: 'GET', url: '/auth/twitch/login' });
    s.twitch.fail = new TwitchError('twitch_unreachable');
    const failed = await s.app.inject({
      method: 'GET',
      url: `/auth/twitch/callback?code=c2&state=${new URL(again.headers.location as string).searchParams.get('state')}`,
      headers: { cookie: `ccg_oauth=${cookiesOf(again).ccg_oauth}` },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().code).toBe('twitch_unreachable');
  });

  it('second login of the same twitch user reuses the pid, a different user gets another pid', async () => {
    s = await setupApi();
    const a = await login(s, ALICE);
    const pidA = (await s.app.inject({ method: 'GET', url: '/me', headers: { cookie: a.cookie } })).json().pid;
    const a2 = await login(s, ALICE);
    expect((await s.app.inject({ method: 'GET', url: '/me', headers: { cookie: a2.cookie } })).json().pid).toBe(pidA);
    const b = await login(s, BOB);
    expect((await s.app.inject({ method: 'GET', url: '/me', headers: { cookie: b.cookie } })).json().pid).not.toBe(pidA);
    expect((await s.pool.query('SELECT count(*)::int AS n FROM events')).rows[0]).toEqual({ n: 2 });
  });

  it('connect requires a session, stores the token, GET /me shows channelConnected', async () => {
    s = await setupApi();
    expect((await s.app.inject({ method: 'GET', url: '/auth/twitch/connect' })).statusCode).toBe(401);
    const { cookie } = await login(s);
    const start = await s.app.inject({ method: 'GET', url: '/auth/twitch/connect', headers: { cookie } });
    expect(start.statusCode).toBe(302);
    expect(new URL(start.headers.location as string).searchParams.get('scope')).toBe('moderator:read:followers moderator:read:chatters channel:bot');
    const res = await connect(s, cookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const me = (await s.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
    expect(me.channelConnected).toBe(true);
    expect((await loadChannelToken(s.pool, me.pid, KEY))?.accessToken).toBe('acc-connect-alice');
  });

  it('connect with another twitch account is rejected with wrong_twitch_account, missing scopes with scopes_missing', async () => {
    s = await setupApi();
    const { cookie } = await login(s, ALICE);
    const wrong = await connect(s, cookie, BOB);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe('wrong_twitch_account');
    s.twitch.scopes = ['channel:bot'];
    const missing = await connect(s, cookie, ALICE);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('scopes_missing');
    const me = (await s.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
    expect(me.channelConnected).toBe(false);
    expect(await loadChannelToken(s.pool, me.pid, KEY)).toBeNull();
  });

  it('logout deletes the session, GET /me is 401 afterwards; expired or unknown session is 401', async () => {
    s = await setupApi();
    const { cookie } = await login(s);
    const out = await s.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/ccg_session=;.*Max-Age=0/);
    const me = await s.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
    expect(me.json()).toEqual({ code: 'no_session', message: 'Melde dich an.' });

    const fresh = await login(s);
    s.clock.now = new Date(AT.getTime() + SESSION_TTL_DAYS * 86_400_000);
    expect((await s.app.inject({ method: 'GET', url: '/me', headers: { cookie: fresh.cookie } })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'GET', url: '/me', headers: { cookie: 'ccg_session=unbekannt' } })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(204);
  });

  it('return path outside the site falls back to /', async () => {
    s = await setupApi();
    expect((await login(s, ALICE, 'https://evil.example/')).location).toBe('/');
    expect((await login(s, ALICE, '//evil.example/')).location).toBe('/');
    expect((await login(s, ALICE, '/giveaways/1?x=1')).location).toBe('/giveaways/1?x=1');
  });
});
