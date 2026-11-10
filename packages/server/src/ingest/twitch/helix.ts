// Helix-Client des Ingest (NEW_DESIGN.md 10.2, 12.1): Get Streams, Get Chatters, Followers, Send Chat Message, Conduits,
// EventSub-Abonnements. Jeder Aufruf mit Backoff, 429 wartet Ratelimit-Reset, 401 mit App-Token holt ein neues.
import { HELIX_BASE, ID_BASE } from '../../identity/twitch.js';
import { withBackoff } from '../backoff.js';
import type { FollowResult, SendResult, SignalUser } from '../signals.js';

export type HelixErrorCode = 'helix_unauthorized' | 'helix_forbidden' | 'helix_ratelimited' | 'helix_unreachable' | 'helix_error';

export class HelixError extends Error {
  constructor(readonly code: HelixErrorCode, readonly status: number | null, readonly retryAfterMs: number | null) {
    super(`Twitch Helix: ${code}${status === null ? '' : ` (${status})`}`);
    this.name = 'HelixError';
  }
}

export function retryable(e: unknown): boolean {
  if (!(e instanceof HelixError)) return false;
  return e.code === 'helix_ratelimited' || e.code === 'helix_unreachable' || (e.status !== null && e.status >= 500);
}

export interface AppTokenSource {
  get(): Promise<string>;
  invalidate(): void;
}

const APP_TOKEN_MARGIN_MS = 60_000;
/** Kein Aufruf darf den Takt des Workers minutenlang blockieren. */
export const HELIX_TIMEOUT_MS = 10_000;

/** App-Access-Token über Client Credentials, gecacht bis kurz vor Ablauf. */
export function appTokenSource(o: { clientId: string; clientSecret: string; fetch?: typeof fetch; idBase?: string; now?: () => Date }): AppTokenSource {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? (() => new Date());
  let cached: { token: string; until: number } | null = null;
  let pending: Promise<string> | null = null;
  const fetchToken = async (): Promise<string> => {
    const body = new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, grant_type: 'client_credentials' });
    let res: Response;
    try {
      res = await doFetch(`${o.idBase ?? ID_BASE}/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(HELIX_TIMEOUT_MS),
      });
    } catch {
      throw new HelixError('helix_unreachable', null, null);
    }
    if (!res.ok) throw new HelixError(res.status === 401 || res.status === 403 ? 'helix_unauthorized' : 'helix_error', res.status, null);
    const b = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof b.access_token !== 'string' || typeof b.expires_in !== 'number') throw new HelixError('helix_error', res.status, null);
    cached = { token: b.access_token, until: now().getTime() + b.expires_in * 1000 - APP_TOKEN_MARGIN_MS };
    return b.access_token;
  };
  return {
    async get() {
      if (cached && cached.until > now().getTime()) return cached.token;
      pending ??= fetchToken().finally(() => {
        pending = null;
      });
      return pending;
    },
    invalidate() {
      cached = null;
    },
  };
}

export interface StreamInfo {
  userId: string;
  live: true;
  viewers: number;
  startedAt: string;
}

export interface Conduit {
  id: string;
  shardCount: number;
}

export interface HelixUser {
  id: string;
  login: string;
  displayName: string;
  createdAt: string;
}

export interface HelixClient {
  getStreams(userIds: string[]): Promise<StreamInfo[]>;
  /** Get Users in Blöcken zu 100, für das Kontoalter (NEW_DESIGN.md 6.5). */
  getUsers(ids: string[]): Promise<HelixUser[]>;
  /** Get Users nach Login in Blöcken zu 100, für die Übernahme (NEW_DESIGN.md 15.6). Unbekannte Logins fehlen. */
  getUsersByLogin(logins: string[]): Promise<HelixUser[]>;
  getChatters(broadcasterId: string, userToken: string): Promise<SignalUser[]>;
  isFollower(broadcasterId: string, userId: string, userToken: string): Promise<FollowResult>;
  sendChatMessage(broadcasterId: string, senderId: string, text: string): Promise<SendResult>;
  listConduits(): Promise<Conduit[]>;
  createConduit(shardCount: number): Promise<Conduit>;
  updateConduit(id: string, shardCount: number): Promise<void>;
  bindShard(conduitId: string, shardId: number, sessionId: string): Promise<void>;
  subscribe(type: string, version: string, condition: Record<string, string>, conduitId: string): Promise<'created' | 'exists'>;
}

export interface HelixOptions {
  clientId: string;
  appToken: AppTokenSource;
  fetch?: typeof fetch;
  helixBase?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

interface Request {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  query?: [string, string][];
  body?: unknown;
  /** Nutzer-Token des Streamers. Ohne: App-Token. */
  userToken?: string;
}

const IDS_PER_CALL = 100;
const CHATTERS_PAGE = 1000;

export function helixClient(o: HelixOptions): HelixClient {
  const doFetch = o.fetch ?? fetch;
  const base = o.helixBase ?? HELIX_BASE;
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function once(r: Request, token: string): Promise<{ status: number; body: unknown }> {
    const url = new URL(`${base}${r.path}`);
    for (const [k, v] of r.query ?? []) url.searchParams.append(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'client-id': o.clientId };
    if (r.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await doFetch(url, { method: r.method, headers, signal: AbortSignal.timeout(HELIX_TIMEOUT_MS), ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }) });
    } catch {
      throw new HelixError('helix_unreachable', null, null);
    }
    if (res.status === 401) throw new HelixError('helix_unauthorized', 401, null);
    if (res.status === 403) throw new HelixError('helix_forbidden', 403, null);
    if (res.status === 429) {
      const reset = Number(res.headers.get('ratelimit-reset'));
      const wait = Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now().getTime()) : null;
      throw new HelixError('helix_ratelimited', 429, wait);
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!res.ok && res.status !== 409) throw new HelixError('helix_error', res.status, null);
    return { status: res.status, body };
  }

  /** Mit Backoff. Ein 401 mit App-Token holt einmal ein neues Token. */
  async function call(r: Request): Promise<{ status: number; body: unknown }> {
    return withBackoff(
      async () => {
        if (r.userToken !== undefined) return once(r, r.userToken);
        try {
          return await once(r, await o.appToken.get());
        } catch (e) {
          if (!(e instanceof HelixError) || e.code !== 'helix_unauthorized') throw e;
          o.appToken.invalidate();
          return once(r, await o.appToken.get());
        }
      },
      { sleep, retryOn: retryable, delayMs: (e) => (e instanceof HelixError && e.retryAfterMs !== null ? e.retryAfterMs : undefined) },
    );
  }

  const data = (body: unknown): Record<string, unknown>[] => {
    const d = (body as { data?: unknown } | null)?.data;
    return Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
  };

  /** Get Users in Blöcken zu 100, nach id oder login. */
  async function users(param: 'id' | 'login', values: string[]): Promise<HelixUser[]> {
    const out: HelixUser[] = [];
    for (let i = 0; i < values.length; i += IDS_PER_CALL) {
      const chunk = values.slice(i, i + IDS_PER_CALL);
      const r = await call({ method: 'GET', path: '/users', query: chunk.map((v): [string, string] => [param, v]) });
      for (const u of data(r.body)) {
        if (typeof u.id === 'string') {
          out.push({ id: u.id, login: String(u.login ?? ''), displayName: String(u.display_name ?? ''), createdAt: String(u.created_at ?? '') });
        }
      }
    }
    return out;
  }

  return {
    async getStreams(userIds) {
      const out: StreamInfo[] = [];
      for (let i = 0; i < userIds.length; i += IDS_PER_CALL) {
        const chunk = userIds.slice(i, i + IDS_PER_CALL);
        const r = await call({ method: 'GET', path: '/streams', query: [['first', '100'], ...chunk.map((id): [string, string] => ['user_id', id])] });
        for (const s of data(r.body)) {
          if (s.type === 'live' && typeof s.user_id === 'string') {
            out.push({ userId: s.user_id, live: true, viewers: typeof s.viewer_count === 'number' ? s.viewer_count : 0, startedAt: String(s.started_at ?? '') });
          }
        }
      }
      return out;
    },

    getUsers: (ids) => users('id', ids),
    getUsersByLogin: (logins) => users('login', logins),

    async getChatters(broadcasterId, userToken) {
      const users: SignalUser[] = [];
      let after: string | null = null;
      for (;;) {
        const query: [string, string][] = [['broadcaster_id', broadcasterId], ['moderator_id', broadcasterId], ['first', String(CHATTERS_PAGE)]];
        if (after) query.push(['after', after]);
        const r = await call({ method: 'GET', path: '/chat/chatters', query, userToken });
        for (const u of data(r.body)) {
          if (typeof u.user_id === 'string') users.push({ id: u.user_id, login: String(u.user_login ?? ''), displayName: String(u.user_name ?? '') });
        }
        const cursor = (r.body as { pagination?: { cursor?: unknown } } | null)?.pagination?.cursor;
        if (typeof cursor !== 'string' || !cursor || data(r.body).length === 0) return users;
        after = cursor;
      }
    },

    async isFollower(broadcasterId, userId, userToken) {
      const r = await call({ method: 'GET', path: '/channels/followers', query: [['broadcaster_id', broadcasterId], ['user_id', userId]], userToken });
      const first = data(r.body)[0];
      const since = typeof first?.followed_at === 'string' ? first.followed_at : null;
      return { userId, follows: since !== null, since };
    },

    async sendChatMessage(broadcasterId, senderId, text) {
      const r = await call({ method: 'POST', path: '/chat/messages', body: { broadcaster_id: broadcasterId, sender_id: senderId, message: text } });
      const first = data(r.body)[0];
      if (first?.is_sent === true && typeof first.message_id === 'string') return { ok: true, messageId: first.message_id };
      const drop = (first?.drop_reason ?? {}) as { code?: unknown; message?: unknown };
      const detail = [drop.code, drop.message].filter((x): x is string => typeof x === 'string').join(': ');
      return { ok: false, reason: 'dropped', ...(detail === '' ? {} : { detail }) };
    },

    async listConduits() {
      const r = await call({ method: 'GET', path: '/eventsub/conduits' });
      return data(r.body).map((c) => ({ id: String(c.id), shardCount: Number(c.shard_count) }));
    },

    async createConduit(shardCount) {
      const r = await call({ method: 'POST', path: '/eventsub/conduits', body: { shard_count: shardCount } });
      const c = data(r.body)[0];
      if (!c) throw new HelixError('helix_error', r.status, null);
      return { id: String(c.id), shardCount: Number(c.shard_count) };
    },

    async updateConduit(id, shardCount) {
      await call({ method: 'PATCH', path: '/eventsub/conduits', body: { id, shard_count: shardCount } });
    },

    async bindShard(conduitId, shardId, sessionId) {
      const r = await call({
        method: 'PATCH', path: '/eventsub/conduits/shards',
        body: { conduit_id: conduitId, shards: [{ id: String(shardId), transport: { method: 'websocket', session_id: sessionId } }] },
      });
      // Twitch antwortet 202 auch bei Fehlern je Shard und listet sie unter errors.
      const errors = (r.body as { errors?: unknown } | null)?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const text = errors.map((e) => String((e as { message?: unknown })?.message ?? JSON.stringify(e))).join('; ');
        const err = new HelixError('helix_error', r.status, null);
        err.message = `Twitch Helix: Shard ${shardId} ließ sich nicht binden: ${text}`;
        throw err;
      }
    },

    async subscribe(type, version, condition, conduitId) {
      const r = await call({ method: 'POST', path: '/eventsub/subscriptions', body: { type, version, condition, transport: { method: 'conduit', conduit_id: conduitId } } });
      return r.status === 409 ? 'exists' : 'created';
    },
  };
}
