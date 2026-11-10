import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { minuteOf } from '../src/ingest/bundler.js';
import type { ChannelRef, Signal } from '../src/ingest/signals.js';
import { twitchAdapter } from '../src/ingest/twitch/adapter.js';
import { EventSubSocket, parseMessage, type EventSubMessage } from '../src/ingest/twitch/eventsub.js';
import { FakeSocket } from './helpers/fake-socket.js';
import { HelixError, type Conduit, type HelixClient, type StreamInfo } from '../src/ingest/twitch/helix.js';
import type { ChannelTokenProvider } from '../src/ingest/twitch/tokens.js';
import { AT } from './helpers/db.js';
import { P1, P2, P3 } from './helpers/giveaway.js';

const BOT = '999';
const ALICE = { id: '12345', login: 'alice', displayName: 'Alice' };
const raw = (name: string): string => readFileSync(new URL(`./fixtures/twitch/${name}.json`, import.meta.url), 'utf8');
const ref = (pid: string, twitchId: string, watch: 'state' | 'full' = 'full', owned = true): ChannelRef => ({ pid, twitchId, watch, owned });
const FULL = ref(P1, '1001');
const STATE = ref(P2, '1002', 'state');
const FOREIGN = ref(P3, '1003', 'full', false);

function fakeHelix() {
  const h = {
    listConduits: vi.fn<HelixClient['listConduits']>(async () => [{ id: 'cid', shardCount: 2 }] as Conduit[]),
    createConduit: vi.fn<HelixClient['createConduit']>(async (n) => ({ id: 'cid', shardCount: n })),
    updateConduit: vi.fn<HelixClient['updateConduit']>(async () => {}),
    bindShard: vi.fn<HelixClient['bindShard']>(async () => {}),
    subscribe: vi.fn<HelixClient['subscribe']>(async () => 'created'),
    getStreams: vi.fn<HelixClient['getStreams']>(async () => [{ userId: '1001', live: true, viewers: 50, startedAt: '2026-10-15T11:30:00Z' }] as StreamInfo[]),
    getChatters: vi.fn<HelixClient['getChatters']>(async () => [ALICE]),
    isFollower: vi.fn<HelixClient['isFollower']>(async (_b, userId) => ({ userId, follows: userId === ALICE.id, since: userId === ALICE.id ? '2026-01-01T00:00:00.000Z' : null })),
    getUsers: vi.fn<HelixClient['getUsers']>(async () => []),
    sendChatMessage: vi.fn<HelixClient['sendChatMessage']>(async () => ({ ok: true, messageId: 'msg-1' })),
  };
  return h;
}

function fakeTokens(token: string | null = 'user-token') {
  return {
    accessTokenFor: vi.fn<ChannelTokenProvider['accessTokenFor']>(async () => token),
    invalidate: vi.fn<ChannelTokenProvider['invalidate']>(async () => {}),
  };
}

function setup(over: { helix?: ReturnType<typeof fakeHelix>; tokens?: ReturnType<typeof fakeTokens>; index?: number } = {}) {
  const helix = over.helix ?? fakeHelix();
  const tokens = over.tokens ?? fakeTokens();
  const handlers: { onSession?: (id: string) => Promise<void>; onMessage?: (m: EventSubMessage) => void } = {};
  const socket = { start: vi.fn(async () => { await handlers.onSession!('sess-1'); }), close: vi.fn(async () => {}) };
  const log = { error: vi.fn() };
  const clock = { now: AT };
  const adapter = twitchAdapter({
    helix, tokens, botUserId: BOT, workers: 2, index: over.index ?? 0, sleep: async () => {}, now: () => clock.now, log,
    socket: (h) => {
      handlers.onSession = h.onSession;
      handlers.onMessage = h.onMessage;
      return socket;
    },
  });
  const signals: Signal[] = [];
  adapter.onSignal((s) => signals.push(s));
  return { adapter, helix, tokens, socket, handlers, signals, log, clock };
}

describe('twitchAdapter', () => {
  it('start binds the shard after the session and subscribes only owned channels', async () => {
    const s = setup();
    await s.adapter.start([FULL, STATE, FOREIGN]);
    await s.adapter.settled();
    expect(s.socket.start).toHaveBeenCalledOnce();
    expect(s.helix.listConduits).toHaveBeenCalledOnce();
    expect(s.helix.bindShard).toHaveBeenCalledWith('cid', 0, 'sess-1');
    const subs = () => s.helix.subscribe.mock.calls.map((c) => `${c[0]}:${c[2].broadcaster_user_id}`).sort();
    expect(subs()).toEqual([
      'stream.online:1001', 'stream.offline:1001', 'channel.chat.message:1001', 'channel.follow:1001', 'stream.online:1002', 'stream.offline:1002',
    ].sort());
    s.helix.subscribe.mockClear();
    await s.adapter.start([FULL, { ...STATE, watch: 'full' }]);
    await s.adapter.settled();
    expect(s.socket.start).toHaveBeenCalledOnce();
    expect(subs()).toEqual(['stream.online:1002', 'stream.offline:1002', 'channel.chat.message:1002', 'channel.follow:1002'].sort());
    await s.handlers.onSession!('sess-2');
    expect(s.helix.bindShard).toHaveBeenLastCalledWith('cid', 0, 'sess-2');
    expect(s.helix.listConduits).toHaveBeenCalledOnce();
    await s.adapter.close();
    expect(s.socket.close).toHaveBeenCalledOnce();
  });

  it('with the real EventSubSocket the conduit exists before the socket, the shard is bound after the welcome and subscriptions follow', async () => {
    const helix = fakeHelix();
    const sockets: FakeSocket[] = [];
    const log = { error: vi.fn() };
    const adapter = twitchAdapter({
      helix, tokens: fakeTokens(), botUserId: BOT, workers: 1, index: 0, sleep: async () => {}, now: () => AT, log,
      socket: (h) => new EventSubSocket({ ...h, log, sleep: async () => {}, connect: (url) => { const f = new FakeSocket(url); sockets.push(f); return f; } }),
    });
    const starting = adapter.start([FULL]);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(helix.listConduits).toHaveBeenCalledOnce();
    expect(helix.bindShard).not.toHaveBeenCalled();
    sockets[0]!.emit('message', { data: raw('eventsub-welcome') });
    await starting;
    await adapter.settled();
    expect(helix.bindShard).toHaveBeenCalledWith('cid', 0, 'AQoQILE98gtqShGmLD7AM6yJThAB');
    expect(helix.subscribe.mock.calls.map((c) => c[0])).toEqual(['stream.online', 'stream.offline', 'channel.chat.message', 'channel.follow']);
    expect(helix.listConduits).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
    await adapter.close();
  });

  it('subscriptions run in parallel groups and never block start', async () => {
    const s = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    s.helix.subscribe.mockImplementation(async () => { await gate; return 'created'; });
    const many = Array.from({ length: 25 }, (_, i) => ref(`${i.toString(16).padStart(8, '0')}-7777-4777-8777-777777777777`, `t${i}`));
    await s.adapter.start(many);
    expect(s.helix.subscribe.mock.calls.length).toBeGreaterThanOrEqual(20);
    expect(s.helix.subscribe.mock.calls.length).toBeLessThan(100);
    release();
    await s.adapter.settled();
    expect(s.helix.subscribe).toHaveBeenCalledTimes(100);
    expect(s.adapter.health().every((h) => h.ok)).toBe(true);
  });

  it('a rejected token lookup marks only that channel and the other channels are still polled', async () => {
    const tokens = fakeTokens();
    tokens.accessTokenFor.mockImplementation(async (pid) => { if (pid === P1) throw new Error('Pool erschöpft'); return 'user-token'; });
    const helix = fakeHelix();
    helix.getStreams.mockResolvedValue([{ userId: '1001', live: true, viewers: 1, startedAt: '' }, { userId: '1002', live: true, viewers: 1, startedAt: '' }]);
    const s = setup({ helix, tokens });
    await s.adapter.start([FULL, ref(P2, '1002')]);
    await s.adapter.pollPresence(AT);
    expect(s.helix.getChatters).toHaveBeenCalledTimes(1);
    expect(s.helix.getChatters).toHaveBeenCalledWith('1002', 'user-token');
    expect(s.adapter.health().find((h) => h.channel === P1)).toMatchObject({ ok: false, problem: 'twitch_error' });
    expect(s.adapter.health().find((h) => h.channel === P2)).toMatchObject({ ok: true });
    expect(s.log.error).toHaveBeenCalled();
  });

  it('pollPresence emits stream_state from getStreams and presence from getChatters for live full channels', async () => {
    const s = setup();
    await s.adapter.start([FULL, STATE, FOREIGN]);
    await s.adapter.pollPresence(AT);
    expect(s.helix.getStreams).toHaveBeenCalledWith(['1001', '1002']);
    expect(s.signals).toEqual([
      { kind: 'stream_state', channel: P1, at: AT.toISOString(), live: true, viewers: 50 },
      { kind: 'stream_state', channel: P2, at: AT.toISOString(), live: false },
      { kind: 'presence', channel: P1, minute: minuteOf(AT), users: [ALICE] },
    ]);
    expect(s.helix.getChatters).toHaveBeenCalledWith('1001', 'user-token');
    expect(s.adapter.health()).toEqual([
      { channel: P1, ok: true, lastSignalAt: AT.toISOString(), problem: null },
      { channel: P2, ok: true, lastSignalAt: AT.toISOString(), problem: null },
    ]);
  });

  it('pollPresence skips channels without a valid token and reports token_invalid in health', async () => {
    const s = setup({ tokens: fakeTokens(null) });
    await s.adapter.start([FULL]);
    await s.adapter.pollPresence(AT);
    expect(s.helix.getChatters).not.toHaveBeenCalled();
    expect(s.signals.filter((x) => x.kind === 'presence')).toEqual([]);
    expect(s.adapter.health()).toEqual([{ channel: P1, ok: false, lastSignalAt: AT.toISOString(), problem: 'token_invalid' }]);
  });

  it('a HelixError after backoff sets twitch_error in health, the next poll clears it on success', async () => {
    const s = setup();
    s.helix.getChatters.mockRejectedValueOnce(new HelixError('helix_error', 503, null));
    await s.adapter.start([FULL]);
    await s.adapter.pollPresence(AT);
    expect(s.adapter.health()[0]).toMatchObject({ ok: false, problem: 'twitch_error' });
    expect(s.log.error).toHaveBeenCalled();
    s.clock.now = new Date(AT.getTime() + 60_000);
    await s.adapter.pollPresence(s.clock.now);
    expect(s.adapter.health()[0]).toMatchObject({ ok: true, problem: null });
    s.helix.getStreams.mockRejectedValueOnce(new HelixError('helix_unreachable', null, null));
    await s.adapter.pollPresence(s.clock.now);
    expect(s.adapter.health()[0]).toMatchObject({ ok: false, problem: 'twitch_error' });
  });

  it('helix_unauthorized on getChatters invalidates the channel token', async () => {
    const s = setup();
    s.helix.getChatters.mockRejectedValueOnce(new HelixError('helix_unauthorized', 401, null));
    await s.adapter.start([FULL]);
    await s.adapter.pollPresence(AT);
    expect(s.tokens.invalidate).toHaveBeenCalledWith(P1);
    expect(s.adapter.health()[0]).toMatchObject({ ok: false, problem: 'token_invalid' });
  });

  it('a chat notification becomes a chat signal, an unknown broadcaster is dropped, a revocation marks the channel', async () => {
    const s = setup();
    await s.adapter.start([FULL]);
    s.handlers.onMessage!(parseMessage(raw('eventsub-chat')));
    s.handlers.onMessage!(parseMessage(raw('eventsub-online')));
    const foreign = parseMessage(raw('eventsub-chat')) as Extract<EventSubMessage, { type: 'notification' }>;
    foreign.event = { ...foreign.event, broadcaster_user_id: '4711' };
    s.handlers.onMessage!(foreign);
    expect(s.signals).toEqual([
      { kind: 'chat', channel: P1, at: AT.toISOString(), user: ALICE, text: 'Hallo zusammen!', messageId: 'cc106a89-1814-919d-454c-f4f2f970aae7' },
      { kind: 'stream_state', channel: P1, at: AT.toISOString(), live: true },
    ]);
    s.handlers.onMessage!(parseMessage(raw('eventsub-revocation')));
    expect(s.adapter.health()[0]).toMatchObject({ ok: false, problem: 'revoked' });
    await s.adapter.stop(FULL);
    expect(s.adapter.health()).toEqual([]);
    s.handlers.onMessage!(parseMessage(raw('eventsub-chat')));
    expect(s.signals).toHaveLength(2);
  });

  it('sendChat uses the bot as sender and checkFollows asks per user with the streamer token', async () => {
    const s = setup();
    await s.adapter.start([FULL]);
    expect(await s.adapter.sendChat(FULL, 'Gewinner: Alice')).toEqual({ ok: true, messageId: 'msg-1' });
    expect(s.helix.sendChatMessage).toHaveBeenCalledWith('1001', BOT, 'Gewinner: Alice');
    s.helix.sendChatMessage.mockRejectedValueOnce(new HelixError('helix_forbidden', 403, null));
    expect(await s.adapter.sendChat(FULL, 'x')).toEqual({ ok: false, reason: 'helix_forbidden', detail: 'Twitch Helix: helix_forbidden (403)' });
    s.helix.sendChatMessage.mockRejectedValueOnce(new Error('kaputt'));
    expect(await s.adapter.sendChat(FULL, 'x')).toEqual({ ok: false, reason: 'send_failed', detail: 'kaputt' });
    expect(await s.adapter.checkFollows(FULL, [ALICE.id, '42'])).toEqual([
      { userId: ALICE.id, follows: true, since: '2026-01-01T00:00:00.000Z' },
      { userId: '42', follows: false, since: null },
    ]);
    expect(s.helix.isFollower).toHaveBeenCalledWith('1001', '42', 'user-token');
    const noToken = setup({ tokens: fakeTokens(null) });
    await noToken.adapter.start([FULL]);
    expect(await noToken.adapter.checkFollows(FULL, ['1'])).toEqual([{ userId: '1', follows: false, since: null }]);
    expect(noToken.adapter.health()[0]).toMatchObject({ problem: 'token_invalid' });
  });
});
