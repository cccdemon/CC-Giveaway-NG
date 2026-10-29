// Sitzung aus dem Cookie lesen. Jede Route unter /me und /auth/twitch/connect verlangt eine.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../db/pool.js';
import { SESSION_COOKIE, findSession } from '../identity/sessions.js';
import { parseCookies } from './cookies.js';
import { NO_SESSION } from './http.js';

export interface Session {
  pid: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
}

export async function sessionOf(req: FastifyRequest, db: Queryable, now: Date): Promise<Session | null> {
  const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!id) return null;
  const found = await findSession(db, id, now);
  return found ? { pid: found.pid, sessionId: id } : null;
}

/** preHandler: lädt die Sitzung nach req.session oder antwortet 401. */
export function requireSession(db: Queryable, now: () => Date) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    req.session = await sessionOf(req, db, now());
    if (!req.session) await reply.code(NO_SESSION.status).send(NO_SESSION.body);
  };
}
