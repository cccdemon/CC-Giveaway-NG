// Twitch-Anmeldung und Kanal verbinden (NEW_DESIGN.md 9.2). Zwei Flüsse: login ohne Scopes, connect mit den Kanal-Scopes.
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Runtime } from '../framework/runtime.js';
import { findPidByTwitchId } from '../identity/identities.js';
import type { AccountHandlers } from '../identity/runtime.js';
import { SESSION_COOKIE, SESSION_TTL_DAYS, createSession, deleteSession } from '../identity/sessions.js';
import { REQUIRED_CHANNEL_SCOPES, TwitchError, type TwitchAuthClient } from '../identity/twitch.js';
import { parseCookies, serializeCookie } from './cookies.js';
import { NO_SESSION, rejectionToHttp } from './http.js';
import { sessionOf } from './session.js';

export interface ApiDeps {
  rt: Runtime;
  accounts: AccountHandlers;
  twitch: TwitchAuthClient;
  /** Öffentliche Basis-URL ohne Schrägstrich am Ende. */
  publicUrl: string;
  secureCookies: boolean;
  now?: () => Date;
}

export const OAUTH_COOKIE = 'ccg_oauth';
const OAUTH_TTL_SEC = 10 * 60;
const SESSION_TTL_SEC = SESSION_TTL_DAYS * 86_400;

type Flow = 'login' | 'connect';

const OAUTH_STATE = { code: 'oauth_state', message: 'Die Anmeldung ist abgelaufen. Starte sie neu.' };

/** Nur relative Pfade innerhalb der Seite. Alles andere wird zu /. */
export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

function encodeOauth(state: string, flow: Flow, ret: string): string {
  return `${state}.${flow}.${Buffer.from(ret, 'utf8').toString('base64url')}`;
}

function decodeOauth(value: string | undefined): { state: string; flow: Flow; ret: string } | null {
  if (!value) return null;
  const [state, flow, retB64] = value.split('.');
  if (!state || (flow !== 'login' && flow !== 'connect') || retB64 === undefined) return null;
  return { state, flow, ret: safeReturnPath(Buffer.from(retB64, 'base64url').toString('utf8')) };
}

type CallbackQuery = { code?: string; state?: string; error?: string };

export function registerAuthRoutes(app: FastifyInstance, deps: ApiDeps, pool: pg.Pool): void {
  const now = deps.now ?? (() => new Date());
  const redirectUri = `${deps.publicUrl}/auth/twitch/callback`;
  const cookie = (name: string, value: string, maxAgeSec: number) => serializeCookie(name, value, { maxAgeSec, secure: deps.secureCookies });
  const clearOauth = cookie(OAUTH_COOKIE, '', 0);
  const sendError = (reply: FastifyReply, h: { status: number; body: unknown }) => reply.code(h.status).send(h.body);

  const start = (reply: FastifyReply, flow: Flow, ret: string) => {
    const state = randomBytes(24).toString('base64url');
    const scopes = flow === 'connect' ? REQUIRED_CHANNEL_SCOPES : [];
    reply.header('set-cookie', cookie(OAUTH_COOKIE, encodeOauth(state, flow, ret), OAUTH_TTL_SEC));
    return reply.redirect(deps.twitch.authorizeUrl({ redirectUri, scopes, state }), 302);
  };

  app.get('/auth/twitch/login', async (req: FastifyRequest<{ Querystring: { return?: string } }>, reply) =>
    start(reply, 'login', safeReturnPath(req.query.return)),
  );

  app.get('/auth/twitch/connect', async (req: FastifyRequest<{ Querystring: { return?: string } }>, reply) => {
    const session = await sessionOf(req, pool, now());
    if (!session) return sendError(reply, NO_SESSION);
    return start(reply, 'connect', safeReturnPath(req.query.return));
  });

  const signIn = async (req: FastifyRequest, user: { id: string; login: string; displayName: string }, at: Date) => {
    const execute = (pid: string) =>
      deps.rt.bus.execute(deps.accounts.signIn, { pid, soloTeamId: randomUUID(), user }, { actor: 'system:twitch', correlationId: randomUUID(), now: at, ip: req.ip });
    let pid = (await findPidByTwitchId(pool, user.id)) ?? randomUUID();
    let r = await execute(pid);
    if (!r.ok && r.rejection.code === 'pid_mismatch') {
      // Zwei erste Anmeldungen zugleich: Die Datenbank hat die andere pid gewonnen.
      pid = (await findPidByTwitchId(pool, user.id)) ?? pid;
      r = await execute(pid);
    }
    return { pid, r };
  };

  app.get('/auth/twitch/callback', async (req: FastifyRequest<{ Querystring: CallbackQuery }>, reply) => {
    reply.header('set-cookie', clearOauth);
    const oauth = decodeOauth(parseCookies(req.headers.cookie)[OAUTH_COOKIE]);
    if (!oauth || !req.query.state || req.query.state !== oauth.state) return reply.code(400).send(OAUTH_STATE);
    if (req.query.error || !req.query.code) {
      const e = new TwitchError('twitch_denied');
      return reply.code(400).send({ code: e.code, message: e.message });
    }
    const at = now();
    try {
      const token = await deps.twitch.exchangeCode(req.query.code, redirectUri);
      const user = await deps.twitch.getUser(token.accessToken);
      if (oauth.flow === 'login') {
        const { pid, r } = await signIn(req, user, at);
        if (!r.ok) return sendError(reply, rejectionToHttp(r.rejection));
        const sid = await createSession(pool, pid, at);
        reply.header('set-cookie', [clearOauth, cookie(SESSION_COOKIE, sid, SESSION_TTL_SEC)]);
        return reply.redirect(oauth.ret, 302);
      }
      const session = await sessionOf(req, pool, at);
      if (!session) return sendError(reply, NO_SESSION);
      const r = await deps.rt.bus.execute(
        deps.accounts.connectChannel,
        { pid: session.pid, twitchId: user.id, token: { accessToken: token.accessToken, refreshToken: token.refreshToken, expiresIn: token.expiresIn, scopes: token.scopes } },
        { actor: `user:${session.pid}`, correlationId: randomUUID(), now: at, ip: req.ip },
      );
      if (!r.ok) return sendError(reply, rejectionToHttp(r.rejection));
      return reply.redirect(oauth.ret, 302);
    } catch (e) {
      if (e instanceof TwitchError) return reply.code(e.code === 'twitch_unreachable' ? 502 : 400).send({ code: e.code, message: e.message });
      throw e;
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (id) await deleteSession(pool, id);
    reply.header('set-cookie', cookie(SESSION_COOKIE, '', 0));
    return reply.code(204).send();
  });
}
