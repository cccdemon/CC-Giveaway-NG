import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { accountAuthorizer, accountTeamAuthorizer } from '../src/identity/account/authorizer.js';
import type { TwitchUser } from '../src/identity/identities.js';
import { pgBanDirectory, pgTeamDirectory } from '../src/identity/team-directory.js';
import { upsertChannelStatus } from '../src/ingest/channel-status.js';
import { twitchIdAdmins } from '../src/platform/admin.js';
import { BROWSER_ERROR_RETENTION_DAYS, purgeBrowserErrors, recordBrowserError } from '../src/platform/ops.js';
import { AT } from './helpers/db.js';
import { ctx } from './helpers/fixtures.js';
import { ALICE, BOB, connect, login, setupApi, type ApiSetup } from './helpers/api.js';

let s: ApiSetup | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const GID_A = '66666666-6666-4666-8666-666666666661';

/** Alice ist Admin (Twitch-ID in der Liste), Bob nicht. */
async function setup() {
  s = await setupApi({ admins: twitchIdAdmins([ALICE.id]) });
  return s;
}

async function complete(api: ApiSetup, user: TwitchUser) {
  const { cookie } = await login(api, user);
  const h = { cookie, 'content-type': 'application/json' };
  await api.app.inject({ method: 'POST', url: '/api/me/terms', headers: h, payload: { version: 1 } });
  await connect(api, cookie, user);
  const me = (await api.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
  return { cookie, h, pid: me.pid as string, soloTeamId: me.soloTeamId as string, actor: `user:${me.pid as string}` };
}

const post = (api: ApiSetup, url: string, h: Record<string, string>, payload?: object) => {
  const opts: InjectOptions = payload === undefined ? { method: 'POST', url, headers: { cookie: h.cookie! } } : { method: 'POST', url, headers: h, payload };
  return api.app.inject(opts);
};
const get = (api: ApiSetup, url: string, cookie?: string) => api.app.inject({ method: 'GET', url, ...(cookie ? { headers: { cookie } } : {}) });

describe('Verwaltung (NEW_DESIGN.md 11.4)', () => {
  it('every /api/admin route answers 403 not_admin for a non-admin and writes no read entry; without session 401', async () => {
    const api = await setup();
    const bob = await complete(api, BOB);
    const routes: InjectOptions[] = [
      { method: 'GET', url: '/api/admin/ops' },
      { method: 'GET', url: '/api/admin/streamers?q=a' },
      { method: 'POST', url: '/api/admin/bans', payload: { pid: bob.pid, reason: 'x' } },
      { method: 'POST', url: `/api/admin/bans/${bob.pid}/lift`, payload: { reason: 'x' } },
      { method: 'POST', url: '/api/admin/warnings', payload: { pid: bob.pid, reason: 'x' } },
      { method: 'POST', url: '/api/admin/warnings/1/withdraw', payload: { pid: bob.pid, reason: 'x' } },
      { method: 'POST', url: '/api/admin/terms', payload: { text: 'x' } },
      { method: 'GET', url: '/api/admin/feedback' },
      { method: 'PUT', url: '/api/admin/feedback/1', payload: { done: true } },
      { method: 'POST', url: '/api/admin/revert', payload: { eventId: '1', reason: 'x' } },
    ];
    for (const r of routes) {
      const denied = await api.app.inject({ ...r, headers: bob.h });
      expect(denied.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(denied.json()).toMatchObject({ code: 'not_admin' });
      expect((await api.app.inject(r)).statusCode, `${r.method} ${r.url} ohne Sitzung`).toBe(401);
    }
    const reads = await api.pool.query("SELECT count(*)::int AS n FROM access_log WHERE kind = 'read' AND action LIKE 'admin_%'");
    expect(reads.rows[0]!.n).toBe(0);
  });

  it('admin bans, warns, withdraws and lifts with reasons; search shows banned and warnings; GET /me of the streamer shows them', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    const noReason = await post(api, '/api/admin/bans', alice.h, { pid: bob.pid, reason: ' ' });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json()).toMatchObject({ code: 'reason_required' });
    expect((await post(api, '/api/admin/bans', alice.h, { pid: bob.pid, reason: 'Bot-Verhalten' })).statusCode).toBe(200);
    const warned = await post(api, '/api/admin/warnings', alice.h, { pid: bob.pid, reason: 'Keyword-Spam' });
    expect(warned.statusCode).toBe(200);
    const warningId = warned.json().events[0].id as string;
    const search = await get(api, '/api/admin/streamers?q=bo', alice.cookie);
    expect(search.statusCode).toBe(200);
    expect(search.json()).toEqual([
      {
        pid: bob.pid,
        login: 'bob',
        displayName: 'Bob',
        channelConnected: true,
        termsVersion: 1,
        banned: { reason: 'Bot-Verhalten', since: expect.any(String) },
        warnings: [{ eventId: warningId, reason: 'Keyword-Spam', at: expect.any(String) }],
      },
    ]);
    const me = (await get(api, '/api/me', bob.cookie)).json();
    expect(me).toMatchObject({ banned: { reason: 'Bot-Verhalten' }, warnings: [{ eventId: warningId }] });
    expect((await post(api, `/api/admin/warnings/${warningId}/withdraw`, alice.h, { pid: bob.pid, reason: 'Versehen' })).statusCode).toBe(200);
    expect((await post(api, `/api/admin/bans/${bob.pid}/lift`, alice.h, { reason: 'Geklärt' })).statusCode).toBe(200);
    const after = (await get(api, `/api/admin/streamers?q=${bob.pid.slice(0, 0)}bob`, alice.cookie)).json()[0];
    expect(after).toMatchObject({ banned: null, warnings: [] });
    const all = (await get(api, '/api/admin/streamers', alice.cookie)).json();
    expect(all.map((x: { login: string }) => x.login).sort()).toEqual(['alice', 'bob']);
    const reads = await api.pool.query("SELECT action, count(*)::int AS n FROM access_log WHERE kind = 'read' AND action = 'admin_search' GROUP BY action");
    expect(reads.rows[0]!.n).toBe(3);
  });

  it('ops view lists channels with warnings, giveaway counts, denied commands of the last 24 h and browser errors', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    await upsertChannelStatus(api.pool, bob.pid, { live: true, viewers: 184, chatters: 120, lastSignalAt: new Date(AT.getTime() - 5 * 60_000), worker: 0 }, AT);
    const r = await api.rt.bus.execute(api.rt.handlers.create, { giveawayId: GID_A, teamId: bob.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [bob.pid] } }, ctx({ actor: bob.actor }));
    if (!r.ok) throw new Error(r.rejection.code);
    // Eine Ablehnung landet gedrosselt im Zugriffslog (5.5).
    expect((await post(api, `/api/giveaways/${GID_A}/pause`, bob.h)).statusCode).toBe(400);
    await recordBrowserError(api.pool, { message: 'TypeError: x is undefined', stack: 'at a.js:1', url: 'https://g.example/giveaways/1', userAgent: 'UA' }, AT);
    const ops = await get(api, '/api/admin/ops', alice.cookie);
    expect(ops.statusCode).toBe(200);
    const body = ops.json();
    expect(body.db).toBe('ok');
    expect(body.giveaways).toMatchObject({ draft: 1, open: 0, paused: 0, closed: 0, drawn: 0 });
    const ch = body.channels.find((c: { pid: string }) => c.pid === bob.pid);
    expect(ch).toMatchObject({ displayName: 'Bob', live: true, viewers: 184, warning: { level: 'gelb' } });
    expect(body.workers).toEqual([{ worker: 0, channels: 1, lastUpdate: expect.any(String) }]);
    expect(body.denied[0]).toMatchObject({ action: 'pause_giveaway', reason: 'invalid_transition', count: 1, lastAt: expect.any(String) });
    expect(body.browserErrors).toEqual([{ at: AT.toISOString(), message: 'TypeError: x is undefined', url: 'https://g.example/giveaways/1' }]);
    const reads = await api.pool.query("SELECT count(*)::int AS n FROM access_log WHERE kind = 'read' AND action = 'admin_view_ops'");
    expect(reads.rows[0]!.n).toBe(1);
  });

  it('POST /api/errors stores message, url and user agent without pid or ip even with a session cookie; a 9 KiB body → 413; GET /api/terms works without session', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const res = await api.app.inject({
      method: 'POST',
      url: '/api/errors',
      headers: { cookie: alice.cookie, 'content-type': 'application/json', 'user-agent': 'E2E-Browser' },
      payload: { message: 'x'.repeat(600), stack: 'at b.js:2', url: 'https://g.example/portal' },
    });
    expect(res.statusCode).toBe(202);
    const rows = await api.pool.query('SELECT message, stack, url, user_agent FROM browser_errors');
    expect(rows.rows).toEqual([{ message: 'x'.repeat(500), stack: 'at b.js:2', url: 'https://g.example/portal', user_agent: 'E2E-Browser' }]);
    const cols = await api.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'browser_errors' ORDER BY column_name");
    expect(cols.rows.map((c) => c.column_name)).toEqual(['at', 'id', 'message', 'stack', 'url', 'user_agent']);
    const big = await api.app.inject({ method: 'POST', url: '/api/errors', headers: { 'content-type': 'application/json' }, payload: { message: 'y'.repeat(9 * 1024) } });
    expect(big.statusCode).toBe(413);
    expect((await api.app.inject({ method: 'POST', url: '/api/errors', headers: { 'content-type': 'application/json' }, payload: { nope: 1 } })).statusCode).toBe(400);
    const terms = await get(api, '/api/terms');
    expect(terms.statusCode).toBe(200);
    expect(terms.json()).toEqual({ version: 1, text: null, publishedAt: null });
  });

  it('feedback: POST stores text for the session pid, admin list shows display names and marks done; maintenance purges browser errors older than 30 days', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    expect((await post(api, '/api/feedback', bob.h, { text: '  ' })).statusCode).toBe(400);
    const sent = await post(api, '/api/feedback', bob.h, { text: 'Die Chance könnte größer stehen.' });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toEqual({ id: expect.any(Number) });
    expect((await get(api, '/api/admin/feedback', bob.cookie)).statusCode).toBe(403);
    const list = await get(api, '/api/admin/feedback', alice.cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([{ id: sent.json().id, pid: bob.pid, displayName: 'Bob', text: 'Die Chance könnte größer stehen.', at: expect.any(String), done: false }]);
    expect((await api.app.inject({ method: 'PUT', url: `/api/admin/feedback/${sent.json().id}`, headers: alice.h, payload: { done: true } })).statusCode).toBe(204);
    expect((await get(api, '/api/admin/feedback?done=false', alice.cookie)).json()).toEqual([]);
    expect((await get(api, '/api/admin/feedback?done=true', alice.cookie)).json()[0]).toMatchObject({ done: true });
    const reads = await api.pool.query("SELECT count(*)::int AS n FROM access_log WHERE kind = 'read' AND action = 'admin_view_feedback'");
    expect(reads.rows[0]!.n).toBe(3);
    await recordBrowserError(api.pool, { message: 'alt' }, new Date(AT.getTime() - (BROWSER_ERROR_RETENTION_DAYS + 1) * 86_400_000));
    await recordBrowserError(api.pool, { message: 'neu' }, AT);
    expect(await purgeBrowserErrors(api.pool, AT)).toBe(1);
    expect((await api.pool.query('SELECT message FROM browser_errors')).rows).toEqual([{ message: 'neu' }]);
  });

  it('admin publishes terms: GET /api/terms shows version 2 with text, the streamer needs to accept again', async () => {
    // Echte Rechte, damit terms_required greift.
    s = await setupApi({ admins: twitchIdAdmins([ALICE.id]), auth: accountAuthorizer(), teamAuth: accountTeamAuthorizer(), teamDirectory: pgTeamDirectory(), bans: pgBanDirectory() });
    const api = s;
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    const published = await post(api, '/api/admin/terms', alice.h, { text: 'Fassung zwei.' });
    expect(published.statusCode).toBe(200);
    expect((await get(api, '/api/terms')).json()).toMatchObject({ version: 2, text: 'Fassung zwei.' });
    const blocked = await api.app.inject({ method: 'POST', url: '/api/giveaways', headers: bob.h, payload: { teamId: bob.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [bob.pid] } } });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json()).toMatchObject({ code: 'terms_required' });
    expect((await api.app.inject({ method: 'POST', url: '/api/me/terms', headers: bob.h, payload: { version: 2 } })).statusCode).toBe(204);
    expect((await get(api, '/api/me', bob.cookie)).json()).toMatchObject({ termsVersion: 2, currentTermsVersion: 2 });
  });
});
