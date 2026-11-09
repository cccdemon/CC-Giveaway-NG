import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandHandler, CommandResult } from '../src/framework/command-bus.js';
import { GIVEAWAY_EVENTS, giveawayStream, type GiveawayState } from '../src/framework/giveaway/state.js';
import { INSTANT_EVENTS } from '../src/kernels/instant/index.js';
import { accountAuthorizer, accountTeamAuthorizer } from '../src/identity/account/authorizer.js';
import type { TwitchUser } from '../src/identity/identities.js';
import { pgBanDirectory, pgTeamDirectory } from '../src/identity/team-directory.js';
import { ctx } from './helpers/fixtures.js';
import { ALICE, BOB, connect, login, setupApi, type ApiSetup } from './helpers/api.js';

let s: ApiSetup | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const CAROL: TwitchUser = { id: '13579', login: 'carol', displayName: 'Carol' };
const UNKNOWN = '66666666-6666-4666-8666-66666666666a';
const GID_A = '66666666-6666-4666-8666-666666666661';
const GID_B = '66666666-6666-4666-8666-666666666662';
const GID_C = '66666666-6666-4666-8666-666666666663';

async function setup() {
  s = await setupApi({ auth: accountAuthorizer(), teamAuth: accountTeamAuthorizer(), teamDirectory: pgTeamDirectory(), bans: pgBanDirectory() });
  return s;
}

/** Anmelden, Nutzungsbedingungen, Kanal: ein vollständiges Konto. */
async function complete(api: ApiSetup, user: TwitchUser) {
  const { cookie } = await login(api, user);
  const h = { cookie, 'content-type': 'application/json' };
  await api.app.inject({ method: 'POST', url: '/me/terms', headers: h, payload: { version: 1 } });
  await connect(api, cookie, user);
  const me = (await api.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
  return { cookie, h, pid: me.pid as string, soloTeamId: me.soloTeamId as string, actor: `user:${me.pid as string}` };
}

async function must<C, P, Q>(api: ApiSetup, h: CommandHandler<C, GiveawayState, P, Q>, cmd: C, actor: string) {
  const r: CommandResult = await api.rt.bus.execute(h, cmd, ctx({ actor }));
  if (!r.ok) throw new Error(`${h.type}: ${r.rejection.code}: ${r.rejection.message}`);
  return r.events;
}

/** Entwurf anlegen und öffnen, Kanal = eigener Kanal des Streamers (Solo-Team). */
async function openGiveaway(api: ApiSetup, me: Awaited<ReturnType<typeof complete>>, giveawayId: string, prize = 'Key', open = true) {
  await must(api, api.rt.handlers.create, { giveawayId, teamId: me.soloTeamId, kernelId: 'instant', settings: { prize, channels: [me.pid] } }, me.actor);
  if (open) await must(api, api.rt.handlers.open, { giveawayId }, me.actor);
}

const get = (api: ApiSetup, url: string, cookie: string) => api.app.inject({ method: 'GET', url, headers: { cookie } });

describe('Giveaway-API (Lesen)', () => {
  it('GET /kernels lists instant, watchtime, tickets with schema, gates, services and commands', async () => {
    const api = await setup();
    expect((await api.app.inject({ method: 'GET', url: '/kernels' })).statusCode).toBe(401);
    const { cookie } = await login(api, ALICE);
    const r = await get(api, '/kernels', cookie);
    expect(r.statusCode).toBe(200);
    const list = r.json() as { id: string; label: string; commands: unknown[]; configSchema: Record<string, unknown>; display: { unit: string | null } }[];
    expect(list.map((k) => k.id)).toEqual(['instant', 'watchtime', 'tickets']);
    const tickets = list.find((k) => k.id === 'tickets')!;
    expect(tickets).toMatchObject({ label: 'Ticketkauf', drawMode: 'weighted', supportedGates: ['follow', 'account_age', 'follow_age', 'presence'], display: { unit: 'Tickets' } });
    expect(Object.keys(tickets.configSchema)).toEqual(['coinBaseSec', 'ticketPriceCoins', 'maxTicketsPerPerson']);
    expect(tickets.commands).toEqual([{ type: 'buy_tickets', label: 'Tickets kaufen', issuer: 'participant', chat: { word: '!ticket' } }]);
  });

  it('GET /giveaways lists tiles of own giveaways with counts and channel warnings, filter by status', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    await openGiveaway(api, alice, GID_A, 'Key A');
    await openGiveaway(api, alice, GID_B, 'Key B', false);
    await openGiveaway(api, bob, GID_C, 'Key C');
    const mine = await get(api, '/giveaways', alice.cookie);
    expect(mine.statusCode).toBe(200);
    const tiles = mine.json() as Record<string, unknown>[];
    expect(tiles.map((t) => t.id).sort()).toEqual([GID_A, GID_B]);
    const a = tiles.find((t) => t.id === GID_A)!;
    expect(a).toEqual({
      id: GID_A, teamId: alice.soloTeamId, kernel: 'instant', kernelLabel: 'Sofortverlosung', status: 'open', prize: 'Key A',
      registeredCount: 0, poolSize: 0, poolWeight: 0, updatedAt: expect.any(String), warnings: [],
    });
    expect((await get(api, '/giveaways?status=open', alice.cookie)).json().map((t: { id: string }) => t.id)).toEqual([GID_A]);
    expect((await get(api, '/giveaways', bob.cookie)).json().map((t: { id: string }) => t.id)).toEqual([GID_C]);
  });

  it('GET /giveaways/:id returns the detail; foreign team → 403 not_your_team; unknown → 404', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    await openGiveaway(api, alice, GID_A);
    const r = await get(api, `/giveaways/${GID_A}`, alice.cookie);
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d).toMatchObject({
      id: GID_A,
      teamId: alice.soloTeamId,
      status: 'open',
      kernel: { id: 'instant', label: 'Sofortverlosung', display: { icon: '⚡', unit: null }, supportedGates: ['follow', 'account_age'], usesServices: ['registration'] },
      settings: { prize: 'Key', channels: [alice.pid], config: { windowSec: 120 }, counting: 'registered' },
      pool: { size: 0, weight: 0 },
      registeredCount: 0,
      winners: [],
      draws: [],
      boost: null,
      channels: [{ pid: alice.pid, displayName: 'Alice', connected: true, tokenStatus: 'ok', live: false, warning: null }],
    });
    expect(d.legal).toMatchObject({ impressum: { url: 'https://test.example/impressum', hash: 'h:https://test.example/impressum' }, terms: { text: 'Testregeln.' } });
    expect(Object.keys(d.kernel.configSchema)).toEqual(['windowSec']);
    const foreign = await get(api, `/giveaways/${GID_A}`, bob.cookie);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toEqual({ code: 'not_your_team', message: 'Dieses Giveaway gehört nicht zu deinem Team.' });
    expect((await get(api, `/giveaways/${UNKNOWN}`, alice.cookie)).statusCode).toBe(404);
    expect((await get(api, '/giveaways/nope', alice.cookie)).statusCode).toBe(404);
    expect((await api.app.inject({ method: 'GET', url: `/giveaways/${GID_A}` })).statusCode).toBe(401);
  });

  it('a foreign user gets 403 before any replay of the stream; the detail logs view_detail only when it shows winners', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    await openGiveaway(api, alice, GID_A);
    const apply = vi.spyOn(api.rt.reducer, 'apply');
    expect((await get(api, `/giveaways/${GID_A}`, bob.cookie)).statusCode).toBe(403);
    expect((await get(api, `/giveaways/${GID_A}/participants`, bob.cookie)).statusCode).toBe(403);
    expect((await get(api, `/giveaways/${GID_A}/history`, bob.cookie)).statusCode).toBe(403);
    expect(apply).not.toHaveBeenCalled();
    apply.mockRestore();
    expect((await get(api, `/giveaways/${GID_A}`, alice.cookie)).statusCode).toBe(200);
    const none = await api.pool.query('SELECT count(*)::int AS n FROM access_log WHERE kind = $1 AND action = $2', ['read', 'view_detail']);
    expect(none.rows[0]!.n).toBe(0);
    await must(api, api.rt.handlers.kernelCommand, { giveawayId: GID_A, command: { type: 'open_window', args: {} } }, alice.actor);
    await must(api, api.rt.handlers.register, { giveawayId: GID_A, pid: bob.pid }, bob.actor);
    await must(api, api.rt.handlers.close, { giveawayId: GID_A }, alice.actor);
    await must(api, api.rt.handlers.draw, { giveawayId: GID_A }, alice.actor);
    expect((await get(api, `/giveaways/${GID_A}`, alice.cookie)).json().winners).toEqual([{ pid: bob.pid, displayName: 'Bob', status: 'pending' }]);
    const logged = await api.pool.query('SELECT actor, action, target FROM access_log WHERE kind = $1 AND action = $2', ['read', 'view_detail']);
    expect(logged.rows).toEqual([{ actor: alice.actor, action: 'view_detail', target: giveawayStream(GID_A) }]);
  });

  it('GET /giveaways/:id/participants returns names, weights, chance and kernel lines, writes view_participants; foreign team → 403 without log', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    const carol = await complete(api, CAROL);
    await openGiveaway(api, alice, GID_A);
    await must(api, api.rt.handlers.kernelCommand, { giveawayId: GID_A, command: { type: 'open_window', args: {} } }, alice.actor);
    await must(api, api.rt.handlers.register, { giveawayId: GID_A, pid: bob.pid }, bob.actor);
    await must(api, api.rt.handlers.register, { giveawayId: GID_A, pid: carol.pid }, carol.actor);
    const r = await get(api, `/giveaways/${GID_A}/participants`, alice.cookie);
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.pid === bob.pid)).toEqual({
      pid: bob.pid, displayName: 'Bob', registered: true, inPool: true, seen: false, weight: 1, chance: 0.5, winnerStatus: null,
      lines: [{ label: 'Anmeldefenster', value: expect.stringMatching(/^offen bis /) }],
    });
    const reads = await api.pool.query('SELECT actor, action, target FROM access_log WHERE kind = $1 AND action = $2', ['read', 'view_participants']);
    expect(reads.rows).toEqual([{ actor: alice.actor, action: 'view_participants', target: giveawayStream(GID_A) }]);
    const foreign = await get(api, `/giveaways/${GID_A}/participants`, bob.cookie);
    expect(foreign.statusCode).toBe(403);
    expect((await api.pool.query('SELECT count(*)::int AS n FROM access_log WHERE kind = $1 AND action = $2', ['read', 'view_participants'])).rows[0]!.n).toBe(1);
  });

  it('GET /giveaways/:id/history pages newest first, marks reverted entries, carries reason and reversal kind, pages do not overlap', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    await openGiveaway(api, alice, GID_A);
    const [opened] = await must(api, api.rt.handlers.kernelCommand, { giveawayId: GID_A, command: { type: 'open_window', args: {} } }, alice.actor);
    await must(api, api.rt.handlers.revert, { stream: giveawayStream(GID_A), eventId: opened!.id, reason: 'Zu früh' }, alice.actor);
    const page1 = await get(api, `/giveaways/${GID_A}/history?limit=2`, alice.cookie);
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json() as { entries: Record<string, unknown>[]; nextBeforeSeq: number | null };
    expect(p1.entries.map((e) => [e.type, e.seq])).toEqual([[INSTANT_EVENTS.windowClosed, 5], [INSTANT_EVENTS.windowOpened, 4]]);
    expect(p1.entries[0]).toMatchObject({
      reversesEventId: opened!.id, reason: 'Zu früh', reverted: false,
      actor: { kind: 'user', pid: alice.pid, displayName: 'Alice' },
      reversal: { kind: 'none', why: 'Ein geschlossenes Fenster bleibt zu. Öffne ein neues Fenster.' },
    });
    expect(p1.entries[1]).toMatchObject({ id: opened!.id, reverted: true, reversal: { kind: 'compensate' }, payload: { until: expect.any(String) } });
    expect(p1.nextBeforeSeq).toBe(4);
    const page2 = await get(api, `/giveaways/${GID_A}/history?limit=2&beforeSeq=4`, alice.cookie);
    const p2 = page2.json() as { entries: Record<string, unknown>[]; nextBeforeSeq: number | null };
    expect(p2.entries.map((e) => [e.type, e.seq])).toEqual([[GIVEAWAY_EVENTS.statusChanged, 3], [GIVEAWAY_EVENTS.legalFrozen, 2]]);
    expect(p2.entries[1]).toMatchObject({ reversal: { kind: 'none', why: 'Eingefrorene Rechtstexte sind ein Nachweis und bleiben.' }, actor: { kind: 'user', pid: alice.pid } });
    expect(p2.nextBeforeSeq).toBe(2);
    const page3 = await get(api, `/giveaways/${GID_A}/history?limit=2&beforeSeq=2`, alice.cookie);
    const p3 = page3.json() as { entries: Record<string, unknown>[]; nextBeforeSeq: number | null };
    expect(p3.entries.map((e) => e.type)).toEqual([GIVEAWAY_EVENTS.created]);
    expect(p3.nextBeforeSeq).toBeNull();
    const reads = await api.pool.query('SELECT count(*)::int AS n FROM access_log WHERE kind = $1 AND action = $2', ['read', 'view_history']);
    expect(reads.rows[0]!.n).toBe(3);
    expect((await get(api, `/giveaways/${GID_A}/history?limit=0`, alice.cookie)).json().entries).toHaveLength(1);
  });
});

const post = (api: ApiSetup, url: string, h: Record<string, string>, payload?: object) => {
  const opts: InjectOptions = payload === undefined ? { method: 'POST', url, headers: { cookie: h.cookie! } } : { method: 'POST', url, headers: h, payload };
  return api.app.inject(opts);
};
const types = (body: { events: { type: string }[] }) => body.events.map((e) => e.type);

describe('Giveaway-API (Befehle)', () => {
  it('create, settings, lifecycle, draw, winner status and complete run through the bus with the session actor', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    const created = await post(api, '/giveaways', alice.h, { teamId: alice.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [alice.pid], contact: 'Discord: alice#1' } });
    expect(created.statusCode).toBe(201);
    const { giveawayId, events } = created.json();
    expect(giveawayId).toMatch(/^[0-9a-f-]{36}$/);
    expect(events).toEqual([{ id: expect.any(String), seq: 1, type: GIVEAWAY_EVENTS.created }]);
    const g = (u: string) => `/giveaways/${giveawayId}${u}`;
    const settings = await api.app.inject({ method: 'PUT', url: g('/settings'), headers: alice.h, payload: { settings: { prize: 'Besserer Key', config: { windowSec: 300 } } } });
    expect(settings.statusCode).toBe(200);
    expect(types(settings.json())).toEqual([GIVEAWAY_EVENTS.settingsChanged]);
    expect(types((await post(api, g('/open'), alice.h)).json())).toEqual([GIVEAWAY_EVENTS.legalFrozen, GIVEAWAY_EVENTS.statusChanged]);
    expect(types((await post(api, g('/pause'), alice.h)).json())).toEqual([GIVEAWAY_EVENTS.statusChanged]);
    expect(types((await post(api, g('/resume'), alice.h)).json())).toEqual([GIVEAWAY_EVENTS.statusChanged]);
    expect(types((await post(api, g('/kernel-commands'), alice.h, { type: 'open_window', args: {} })).json())).toEqual([INSTANT_EVENTS.windowOpened]);
    await must(api, api.rt.handlers.register, { giveawayId, pid: bob.pid }, bob.actor);
    expect(types((await post(api, g('/close'), alice.h)).json())).toEqual([GIVEAWAY_EVENTS.statusChanged]);
    const drawn = await post(api, g('/draw'), alice.h);
    expect(drawn.statusCode).toBe(200);
    expect(types(drawn.json())).toEqual([GIVEAWAY_EVENTS.drawn]);
    const detail = (await get(api, g(''), alice.cookie)).json();
    expect(detail.status).toBe('drawn');
    expect(detail.winners).toEqual([{ pid: bob.pid, displayName: 'Bob', status: 'pending' }]);
    expect(detail.settings).toMatchObject({ prize: 'Besserer Key', contact: 'Discord: alice#1', config: { windowSec: 300 } });
    const status = await api.app.inject({ method: 'PUT', url: g(`/winners/${bob.pid}`), headers: alice.h, payload: { status: 'done' } });
    expect(status.statusCode).toBe(200);
    expect(types(status.json())).toEqual([GIVEAWAY_EVENTS.winnerStatusSet]);
    expect(types((await post(api, g('/complete'), alice.h)).json())).toEqual([GIVEAWAY_EVENTS.statusChanged]);
    const actors = await api.pool.query('SELECT DISTINCT actor FROM events WHERE stream = $1', [giveawayStream(giveawayId)]);
    expect(actors.rows.map((r) => r.actor).sort()).toEqual([alice.actor, bob.actor].sort());
  });

  it('boost start/stop, correction, revert and redraw answer with the written events; rejections map to 400 with code and message', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    const carol = await complete(api, CAROL);
    const created = await post(api, '/giveaways', alice.h, { teamId: alice.soloTeamId, kernelId: 'watchtime', settings: { prize: 'Key', channels: [alice.pid], config: { coinBaseSec: 60 } } });
    const { giveawayId } = created.json();
    const g = (u: string) => `/giveaways/${giveawayId}${u}`;
    await post(api, g('/open'), alice.h);
    // Boost braucht einen aktiven Kanal: setupApi hat keine Aktivität → no_signal als Ablehnung.
    const noSignal = await post(api, g('/boost'), alice.h, { factor: 2, durationSec: 600 });
    expect(noSignal.statusCode).toBe(400);
    expect(noSignal.json()).toEqual({ code: 'no_signal', message: 'Kein Kanal des Giveaways ist live und liefert Signale. Ein Boost startet nur mit Signalen.' });
    const noBoost = await api.app.inject({ method: 'DELETE', url: g('/boost'), headers: { cookie: alice.cookie } });
    expect(noBoost.statusCode).toBe(400);
    expect(noBoost.json().code).toBe('no_boost');
    await must(api, api.rt.handlers.register, { giveawayId, pid: bob.pid }, bob.actor);
    await must(api, api.rt.handlers.register, { giveawayId, pid: carol.pid }, carol.actor);
    const corrected = await post(api, g('/corrections'), alice.h, { channel: alice.pid, pid: bob.pid, sec: 120, reason: 'Ausfall' });
    expect(corrected.statusCode).toBe(200);
    expect(types(corrected.json())).toEqual(['watch_corrected']);
    const carolTime = await post(api, g('/corrections'), alice.h, { channel: alice.pid, pid: carol.pid, sec: 60, reason: 'Ausfall' });
    expect(carolTime.statusCode).toBe(200);
    const noReason = await post(api, g('/corrections'), alice.h, { channel: alice.pid, pid: bob.pid, sec: 60, reason: '' });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().code).toBe('reason_required');
    const reverted = await post(api, g('/revert'), alice.h, { eventId: corrected.json().events[0].id, reason: 'Doppelt' });
    expect(reverted.statusCode).toBe(200);
    expect(types(reverted.json())).toEqual(['watch_corrected']);
    // Bob hat nach dem Rückgängig 0 Coins, Carol 1: nur Carol im Topf, Ziehung trifft Carol.
    await post(api, g('/close'), alice.h);
    const drawn = await post(api, g('/draw'), alice.h);
    expect(drawn.statusCode).toBe(200);
    const again = await post(api, g('/redraw'), alice.h, { replace: carol.pid, reason: 'Nicht gemeldet' });
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('empty_pool');
    const noReasonRedraw = await post(api, g('/redraw'), alice.h, { replace: carol.pid });
    expect(noReasonRedraw.statusCode).toBe(400);
    expect(noReasonRedraw.json().code).toBe('reason_required');
  });

  it('a non-member gets 403 not_your_team on every command route, unknown giveaway 404, missing session 401', async () => {
    const api = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    const { giveawayId } = (await post(api, '/giveaways', alice.h, { teamId: alice.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [alice.pid] } })).json();
    const g = (u: string) => `/giveaways/${giveawayId}${u}`;
    for (const url of [g('/open'), g('/pause'), g('/resume'), g('/close'), g('/reopen'), g('/cancel'), g('/complete'), g('/draw')]) {
      const r = await post(api, url, bob.h);
      expect([url, r.statusCode, r.json().code]).toEqual([url, 403, 'not_your_team']);
    }
    expect((await api.app.inject({ method: 'PUT', url: g('/settings'), headers: bob.h, payload: { settings: { prize: 'x' } } })).statusCode).toBe(403);
    expect((await post(api, g('/revert'), bob.h, { eventId: '1', reason: 'x' })).statusCode).toBe(403);
    expect((await post(api, `/giveaways/${UNKNOWN}/open`, alice.h)).statusCode).toBe(404);
    expect((await post(api, '/giveaways/nope/open', alice.h)).statusCode).toBe(404);
    expect((await api.app.inject({ method: 'POST', url: g('/open') })).statusCode).toBe(401);
    const foreignTeam = await post(api, '/giveaways', bob.h, { teamId: alice.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [bob.pid] } });
    expect(foreignTeam.statusCode).toBe(403);
  });
});
