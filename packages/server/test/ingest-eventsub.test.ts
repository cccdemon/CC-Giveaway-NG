import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelRef } from '../src/ingest/signals.js';
import { EVENTSUB_URL, EventSubSocket, KEEPALIVE_GRACE_SEC, parseMessage, toSignal, type EventSubMessage } from '../src/ingest/twitch/eventsub.js';
import { AT } from './helpers/db.js';
import { FakeSocket } from './helpers/fake-socket.js';

const P1 = '77777777-7777-4777-8777-777777777777';
const BOT = '999';
const raw = (name: string): string => readFileSync(new URL(`./fixtures/twitch/${name}.json`, import.meta.url), 'utf8');
const notification = (name: string) => parseMessage(raw(name)) as Extract<EventSubMessage, { type: 'notification' }>;
const refs = new Map<string, ChannelRef>([['1001', { pid: P1, twitchId: '1001', watch: 'full', owned: true }]]);
const channelOf = (id: string) => refs.get(id);
const now = () => AT;

describe('parseMessage', () => {
  it('maps welcome, keepalive, reconnect, notification, revocation and garbage', () => {
    expect(parseMessage(raw('eventsub-welcome'))).toEqual({ type: 'session_welcome', sessionId: 'AQoQILE98gtqShGmLD7AM6yJThAB', keepaliveSec: 10 });
    expect(parseMessage(raw('eventsub-keepalive'))).toEqual({ type: 'session_keepalive' });
    expect(parseMessage(raw('eventsub-reconnect'))).toEqual({ type: 'session_reconnect', url: 'wss://eventsub.wss.twitch.tv/ws?challenge=beispiel&id=AQoQILE98gtqShGmLD7AM6yJThAB' });
    expect(parseMessage(raw('eventsub-chat'))).toMatchObject({ type: 'notification', subscriptionType: 'channel.chat.message', event: { chatter_user_id: '12345' } });
    expect(parseMessage(raw('eventsub-revocation'))).toEqual({ type: 'revocation', subscriptionType: 'channel.chat.message', status: 'authorization_revoked', broadcasterId: '1001' });
    expect(parseMessage('{nicht json')).toEqual({ type: 'unknown' });
    expect(parseMessage('{"metadata":{"message_type":"neu"},"payload":{}}')).toEqual({ type: 'unknown' });
  });
});

describe('toSignal', () => {
  it('maps chat, online, offline and follow fixtures to signals with the channel pid', () => {
    expect(toSignal(notification('eventsub-chat'), channelOf, BOT, now)).toEqual({
      kind: 'chat', channel: P1, at: AT.toISOString(), user: { id: '12345', login: 'alice', displayName: 'Alice' }, text: 'Hallo zusammen!', messageId: 'cc106a89-1814-919d-454c-f4f2f970aae7',
    });
    expect(toSignal(notification('eventsub-online'), channelOf, BOT, now)).toEqual({ kind: 'stream_state', channel: P1, at: AT.toISOString(), live: true });
    expect(toSignal(notification('eventsub-offline'), channelOf, BOT, now)).toEqual({ kind: 'stream_state', channel: P1, at: AT.toISOString(), live: false });
    expect(toSignal(notification('eventsub-follow'), channelOf, BOT, now)).toEqual({
      kind: 'follow', channel: P1, at: '2026-10-15T12:00:30.000Z', user: { id: '67890', login: 'bob', displayName: 'Bob' },
    });
  });

  it('drops an unknown broadcaster, the bots own messages and unknown types', () => {
    expect(toSignal(notification('eventsub-chat'), () => undefined, BOT, now)).toBeNull();
    const own = notification('eventsub-chat');
    own.event = { ...own.event, chatter_user_id: BOT };
    expect(toSignal(own, channelOf, BOT, now)).toBeNull();
    const other = notification('eventsub-chat');
    other.subscriptionType = 'channel.update';
    expect(toSignal(other, channelOf, BOT, now)).toBeNull();
  });
});

function harness() {
  const sockets: FakeSocket[] = [];
  const sessions: string[] = [];
  const messages: EventSubMessage[] = [];
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
  const log = { error: vi.fn() };
  const socket = new EventSubSocket({
    connect: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onSession: async (id) => void sessions.push(id),
    onMessage: (m) => void messages.push(m),
    log,
    sleep,
  });
  const welcome = (s: FakeSocket, id = 'sess-1') => {
    s.emit('open');
    s.emit('message', { data: raw('eventsub-welcome').replace('AQoQILE98gtqShGmLD7AM6yJThAB', id) });
  };
  return { socket, sockets, sessions, messages, sleep, log, welcome };
}

describe('EventSubSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start resolves after welcome and calls onSession with the session id, notifications reach onMessage', async () => {
    const h = harness();
    const started = h.socket.start();
    expect(h.sockets[0]!.url).toBe(EVENTSUB_URL);
    h.welcome(h.sockets[0]!);
    await started;
    expect(h.sessions).toEqual(['sess-1']);
    expect(h.socket.sessionId).toBe('sess-1');
    h.sockets[0]!.emit('message', { data: raw('eventsub-chat') });
    h.sockets[0]!.emit('message', { data: raw('eventsub-revocation') });
    expect(h.messages.map((m) => m.type)).toEqual(['notification', 'revocation']);
    await h.socket.close();
    expect(h.sockets[0]!.closed).toBe(true);
    h.sockets[0]!.emit('close', { code: 1000 });
    expect(h.sockets).toHaveLength(1);
  });

  it('reconnects when no keepalive arrives in time', async () => {
    const h = harness();
    const started = h.socket.start();
    h.welcome(h.sockets[0]!);
    await started;
    await vi.advanceTimersByTimeAsync((10 + KEEPALIVE_GRACE_SEC) * 1000 - 1);
    h.sockets[0]!.emit('message', { data: raw('eventsub-keepalive') });
    await vi.advanceTimersByTimeAsync((10 + KEEPALIVE_GRACE_SEC) * 1000 - 1);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.sockets[0]!.closed).toBe(true);
    h.sockets[0]!.emit('close', { code: 1006 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets).toHaveLength(2);
    h.welcome(h.sockets[1]!, 'sess-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sessions).toEqual(['sess-1', 'sess-2']);
    expect(h.log.error).toHaveBeenCalled();
  });

  it('session_reconnect opens the new url first, then closes the old socket', async () => {
    const h = harness();
    const started = h.socket.start();
    h.welcome(h.sockets[0]!);
    await started;
    h.sockets[0]!.emit('message', { data: raw('eventsub-reconnect') });
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]!.url).toBe('wss://eventsub.wss.twitch.tv/ws?challenge=beispiel&id=AQoQILE98gtqShGmLD7AM6yJThAB');
    expect(h.sockets[0]!.closed).toBe(false);
    h.welcome(h.sockets[1]!, 'sess-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.sessions).toEqual(['sess-1', 'sess-2']);
    h.sockets[0]!.emit('close', { code: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets).toHaveLength(2);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it('a close of the old socket before the new welcome does not open a third socket', async () => {
    const h = harness();
    const started = h.socket.start();
    h.welcome(h.sockets[0]!);
    await started;
    h.sockets[0]!.emit('message', { data: raw('eventsub-reconnect') });
    expect(h.sockets).toHaveLength(2);
    h.sockets[0]!.emit('close', { code: 4004 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets).toHaveLength(2);
    expect(h.sleep).not.toHaveBeenCalled();
    h.welcome(h.sockets[1]!, 'sess-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sessions).toEqual(['sess-1', 'sess-2']);
    // Eine späte Schließung einer alten, nicht mehr aktuellen Verbindung löst nichts aus.
    h.sockets[0]!.emit('close', { code: 1006 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets).toHaveLength(2);
  });

  it('an unexpected close reconnects with backoff', async () => {
    const h = harness();
    const started = h.socket.start();
    h.welcome(h.sockets[0]!);
    await started;
    for (let i = 0; i < 4; i++) {
      h.sockets[i]!.emit('close', { code: 1006, reason: 'weg' });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.sockets).toHaveLength(i + 2);
    }
    expect(h.sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000, 4000]);
    h.welcome(h.sockets[4]!, 'sess-5');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sessions).toEqual(['sess-1', 'sess-5']);
    h.sockets[4]!.emit('close', { code: 1006 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sleep.mock.calls.at(-1)![0]).toBe(1000);
  });
});
