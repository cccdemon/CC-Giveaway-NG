import { describe, expect, it } from 'vitest';
import { REQUIRED_CHANNEL_SCOPES, TwitchError, twitchAuthClient } from '../src/identity/twitch.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function stub(responder: (call: Call) => Response | Error) {
  const calls: Call[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : null };
    calls.push(call);
    const r = responder(call);
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, fetch: fetchStub };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const TOKEN_BODY = { access_token: 'acc', refresh_token: 'ref', expires_in: 14000, scope: ['channel:bot'], token_type: 'bearer' };

function client(responder: (call: Call) => Response | Error) {
  const s = stub(responder);
  return { ...s, client: twitchAuthClient({ clientId: 'cid', clientSecret: 'csecret', fetch: s.fetch }) };
}

describe('twitchAuthClient', () => {
  it('authorizeUrl carries client id, redirect, scopes, state and force_verify', () => {
    const { client: c } = client(() => json(200, {}));
    const url = new URL(c.authorizeUrl({ redirectUri: 'https://g.example/auth/twitch/callback', scopes: REQUIRED_CHANNEL_SCOPES, state: 'st-1' }));
    expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'https://g.example/auth/twitch/callback',
      scope: 'moderator:read:followers moderator:read:chatters channel:bot',
      state: 'st-1',
      force_verify: 'true',
    });
  });

  it('exchangeCode posts the form body and maps the token set', async () => {
    const { client: c, calls } = client(() => json(200, TOKEN_BODY));
    const t = await c.exchangeCode('the-code', 'https://g.example/cb');
    expect(t).toEqual({ accessToken: 'acc', refreshToken: 'ref', expiresIn: 14000, scopes: ['channel:bot'] });
    expect(calls[0]!.url).toBe('https://id.twitch.tv/oauth2/token');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body!))).toEqual({
      client_id: 'cid', client_secret: 'csecret', code: 'the-code', grant_type: 'authorization_code', redirect_uri: 'https://g.example/cb',
    });
  });

  it('refresh posts grant_type=refresh_token', async () => {
    const { client: c, calls } = client(() => json(200, { ...TOKEN_BODY, scope: undefined }));
    const t = await c.refresh('old-ref');
    expect(t.scopes).toEqual([]);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body!))).toEqual({
      client_id: 'cid', client_secret: 'csecret', grant_type: 'refresh_token', refresh_token: 'old-ref',
    });
  });

  it('getUser sends Bearer and Client-Id and maps display_name', async () => {
    const { client: c, calls } = client(() => json(200, { data: [{ id: '12345', login: 'alice', display_name: 'Alice' }] }));
    expect(await c.getUser('acc')).toEqual({ id: '12345', login: 'alice', displayName: 'Alice' });
    expect(calls[0]!.url).toBe('https://api.twitch.tv/helix/users');
    expect(calls[0]!.headers['authorization']).toBe('Bearer acc');
    expect(calls[0]!.headers['client-id']).toBe('cid');
  });

  it('maps 401 to twitch_denied, 500 to twitch_invalid, network error to twitch_unreachable, empty data to twitch_invalid', async () => {
    const codeOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'ok';
      } catch (e) {
        return e instanceof TwitchError ? e.code : `other:${String(e)}`;
      }
    };
    expect(await codeOf(client(() => json(401, { message: 'invalid' })).client.exchangeCode('c', 'r'))).toBe('twitch_denied');
    expect(await codeOf(client(() => json(500, {})).client.exchangeCode('c', 'r'))).toBe('twitch_invalid');
    expect(await codeOf(client(() => new TypeError('fetch failed')).client.getUser('a'))).toBe('twitch_unreachable');
    expect(await codeOf(client(() => json(200, { data: [] })).client.getUser('a'))).toBe('twitch_invalid');
    expect(await codeOf(client(() => json(200, { access_token: 'x' })).client.refresh('r'))).toBe('twitch_invalid');
    expect(await codeOf(client(() => new Response('<html>', { status: 200 })).client.refresh('r'))).toBe('twitch_invalid');
  });

  it('error messages are German and name the next step', async () => {
    await expect(client(() => json(403, {})).client.exchangeCode('c', 'r')).rejects.toThrow('Twitch hat die Anmeldung abgelehnt. Starte die Anmeldung neu.');
    await expect(client(() => new Error('down')).client.getUser('a')).rejects.toThrow('Twitch antwortet nicht. Versuche es gleich noch einmal.');
  });

  it('respects custom base urls', async () => {
    const s = stub(() => json(200, { data: [{ id: '1', login: 'a', display_name: 'A' }] }));
    const c = twitchAuthClient({ clientId: 'cid', clientSecret: 's', fetch: s.fetch, idBase: 'http://127.0.0.1:1/id', helixBase: 'http://127.0.0.1:1/helix' });
    await c.getUser('a');
    expect(s.calls[0]!.url).toBe('http://127.0.0.1:1/helix/users');
    expect(c.authorizeUrl({ redirectUri: 'r', scopes: [], state: 's' })).toMatch(/^http:\/\/127\.0\.0\.1:1\/id\/oauth2\/authorize\?/);
  });
});
