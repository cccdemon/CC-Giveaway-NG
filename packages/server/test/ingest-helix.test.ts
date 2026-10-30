import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HelixError, appTokenSource, helixClient, retryable, type AppTokenSource } from '../src/ingest/twitch/helix.js';
import { AT } from './helpers/db.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/twitch/${name}.json`, import.meta.url), 'utf8'));
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function stub(responder: (call: Call, n: number) => Response | Error) {
  const calls: Call[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : null };
    calls.push(call);
    const r = responder(call, calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, fetch: fetchStub };
}

const fixedApp = (token = 'app-1') => ({ get: async () => token, invalidate: vi.fn<() => void>(() => {}) });

function client(responder: (call: Call, n: number) => Response | Error, appToken: AppTokenSource = fixedApp()) {
  const s = stub(responder);
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
  const now = () => AT;
  return { ...s, sleep, helix: helixClient({ clientId: 'cid', appToken, fetch: s.fetch, sleep, now }) };
}

describe('appTokenSource', () => {
  it('fetches once and caches until shortly before expiry', async () => {
    const s = stub(() => json(200, { access_token: 'app-1', expires_in: 3600, token_type: 'bearer' }));
    const clock = { now: AT };
    const src = appTokenSource({ clientId: 'cid', clientSecret: 'sec', fetch: s.fetch, now: () => clock.now });
    expect(await src.get()).toBe('app-1');
    expect(await src.get()).toBe('app-1');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ url: 'https://id.twitch.tv/oauth2/token', method: 'POST', body: 'client_id=cid&client_secret=sec&grant_type=client_credentials' });
    clock.now = new Date(AT.getTime() + 3541_000);
    await src.get();
    expect(s.calls).toHaveLength(2);
    src.invalidate();
    await src.get();
    expect(s.calls).toHaveLength(3);
  });
});

describe('helixClient', () => {
  it('getChatters follows the pagination cursor and maps the users', async () => {
    const { helix, calls } = client((c) => json(200, fixture(c.url.includes('after=') ? 'get-chatters-page2' : 'get-chatters')));
    const users = await helix.getChatters('1001', 'user-token');
    expect(users).toEqual([
      { id: '12345', login: 'alice', displayName: 'Alice' },
      { id: '67890', login: 'bob', displayName: 'Bob' },
      { id: '11111', login: 'carol', displayName: 'Carol' },
    ]);
    expect(calls).toHaveLength(2);
    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe('https://api.twitch.tv/helix/chat/chatters');
    expect(Object.fromEntries(u.searchParams)).toEqual({ broadcaster_id: '1001', moderator_id: '1001', first: '1000' });
    expect(calls[0]!.headers).toMatchObject({ authorization: 'Bearer user-token', 'client-id': 'cid' });
    expect(new URL(calls[1]!.url).searchParams.get('after')).toBe('eyJiIjpudWxsLCJhIjp7Ik9mZnNldCI6Mn19');
  });

  it('getStreams splits 150 ids into two requests and maps live streams', async () => {
    const { helix, calls } = client((c, n) => json(200, n === 1 ? fixture('get-streams') : { data: [], pagination: {} }));
    const ids = Array.from({ length: 150 }, (_, i) => String(1000 + i));
    const streams = await helix.getStreams(ids);
    expect(streams).toEqual([{ userId: '1001', live: true, viewers: 120, startedAt: '2026-10-15T11:30:00Z' }]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.getAll('user_id')).toHaveLength(100);
    expect(new URL(calls[1]!.url).searchParams.getAll('user_id')).toHaveLength(50);
    expect(calls[0]!.headers.authorization).toBe('Bearer app-1');
  });

  it('isFollower maps followed_at and an empty list', async () => {
    const { helix, calls } = client((c) => json(200, c.url.includes('user_id=12345') ? fixture('followers') : { total: 1, data: [], pagination: {} }));
    expect(await helix.isFollower('1001', '12345', 'user-token')).toEqual({ userId: '12345', follows: true, since: '2026-01-02T03:04:05Z' });
    expect(await helix.isFollower('1001', '99', 'user-token')).toEqual({ userId: '99', follows: false, since: null });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/helix/channels/followers');
    expect(Object.fromEntries(u.searchParams)).toEqual({ broadcaster_id: '1001', user_id: '12345' });
  });

  it('retries 5xx and network errors with backoff, gives up after 3 with HelixError', async () => {
    const { helix, sleep } = client((_c, n) => (n === 1 ? json(503, {}) : new TypeError('fetch failed')));
    await expect(helix.getStreams(['1'])).rejects.toBeInstanceOf(HelixError);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
    const { helix: h2, calls } = client((_c, n) => (n < 3 ? json(500, {}) : json(200, { data: [] })));
    expect(await h2.getStreams(['1'])).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it('does not retry 400 and 403', async () => {
    const { helix, calls } = client(() => json(403, { message: 'nope' }));
    await expect(helix.getStreams(['1'])).rejects.toMatchObject({ code: 'helix_forbidden', status: 403 });
    expect(calls).toHaveLength(1);
    expect(retryable(new HelixError('helix_forbidden', 403, null))).toBe(false);
    expect(retryable(new HelixError('helix_error', 400, null))).toBe(false);
    expect(retryable(new HelixError('helix_error', 502, null))).toBe(true);
    expect(retryable(new HelixError('helix_unreachable', null, null))).toBe(true);
  });

  it('401 with the app token invalidates it and retries once', async () => {
    const app = fixedApp();
    const { helix, calls, sleep } = client((_c, n) => (n === 1 ? json(401, {}) : json(200, { data: [] })), app);
    expect(await helix.getStreams(['1'])).toEqual([]);
    expect(app.invalidate).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
    expect(sleep).not.toHaveBeenCalled();
    const { helix: h2 } = client(() => json(401, {}), fixedApp());
    await expect(h2.getStreams(['1'])).rejects.toMatchObject({ code: 'helix_unauthorized' });
  });

  it('401 with a user token is not retried', async () => {
    const { helix, calls } = client(() => json(401, {}));
    await expect(helix.getChatters('1001', 'alt')).rejects.toMatchObject({ code: 'helix_unauthorized' });
    expect(calls).toHaveLength(1);
  });

  it('429 waits Ratelimit-Reset', async () => {
    const reset = String(Math.floor(AT.getTime() / 1000) + 3);
    const { helix, sleep } = client((_c, n) => (n === 1 ? json(429, {}, { 'ratelimit-reset': reset }) : json(200, { data: [] })));
    expect(await helix.getStreams(['1'])).toEqual([]);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([3000]);
  });

  it('sendChatMessage posts as the bot and maps is_sent false to the drop reason', async () => {
    const { helix, calls } = client((c) =>
      json(200, c.body?.includes('"message":"böse"') ? { data: [{ message_id: '', is_sent: false, drop_reason: { code: 'msg_rejected', message: 'Nachricht abgelehnt.' } }] } : fixture('send-chat')),
    );
    expect(await helix.sendChatMessage('1001', '999', 'Hallo')).toEqual({ ok: true, messageId: 'abc-123-def' });
    expect(calls[0]).toMatchObject({ url: 'https://api.twitch.tv/helix/chat/messages', method: 'POST', body: JSON.stringify({ broadcaster_id: '1001', sender_id: '999', message: 'Hallo' }) });
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(await helix.sendChatMessage('1001', '999', 'böse')).toEqual({ ok: false, reason: 'Nachricht abgelehnt.' });
  });

  it('conduits: list, create, update, bindShard', async () => {
    const { helix, calls } = client((c) => (c.method === 'PATCH' && c.url.endsWith('/shards') ? json(202, { data: [], errors: [] }) : json(200, fixture('conduits'))));
    expect(await helix.listConduits()).toEqual([{ id: 'bfcfc993-26b1-b876-44d9-afe75a379dac', shardCount: 2 }]);
    expect(await helix.createConduit(3)).toEqual({ id: 'bfcfc993-26b1-b876-44d9-afe75a379dac', shardCount: 2 });
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'https://api.twitch.tv/helix/eventsub/conduits', body: JSON.stringify({ shard_count: 3 }) });
    await helix.updateConduit('cid-1', 4);
    expect(calls[2]).toMatchObject({ method: 'PATCH', url: 'https://api.twitch.tv/helix/eventsub/conduits', body: JSON.stringify({ id: 'cid-1', shard_count: 4 }) });
    await helix.bindShard('cid-1', 1, 'sess-9');
    expect(calls[3]).toMatchObject({
      method: 'PATCH', url: 'https://api.twitch.tv/helix/eventsub/conduits/shards',
      body: JSON.stringify({ conduit_id: 'cid-1', shards: [{ id: '1', transport: { method: 'websocket', session_id: 'sess-9' } }] }),
    });
  });

  it('bindShard throws when Twitch answers 202 with an errors list', async () => {
    const { helix } = client(() => json(202, { data: [], errors: [{ id: '1', message: 'websocket session not found', code: 'websocket_session_not_found' }] }));
    await expect(helix.bindShard('cid-1', 1, 'sess-tot')).rejects.toMatchObject({ code: 'helix_error', message: expect.stringContaining('websocket session not found') });
  });

  it('every call carries an abort signal and an aborted fetch counts as unreachable', async () => {
    const { helix, calls, sleep } = client(() => new DOMException('The operation was aborted.', 'AbortError'));
    await expect(helix.getStreams(['1'])).rejects.toMatchObject({ code: 'helix_unreachable' });
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const seen: boolean[] = [];
    const s = stub(() => json(200, { data: [] }));
    const spying: typeof fetch = async (input, init) => {
      seen.push(init?.signal instanceof AbortSignal);
      return s.fetch(input, init);
    };
    const h2 = helixClient({ clientId: 'cid', appToken: fixedApp(), fetch: spying, sleep: async () => {} });
    await h2.getStreams(['1']);
    const src = appTokenSource({ clientId: 'cid', clientSecret: 'sec', fetch: async (input, init) => { seen.push(init?.signal instanceof AbortSignal); return json(200, { access_token: 'a', expires_in: 3600 }); } });
    await src.get();
    expect(seen).toEqual([true, true]);
  });

  it('subscribe treats 202 as created and 409 as exists', async () => {
    const { helix, calls } = client((_c, n) => (n === 1 ? json(202, fixture('subscriptions')) : json(409, { error: 'Conflict', status: 409, message: 'subscription already exists' })));
    expect(await helix.subscribe('channel.chat.message', '1', { broadcaster_user_id: '1001', user_id: '999' }, 'cid-1')).toBe('created');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: '1001', user_id: '999' }, transport: { method: 'conduit', conduit_id: 'cid-1' } });
    expect(await helix.subscribe('stream.online', '1', { broadcaster_user_id: '1001' }, 'cid-1')).toBe('exists');
  });
});
