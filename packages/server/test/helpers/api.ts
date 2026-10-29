import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { vi } from 'vitest';
import { buildApp } from '../../src/app/build-app.js';
import { allowAll } from '../../src/framework/giveaway/authorize.js';
import { InMemoryPublisher } from '../../src/framework/publisher.js';
import { createRuntime, type Runtime } from '../../src/framework/runtime.js';
import type { TwitchUser } from '../../src/identity/identities.js';
import { attachAccounts, type AccountHandlers } from '../../src/identity/runtime.js';
import { REQUIRED_CHANNEL_SCOPES, TwitchError, type TwitchAuthClient } from '../../src/identity/twitch.js';
import { AT, freshDb } from './db.js';
import { fakeFetcher, fullLegalSource } from './giveaway.js';

export const ALICE: TwitchUser = { id: '12345', login: 'alice', displayName: 'Alice' };
export const BOB: TwitchUser = { id: '67890', login: 'bob', displayName: 'Bob' };
export const KEY = randomBytes(32);
export const PUBLIC_URL = 'https://g.example';

export interface TwitchStub {
  client: TwitchAuthClient;
  /** Wen Twitch beim nächsten Callback liefert. */
  user: TwitchUser;
  scopes: string[];
  exchanged: string[];
  fail: TwitchError | null;
}

export function stubTwitch(): TwitchStub {
  const s: TwitchStub = {
    user: ALICE,
    scopes: [...REQUIRED_CHANNEL_SCOPES],
    exchanged: [],
    fail: null,
    client: {
      authorizeUrl: (p) => `https://id.stub/authorize?${new URLSearchParams({ redirect_uri: p.redirectUri, scope: p.scopes.join(' '), state: p.state })}`,
      async exchangeCode(code) {
        if (s.fail) throw s.fail;
        s.exchanged.push(code);
        return { accessToken: `acc-${code}`, refreshToken: `ref-${code}`, expiresIn: 3600, scopes: s.scopes };
      },
      async refresh() {
        throw new Error('nicht im Test');
      },
      getUser: async () => s.user,
    },
  };
  return s;
}

export interface ApiSetup {
  pool: pg.Pool;
  app: FastifyInstance;
  rt: Runtime;
  accounts: AccountHandlers;
  twitch: TwitchStub;
  clock: { now: Date };
  close(): Promise<void>;
}

export async function setupApi(): Promise<ApiSetup> {
  const db = await freshDb();
  const rt = createRuntime({ pool: db.pool, publisher: new InMemoryPublisher(), auth: allowAll, log: { error: vi.fn() }, legalSource: fullLegalSource, fetcher: fakeFetcher });
  const accounts = attachAccounts(rt, { tokenKey: KEY });
  const twitch = stubTwitch();
  const clock = { now: AT };
  const app = buildApp({ pool: db.pool, api: { rt, accounts, twitch: twitch.client, publicUrl: PUBLIC_URL, secureCookies: true, now: () => clock.now } });
  return {
    pool: db.pool, app, rt, accounts, twitch, clock,
    close: async () => {
      await app.close(); // beendet auch den Pool
    },
  };
}

export function cookiesOf(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const out: Record<string, string> = {};
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair!.indexOf('=');
    out[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return out;
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Spielt login → callback durch und liefert das Sitzungs-Cookie plus den Rücksprung. */
export async function login(s: ApiSetup, user: TwitchUser = ALICE, ret = '/'): Promise<{ cookie: string; location: string }> {
  s.twitch.user = user;
  const start = await s.app.inject({ method: 'GET', url: `/auth/twitch/login?return=${encodeURIComponent(ret)}` });
  if (start.statusCode !== 302) throw new Error(`login: ${start.statusCode} ${start.body}`);
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const oauth = cookiesOf(start);
  const cb = await s.app.inject({
    method: 'GET',
    url: `/auth/twitch/callback?code=code-${user.login}&state=${state}`,
    headers: { cookie: cookieHeader({ ccg_oauth: oauth.ccg_oauth! }) },
  });
  if (cb.statusCode !== 302) throw new Error(`callback: ${cb.statusCode} ${cb.body}`);
  const session = cookiesOf(cb).ccg_session;
  if (!session) throw new Error('callback: kein Sitzungs-Cookie');
  return { cookie: cookieHeader({ ccg_session: session }), location: cb.headers.location as string };
}

/** Spielt connect → callback mit bestehender Sitzung durch. */
export async function connect(s: ApiSetup, cookie: string, user: TwitchUser = ALICE) {
  s.twitch.user = user;
  const start = await s.app.inject({ method: 'GET', url: '/auth/twitch/connect', headers: { cookie } });
  if (start.statusCode !== 302) return start;
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const oauth = cookiesOf(start);
  return s.app.inject({
    method: 'GET',
    url: `/auth/twitch/callback?code=connect-${user.login}&state=${state}`,
    headers: { cookie: `${cookie}; ccg_oauth=${oauth.ccg_oauth}` },
  });
}
