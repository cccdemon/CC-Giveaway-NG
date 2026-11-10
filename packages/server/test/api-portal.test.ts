import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandHandler, CommandResult } from '../src/framework/command-bus.js';
import { GateCheckError, type GateChecker } from '../src/framework/giveaway/gates.js';
import { GIVEAWAY_EVENTS, giveawayStream, type GiveawayState } from '../src/framework/giveaway/state.js';
import type { TwitchUser } from '../src/identity/identities.js';
import { TICKETS_EVENTS } from '../src/kernels/tickets/index.js';
import { AT } from './helpers/db.js';
import { ctx } from './helpers/fixtures.js';
import { accountAuthorizer, accountTeamAuthorizer } from '../src/identity/account/authorizer.js';
import { pgBanDirectory, pgTeamDirectory } from '../src/identity/team-directory.js';
import { allAdmins } from '../src/platform/admin.js';
import { ALICE, BOB, connect, login, setupApi, type ApiSetup } from './helpers/api.js';
import { identityResolver } from '../src/identity/resolver.js';

let s: ApiSetup | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const CAROL: TwitchUser = { id: '13579', login: 'carol', displayName: 'Carol' };
const UNKNOWN = '66666666-6666-4666-8666-66666666666a';
const GID_A = '66666666-6666-4666-8666-666666666661';
const GID_B = '66666666-6666-4666-8666-666666666662';

function gateStub() {
  const stub = {
    fail: false,
    calls: [] as { pids: string[] }[],
    checker: {} as GateChecker,
  };
  stub.checker = {
    check: vi.fn(async (_db, input) => {
      stub.calls.push({ pids: input.pids });
      if (stub.fail) throw new GateCheckError('twitch_unreachable', 'Twitch antwortet nicht. Versuche es gleich noch einmal.');
      return input.pids.map((pid: string) => ({ pid, ok: true, reasons: [] as string[] }));
    }),
  };
  return stub;
}

async function setup() {
  const gates = gateStub();
  s = await setupApi({ gates: gates.checker, identities: identityResolver() });
  return { api: s, gates };
}

async function complete(api: ApiSetup, user: TwitchUser) {
  const { cookie } = await login(api, user);
  const h = { cookie, 'content-type': 'application/json' };
  await api.app.inject({ method: 'POST', url: '/api/me/terms', headers: h, payload: { version: 1 } });
  await connect(api, cookie, user);
  const me = (await api.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
  return { cookie, h, pid: me.pid as string, soloTeamId: me.soloTeamId as string, actor: `user:${me.pid as string}` };
}

async function must<C, P, Q>(api: ApiSetup, h: CommandHandler<C, GiveawayState, P, Q>, cmd: C, actor: string) {
  const r: CommandResult = await api.rt.bus.execute(h, cmd, ctx({ actor }));
  if (!r.ok) throw new Error(`${h.type}: ${r.rejection.code}: ${r.rejection.message}`);
  return r.events;
}

const post = (api: ApiSetup, url: string, cookie: string, payload?: object) => {
  const opts: InjectOptions = payload === undefined ? { method: 'POST', url, headers: { cookie } } : { method: 'POST', url, headers: { cookie, 'content-type': 'application/json' }, payload };
  return api.app.inject(opts);
};
const get = (api: ApiSetup, url: string, cookie?: string) => api.app.inject({ method: 'GET', url, ...(cookie ? { headers: { cookie } } : {}) });
const types = (body: { events: { type: string }[] }) => body.events.map((e) => e.type);

/** Offenes instant-Giveaway von Alice mit offenem Anmeldefenster. */
async function openInstant(api: ApiSetup, alice: Awaited<ReturnType<typeof complete>>, giveawayId: string, extra: Record<string, unknown> = {}) {
  await must(api, api.rt.handlers.create, { giveawayId, teamId: alice.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [alice.pid], contact: 'Discord: alice', ...extra } }, alice.actor);
  await must(api, api.rt.handlers.open, { giveawayId }, alice.actor);
  await must(api, api.rt.handlers.kernelCommand, { giveawayId, command: { type: 'open_window', args: {} } }, alice.actor);
}

describe('Portal-API', () => {
  it('GET /public/giveaways/:id shows prize, kernel, status, channel names, keyword and legal without session and without participant pids', async () => {
    const { api } = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    await openInstant(api, alice, GID_A, { keyword: '!key' });
    await must(api, api.rt.handlers.register, { giveawayId: GID_A, pid: bob.pid }, bob.actor);
    const r = await get(api, `/api/public/giveaways/${GID_A}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      id: GID_A,
      prize: 'Key',
      sponsor: null,
      kernel: { id: 'instant', label: 'Sofortverlosung', display: expect.objectContaining({ icon: '⚡' }), commands: [{ type: 'open_window', label: 'Anmeldefenster öffnen', issuer: 'streamer' }, { type: 'close_window', label: 'Anmeldefenster schließen', issuer: 'scheduler' }] },
      status: 'open',
      channels: [{ pid: alice.pid, displayName: 'Alice' }],
      keyword: '!key',
      legal: expect.objectContaining({ impressum: { url: 'https://test.example/impressum', hash: 'h:https://test.example/impressum' } }),
      claimDays: 14,
      counting: 'registered',
      winnersCount: 1,
    });
    expect(r.body).not.toContain(bob.pid);
    expect((await get(api, `/api/public/giveaways/${UNKNOWN}`)).statusCode).toBe(404);
    expect((await get(api, '/api/public/giveaways/nope')).statusCode).toBe(404);
  });

  it('register and withdraw via the portal run as the session pid; register on a closed giveaway → 400 not_open', async () => {
    const { api } = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    await openInstant(api, alice, GID_A);
    const reg = await post(api, `/api/portal/giveaways/${GID_A}/register`, bob.cookie);
    expect(reg.statusCode).toBe(200);
    expect(types(reg.json())).toEqual([GIVEAWAY_EVENTS.registered]);
    const actors = await api.pool.query('SELECT actor, payload FROM events WHERE stream = $1 AND type = $2', [giveawayStream(GID_A), GIVEAWAY_EVENTS.registered]);
    expect(actors.rows).toEqual([{ actor: bob.actor, payload: { pid: bob.pid } }]);
    const wd = await post(api, `/api/portal/giveaways/${GID_A}/withdraw`, bob.cookie);
    expect(types(wd.json())).toEqual([GIVEAWAY_EVENTS.withdrawn]);
    await must(api, api.rt.handlers.close, { giveawayId: GID_A }, alice.actor);
    const late = await post(api, `/api/portal/giveaways/${GID_A}/register`, bob.cookie);
    expect(late.statusCode).toBe(400);
    expect(late.json()).toEqual({ code: 'not_open', message: 'Das Giveaway nimmt gerade keine Anmeldungen an.' });
    expect((await post(api, `/api/portal/giveaways/${GID_A}/register`, 'ccg_session=nope')).statusCode).toBe(401);
  });

  it('GET /portal/giveaways lists my participations with chance; detail shows view, gates and winner info after a draw', async () => {
    const { api } = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    await openInstant(api, alice, GID_A);
    await openInstant(api, alice, GID_B);
    await post(api, `/api/portal/giveaways/${GID_A}/register`, bob.cookie);
    const list = await get(api, '/api/portal/giveaways', bob.cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      { id: GID_A, prize: 'Key', kernelLabel: 'Sofortverlosung', status: 'open', registered: true, inPool: true, weight: 1, chance: 1, winnerStatus: null, updatedAt: expect.any(String) },
    ]);
    const detail = await get(api, `/api/portal/giveaways/${GID_A}`, bob.cookie);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: GID_A,
      status: 'open',
      registered: true,
      view: { registered: true, inPool: true, weight: 1, lines: [{ label: 'Anmeldefenster', value: expect.stringMatching(/^offen bis/) }] },
      chance: 1,
      gates: [],
      lastGateResult: null,
      winner: null,
      channels: [{ pid: alice.pid, displayName: 'Alice' }],
    });
    await must(api, api.rt.handlers.close, { giveawayId: GID_A }, alice.actor);
    await must(api, api.rt.handlers.draw, { giveawayId: GID_A }, alice.actor);
    const won = (await get(api, `/api/portal/giveaways/${GID_A}`, bob.cookie)).json();
    expect(won.status).toBe('drawn');
    expect(won.lastGateResult).toEqual({ ok: true, reasons: [] });
    expect(won.winner).toEqual({ status: 'pending', claimDeadline: new Date(AT.getTime() + 14 * 86_400_000).toISOString(), contact: 'Discord: alice' });
    expect((await get(api, '/api/portal/giveaways', bob.cookie)).json()[0]).toMatchObject({ status: 'drawn', winnerStatus: 'pending' });
  });

  it('detail returns consent: the version the participant agreed to, from the frozen texts or from the import; null without registration', async () => {
    const { api } = await setup();
    const alice = await complete(api, ALICE);
    await openInstant(api, alice, GID_A);
    const [, importEvent] = await must(
      api, api.rt.handlers.importLegacy,
      {
        giveawayId: GID_B, teamId: alice.soloTeamId, legacySessionId: 'sess_9', prize: 'Box', sponsor: null, keyword: null, coinBaseSec: 7200, followMin: 0,
        chatBonus: { enabled: true, sec: 2, minWords: 4, cooldownSec: 10 }, channels: [ALICE], status: 'paused', terms: { version: 3, text: 'Alte Fassung 3.' },
        participants: [{ user: BOB, registered: true, perChannel: { [ALICE.id]: 600 } }],
      },
      'system:migration',
    );
    const bob = await complete(api, BOB);
    const before = (await get(api, `/api/portal/giveaways/${GID_A}`, bob.cookie)).json();
    expect(before.consent).toBeNull();
    await post(api, `/api/portal/giveaways/${GID_A}/register`, bob.cookie);
    const frozen = (await get(api, `/api/portal/giveaways/${GID_A}`, bob.cookie)).json();
    expect(frozen.consent).toEqual({ at: AT.toISOString(), terms: { text: 'Testregeln.' } });
    const legacy = (await get(api, `/api/portal/giveaways/${GID_B}`, bob.cookie)).json();
    expect(legacy.status).toBe('paused');
    expect(legacy.legalEventId).toBe(importEvent!.id);
    expect(legacy.consent).toEqual({ at: AT.toISOString(), terms: { text: 'Alte Fassung 3.' } });
    expect(legacy.legal).toEqual({ impressumUrl: null, terms: { text: 'Alte Fassung 3.' }, privacyUrl: null });
  });

  it('detail of an open giveaway without participation works, of a closed one → 404', async () => {
    const { api } = await setup();
    const alice = await complete(api, ALICE);
    const carol = await complete(api, CAROL);
    await openInstant(api, alice, GID_A);
    await openInstant(api, alice, GID_B);
    const open = await get(api, `/api/portal/giveaways/${GID_A}`, carol.cookie);
    expect(open.statusCode).toBe(200);
    expect(open.json()).toMatchObject({ registered: false, view: { registered: false, inPool: false, weight: 0 }, chance: null });
    await must(api, api.rt.handlers.close, { giveawayId: GID_B }, alice.actor);
    expect((await get(api, `/api/portal/giveaways/${GID_B}`, carol.cookie)).statusCode).toBe(404);
    expect((await get(api, `/api/portal/giveaways/${UNKNOWN}`, carol.cookie)).statusCode).toBe(404);
    expect((await get(api, `/api/portal/giveaways/${GID_A}`)).statusCode).toBe(401);
  });

  it('GET gates asks the checker for my pid only; checker failure → 502 twitch_unreachable', async () => {
    const { api, gates } = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    await openInstant(api, alice, GID_A, { gates: [{ id: 'follow', mode: 'all' }] });
    const ok = await get(api, `/api/portal/giveaways/${GID_A}/gates`, bob.cookie);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, reasons: [] });
    expect(gates.calls).toEqual([{ pids: [bob.pid] }]);
    gates.fail = true;
    const down = await get(api, `/api/portal/giveaways/${GID_A}/gates`, bob.cookie);
    expect(down.statusCode).toBe(502);
    expect(down.json()).toEqual({ code: 'twitch_unreachable', message: 'Twitch antwortet nicht. Versuche es gleich noch einmal.' });
  });

  it('GET gates follows the detail rule: uninvolved on a closed or draft giveaway → 404, involved → 200', async () => {
    const { api, gates } = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    const carol = await complete(api, CAROL);
    await openInstant(api, alice, GID_A);
    await must(api, api.rt.handlers.create, { giveawayId: GID_B, teamId: alice.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [alice.pid] } }, alice.actor);
    await post(api, `/api/portal/giveaways/${GID_A}/register`, bob.cookie);
    await must(api, api.rt.handlers.close, { giveawayId: GID_A }, alice.actor);
    expect((await get(api, `/api/portal/giveaways/${GID_A}/gates`, carol.cookie)).statusCode).toBe(404);
    expect((await get(api, `/api/portal/giveaways/${GID_B}/gates`, carol.cookie)).statusCode).toBe(404);
    expect((await get(api, `/api/portal/giveaways/${GID_A}/gates`, bob.cookie)).statusCode).toBe(200);
    expect(gates.calls).toEqual([{ pids: [bob.pid] }]);
  });

  it('GET /public/giveaways/:id hides drafts (404) but shows closed, drawn and cancelled giveaways', async () => {
    const { api } = await setup();
    const alice = await complete(api, ALICE);
    await must(api, api.rt.handlers.create, { giveawayId: GID_B, teamId: alice.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [alice.pid] } }, alice.actor);
    expect((await get(api, `/api/public/giveaways/${GID_B}`)).statusCode).toBe(404);
    await openInstant(api, alice, GID_A);
    await must(api, api.rt.handlers.cancel, { giveawayId: GID_A }, alice.actor);
    const r = await get(api, `/api/public/giveaways/${GID_A}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('cancelled');
  });

  it('portal kernel command buys tickets for the session pid, not for another pid in the body', async () => {
    const { api } = await setup();
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    const carol = await complete(api, CAROL);
    await must(api, api.rt.handlers.create, { giveawayId: GID_A, teamId: alice.soloTeamId, kernelId: 'tickets', settings: { prize: 'Key', channels: [alice.pid], config: { coinBaseSec: 60 } } }, alice.actor);
    await must(api, api.rt.handlers.open, { giveawayId: GID_A }, alice.actor);
    await post(api, `/api/portal/giveaways/${GID_A}/register`, bob.cookie);
    await must(api, api.rt.handlers.correctWatch, { giveawayId: GID_A, channel: alice.pid, pid: bob.pid, sec: 300, reason: 'Test' }, alice.actor);
    const bought = await post(api, `/api/portal/giveaways/${GID_A}/kernel-commands`, bob.cookie, { type: 'buy_tickets', args: { count: 2 }, pid: carol.pid });
    expect(bought.statusCode).toBe(200);
    expect(types(bought.json())).toEqual([TICKETS_EVENTS.bought]);
    const row = await api.pool.query('SELECT payload FROM events WHERE stream = $1 AND type = $2', [giveawayStream(GID_A), TICKETS_EVENTS.bought]);
    expect(row.rows[0]!.payload).toEqual({ pid: bob.pid, count: 2, coins: 2 });
    const detail = (await get(api, `/api/portal/giveaways/${GID_A}`, bob.cookie)).json();
    expect(detail.view).toMatchObject({ inPool: true, weight: 2, lines: [{ label: 'Zuschauzeit', value: '5 min' }, { label: 'Coins', value: '3' }, { label: 'Tickets', value: '2' }] });
    const tooMany = await post(api, `/api/portal/giveaways/${GID_A}/kernel-commands`, bob.cookie, { type: 'buy_tickets', args: { count: 9 } });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().code).toBe('not_enough_coins');
  });
});

describe('Portal und Plattform-Sperre (Teilprojekt 8c)', () => {
  it('a banned streamer can still register as a participant in another giveaway, but controls no giveaway (403 account_banned)', async () => {
    // Echte Rechte: nur so greift die Sperre bei Streamer-Befehlen.
    s = await setupApi({ admins: allAdmins, auth: accountAuthorizer(), teamAuth: accountTeamAuthorizer(), teamDirectory: pgTeamDirectory(), bans: pgBanDirectory() });
    const api = s;
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    await must(api, api.rt.handlers.create, { giveawayId: GID_A, teamId: bob.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [bob.pid] } }, bob.actor);
    await must(api, api.rt.handlers.open, { giveawayId: GID_A }, bob.actor);
    await must(api, api.rt.handlers.kernelCommand, { giveawayId: GID_A, command: { type: 'open_window', args: {} } }, bob.actor);
    const banned = await api.rt.bus.execute(api.platform.ban, { pid: alice.pid, reason: 'Bot-Verhalten' }, ctx({ actor: bob.actor }));
    if (!banned.ok) throw new Error(banned.rejection.code);
    expect((await post(api, `/api/portal/giveaways/${GID_A}/register`, alice.cookie)).statusCode).toBe(200);
    const create = await api.app.inject({ method: 'POST', url: '/api/giveaways', headers: alice.h, payload: { teamId: alice.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [alice.pid] } } });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toMatchObject({ code: 'account_banned' });
  });
});
