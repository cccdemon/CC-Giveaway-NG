import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_EVENTS, accountStream } from '../src/identity/account/state.js';
import { findIdentity } from '../src/identity/identities.js';
import { loadChannelToken } from '../src/identity/tokens.js';
import { ALICE, KEY, connect, login, setupApi, type ApiSetup } from './helpers/api.js';
import { GID, P1, TEAM } from './helpers/giveaway.js';
import { ctx } from './helpers/fixtures.js';

let s: ApiSetup | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const LEGAL = { impressumUrl: 'https://streamer.example/impressum', terms: { text: 'Ab 18.' }, privacyUrl: 'https://streamer.example/datenschutz' };

describe('/me', () => {
  it('terms, profile, channel disconnect run through the bus and show in GET /me', async () => {
    s = await setupApi();
    const { cookie } = await login(s);
    const h = { cookie, 'content-type': 'application/json' };
    expect((await s.app.inject({ method: 'POST', url: '/me/terms', headers: h, payload: { version: 1 } })).statusCode).toBe(204);
    expect((await s.app.inject({ method: 'PUT', url: '/me/profile', headers: h, payload: { legal: LEGAL } })).statusCode).toBe(204);
    expect((await connect(s, cookie)).statusCode).toBe(302);
    let me = (await s.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
    expect(me).toMatchObject({ termsVersion: 1, channelConnected: true, legal: LEGAL });
    expect((await s.app.inject({ method: 'DELETE', url: '/me/channel', headers: { cookie } })).statusCode).toBe(204);
    me = (await s.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
    expect(me.channelConnected).toBe(false);
    expect(await loadChannelToken(s.pool, me.pid, KEY)).toBeNull();
    const types = (await s.pool.query('SELECT type, actor FROM events ORDER BY id')).rows;
    expect(types.map((r) => r.type)).toEqual([
      ACCOUNT_EVENTS.created, ACCOUNT_EVENTS.termsAccepted, ACCOUNT_EVENTS.profileUpdated, ACCOUNT_EVENTS.channelConnected, ACCOUNT_EVENTS.channelDisconnected,
    ]);
    expect(types[0]!.actor).toBe('system:twitch');
    expect(types[1]!.actor).toBe(`user:${me.pid}`);
  });

  it('GET /me/data exports identity, account state, events and participations and writes a read entry in access_log', async () => {
    s = await setupApi();
    const { cookie } = await login(s);
    const pid = (await s.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json().pid as string;
    await s.app.inject({ method: 'POST', url: '/me/terms', headers: { cookie, 'content-type': 'application/json' }, payload: { version: 1 } });
    // Teilnahme an einem Giveaway: Anmeldung über den Rahmen (Akteur = die Person selbst).
    const r1 = await s.rt.bus.execute(s.rt.handlers.create, { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1] } }, ctx({ actor: 'system:scheduler' }));
    expect(r1.ok).toBe(true);
    expect((await s.rt.bus.execute(s.rt.handlers.open, { giveawayId: GID }, ctx({ actor: 'system:scheduler' }))).ok).toBe(true);
    expect((await s.rt.bus.execute(s.rt.handlers.kernelCommand, { giveawayId: GID, command: { type: 'open_window', args: {} } }, ctx({ actor: 'system:scheduler' }))).ok).toBe(true);
    expect((await s.rt.bus.execute(s.rt.handlers.register, { giveawayId: GID, pid }, ctx({ actor: `user:${pid}` }))).ok).toBe(true);

    const res = await s.app.inject({ method: 'GET', url: '/me/data', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="meine-daten.json"');
    const body = res.json();
    expect(body.identity).toMatchObject({ pid, twitchId: ALICE.id, login: 'alice', displayName: 'Alice' });
    expect(body.account).toMatchObject({ exists: true, termsVersion: 1, channelConnected: false });
    expect(body.events.map((e: { type: string }) => e.type)).toEqual([ACCOUNT_EVENTS.created, ACCOUNT_EVENTS.termsAccepted]);
    expect(body.participations).toEqual([{ giveawayId: GID, registered: true, inPool: true, weight: 1, winnerStatus: null }]);
    const log = (await s.pool.query("SELECT actor, action, target, host(ip) AS ip FROM access_log WHERE kind = 'read'")).rows;
    expect(log).toEqual([{ actor: `user:${pid}`, action: 'export_data', target: accountStream(pid), ip: '127.0.0.1' }]);
  });

  it('DELETE /me removes identity, session and token, journal keeps account_deleted, cookie is cleared', async () => {
    s = await setupApi();
    const { cookie } = await login(s);
    const pid = (await s.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json().pid as string;
    await connect(s, cookie);
    const del = await s.app.inject({ method: 'DELETE', url: '/me', headers: { cookie } });
    expect(del.statusCode).toBe(204);
    expect(String(del.headers['set-cookie'])).toMatch(/ccg_session=;.*Max-Age=0/);
    expect(await findIdentity(s.pool, pid)).toBeNull();
    expect(await loadChannelToken(s.pool, pid, KEY)).toBeNull();
    expect((await s.pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0]).toEqual({ n: 0 });
    const last = (await s.pool.query('SELECT type FROM events ORDER BY id DESC LIMIT 1')).rows[0];
    expect(last).toEqual({ type: ACCOUNT_EVENTS.deleted });
    expect((await s.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).statusCode).toBe(401);
    // Neue Anmeldung desselben Twitch-Kontos ergibt eine neue pid.
    const again = await login(s);
    expect((await s.app.inject({ method: 'GET', url: '/me', headers: { cookie: again.cookie } })).json().pid).not.toBe(pid);
  });

  it('rejections map to status codes: 401 no session, 400 for rejected commands, denied commands land in access_log', async () => {
    s = await setupApi();
    expect((await s.app.inject({ method: 'POST', url: '/me/terms', payload: { version: 1 } })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'GET', url: '/me/data' })).statusCode).toBe(401);
    const { cookie } = await login(s);
    const stale = await s.app.inject({ method: 'POST', url: '/me/terms', headers: { cookie, 'content-type': 'application/json' }, payload: { version: 7 } });
    expect(stale.statusCode).toBe(400);
    expect(stale.json()).toEqual({ code: 'terms_version_stale', message: 'Die Nutzungsbedingungen haben sich geändert. Lade die Seite neu.' });
    const bad = await s.app.inject({ method: 'PUT', url: '/me/profile', headers: { cookie, 'content-type': 'application/json' }, payload: { legal: { impressumUrl: 'ftp://x' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('invalid_url');
    const noBody = await s.app.inject({ method: 'PUT', url: '/me/profile', headers: { cookie, 'content-type': 'application/json' }, payload: {} });
    expect(noBody.statusCode).toBe(400);
    expect(noBody.json().code).toBe('invalid_legal');
    const denied = (await s.pool.query("SELECT action, reason FROM access_log WHERE kind = 'denied' ORDER BY id")).rows;
    expect(denied).toEqual([{ action: 'accept_terms', reason: 'terms_version_stale' }, { action: 'update_profile', reason: 'invalid_url' }, { action: 'update_profile', reason: 'invalid_legal' }]);
  });
});
