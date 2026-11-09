import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { CommandHandler, CommandResult } from '../src/framework/command-bus.js';
import { GIVEAWAY_EVENTS, giveawayStream, type GiveawayState } from '../src/framework/giveaway/state.js';
import { accountAuthorizer, accountTeamAuthorizer } from '../src/identity/account/authorizer.js';
import type { TwitchUser } from '../src/identity/identities.js';
import { pgBanDirectory, pgTeamDirectory } from '../src/identity/team-directory.js';
import { ctx } from './helpers/fixtures.js';
import { ALICE, BOB, connect, login, setupApi, type ApiSetup } from './helpers/api.js';

let s: ApiSetup | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const w of sockets.splice(0)) w.close();
  await s?.close();
  s = undefined;
});

const CAROL: TwitchUser = { id: '13579', login: 'carol', displayName: 'Carol' };
const GID_A = '66666666-6666-4666-8666-666666666661';
const GID_B = '66666666-6666-4666-8666-666666666662';

async function complete(api: ApiSetup, user: TwitchUser) {
  const { cookie } = await login(api, user);
  const h = { cookie, 'content-type': 'application/json' };
  await api.app.inject({ method: 'POST', url: '/api/me/terms', headers: h, payload: { version: 1 } });
  await connect(api, cookie, user);
  const me = (await api.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
  return { cookie, pid: me.pid as string, soloTeamId: me.soloTeamId as string, actor: `user:${me.pid as string}` };
}

async function must<C, P, Q>(api: ApiSetup, h: CommandHandler<C, GiveawayState, P, Q>, cmd: C, actor: string) {
  const r: CommandResult = await api.rt.bus.execute(h, cmd, ctx({ actor }));
  if (!r.ok) throw new Error(`${h.type}: ${r.rejection.code}: ${r.rejection.message}`);
  return r.events;
}

async function listen(api: ApiSetup): Promise<string> {
  await api.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = api.app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${addr.port}/api/ws`;
}

/** Verbindet und sammelt alle Nachrichten; `next()` wartet auf die nächste, `closed` auf das Ende. */
function open(url: string, cookie?: string) {
  const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
  sockets.push(ws);
  const queue: unknown[] = [];
  const waiters: ((m: unknown) => void)[] = [];
  ws.on('message', (raw) => {
    const m: unknown = JSON.parse(String(raw));
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (e) => reject(e));
  });
  const next = (ms = 2000) =>
    new Promise<unknown>((resolve, reject) => {
      const m = queue.shift();
      if (m !== undefined) return resolve(m);
      const t = setTimeout(() => reject(new Error('keine Nachricht')), ms);
      waiters.push((x) => {
        clearTimeout(t);
        resolve(x);
      });
    });
  const silence = (ms = 300) => new Promise<boolean>((resolve) => setTimeout(() => resolve(queue.length === 0), ms));
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  return { ws, ready, closed, next, silence, send };
}

describe('WebSocket /ws', () => {
  it('without session the socket closes with 4401; with session a subscribed stream delivers one event per command without payload', async () => {
    s = await setupApi();
    const api = s;
    const alice = await complete(api, ALICE);
    await must(api, api.rt.handlers.create, { giveawayId: GID_A, teamId: alice.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [alice.pid] } }, alice.actor);
    await must(api, api.rt.handlers.open, { giveawayId: GID_A }, alice.actor);
    const url = await listen(api);
    const anon = open(url);
    expect(await anon.closed).toMatchObject({ code: 4401 });

    const c = open(url, alice.cookie);
    await c.ready;
    c.send({ subscribe: [giveawayStream(GID_A)] });
    expect(await c.next()).toEqual({ subscribed: [giveawayStream(GID_A)] });
    const [paused] = await must(api, api.rt.handlers.pause, { giveawayId: GID_A }, alice.actor);
    const msg = (await c.next()) as { event: Record<string, unknown> };
    expect(msg).toEqual({ event: { stream: giveawayStream(GID_A), seq: paused!.seq, type: GIVEAWAY_EVENTS.statusChanged, id: paused!.id, at: paused!.createdAt.toISOString() } });
    expect(Object.keys(msg.event)).not.toContain('payload');
    c.send({ unsubscribe: [giveawayStream(GID_A)] });
    expect(await c.next()).toEqual({ unsubscribed: [giveawayStream(GID_A)] });
    await must(api, api.rt.handlers.resume, { giveawayId: GID_A }, alice.actor);
    expect(await c.silence()).toBe(true);
  });

  it('a foreign team giveaway is refused; a participant with a row or an open giveaway may subscribe; malformed input answers an error', async () => {
    s = await setupApi({ auth: accountAuthorizer(), teamAuth: accountTeamAuthorizer(), teamDirectory: pgTeamDirectory(), bans: pgBanDirectory() });
    const api = s;
    const alice = await complete(api, ALICE);
    const bob = await complete(api, BOB);
    const carol = await complete(api, CAROL);
    for (const gid of [GID_A, GID_B]) {
      await must(api, api.rt.handlers.create, { giveawayId: gid, teamId: alice.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [alice.pid] } }, alice.actor);
      await must(api, api.rt.handlers.open, { giveawayId: gid }, alice.actor);
      await must(api, api.rt.handlers.kernelCommand, { giveawayId: gid, command: { type: 'open_window', args: {} } }, alice.actor);
    }
    await must(api, api.rt.handlers.register, { giveawayId: GID_A, pid: bob.pid }, bob.actor);
    await must(api, api.rt.handlers.close, { giveawayId: GID_A }, alice.actor);
    const url = await listen(api);

    const b = open(url, bob.cookie);
    await b.ready;
    b.send({ subscribe: [giveawayStream(GID_A), `team:${alice.soloTeamId}`] });
    expect(await b.next()).toEqual({ error: { code: 'not_allowed', message: 'Diesen Verlauf darfst du nicht abonnieren.', stream: `team:${alice.soloTeamId}` } });
    expect(await b.next()).toEqual({ subscribed: [giveawayStream(GID_A)] });

    const c = open(url, carol.cookie);
    await c.ready;
    c.send({ subscribe: [giveawayStream(GID_A)] });
    expect(await c.next()).toEqual({ error: { code: 'not_allowed', message: 'Diesen Verlauf darfst du nicht abonnieren.', stream: giveawayStream(GID_A) } });
    c.send({ subscribe: [giveawayStream(GID_B), 'nonsense', 'giveaway:nope'] });
    expect(await c.next()).toEqual({ error: { code: 'invalid_stream', message: 'Dieser Verlauf ist unbekannt.', stream: 'nonsense' } });
    expect(await c.next()).toEqual({ error: { code: 'invalid_stream', message: 'Dieser Verlauf ist unbekannt.', stream: 'giveaway:nope' } });
    expect(await c.next()).toEqual({ subscribed: [giveawayStream(GID_B)] });
    c.send('kein json');
    expect(await c.next()).toEqual({ error: { code: 'invalid_message', message: 'Die Nachricht ist kein gültiges JSON-Objekt.', stream: null } });

    await must(api, api.rt.handlers.draw, { giveawayId: GID_A }, alice.actor);
    expect(await b.next()).toMatchObject({ event: { stream: giveawayStream(GID_A), type: GIVEAWAY_EVENTS.drawn } });
    expect(await c.silence()).toBe(true);
    await must(api, api.rt.handlers.pause, { giveawayId: GID_B }, alice.actor);
    expect(await c.next()).toMatchObject({ event: { stream: giveawayStream(GID_B), type: GIVEAWAY_EVENTS.statusChanged } });
    expect(await b.silence()).toBe(true);
  });

  it('a message above 16 KiB closes the socket (1009); two quick subscribes to one stream deliver each event once', async () => {
    s = await setupApi();
    const api = s;
    const alice = await complete(api, ALICE);
    await must(api, api.rt.handlers.create, { giveawayId: GID_A, teamId: alice.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [alice.pid] } }, alice.actor);
    const url = await listen(api);
    const big = open(url, alice.cookie);
    await big.ready;
    big.ws.send('x'.repeat(20_000));
    expect((await big.closed).code).toBe(1009);

    const c = open(url, alice.cookie);
    await c.ready;
    c.send({ subscribe: [giveawayStream(GID_A)] });
    c.send({ subscribe: [giveawayStream(GID_A)] });
    expect(await c.next()).toEqual({ subscribed: [giveawayStream(GID_A)] });
    expect(await c.next()).toEqual({ subscribed: [giveawayStream(GID_A)] });
    await must(api, api.rt.handlers.open, { giveawayId: GID_A }, alice.actor);
    expect(await c.next()).toMatchObject({ event: { type: GIVEAWAY_EVENTS.legalFrozen } });
    expect(await c.next()).toMatchObject({ event: { type: GIVEAWAY_EVENTS.statusChanged } });
    expect(await c.silence()).toBe(true);
  });

  it('closing a socket drops its subscriptions; other sockets keep receiving', async () => {
    s = await setupApi();
    const api = s;
    const alice = await complete(api, ALICE);
    await must(api, api.rt.handlers.create, { giveawayId: GID_A, teamId: alice.soloTeamId, kernelId: 'instant', settings: { prize: 'Key', channels: [alice.pid] } }, alice.actor);
    const url = await listen(api);
    const one = open(url, alice.cookie);
    const two = open(url, alice.cookie);
    await Promise.all([one.ready, two.ready]);
    one.send({ subscribe: [giveawayStream(GID_A)] });
    two.send({ subscribe: [giveawayStream(GID_A)] });
    await one.next();
    await two.next();
    one.ws.close();
    await one.closed;
    await must(api, api.rt.handlers.open, { giveawayId: GID_A }, alice.actor);
    expect(await two.next()).toMatchObject({ event: { type: GIVEAWAY_EVENTS.legalFrozen } });
    expect(await two.next()).toMatchObject({ event: { type: GIVEAWAY_EVENTS.statusChanged } });
  });
});
