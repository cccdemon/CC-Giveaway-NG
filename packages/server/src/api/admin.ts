// Verwaltung (NEW_DESIGN.md 11.4): nur Superadmins. Betrieb, Streamer-Suche, Sperren, Verwarnungen, Fassungen, Rückmeldungen.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { logRead } from '../audit/access-log.js';
import { NOT_ADMIN } from '../platform/admin.js';
import { listFeedback, opsView, searchStreamers, setFeedbackDone } from '../platform/ops.js';
import { PLATFORM_STREAM } from '../platform/state.js';
import type { ApiDeps } from './auth.js';
import { bodyOf, executeAs } from './commands.js';
import { rejectionToHttp } from './http.js';
import { requireSession } from './session.js';

type PidParams = { Params: { pid: string } };
type EventParams = { Params: { eventId: string } };
type IdParams = { Params: { id: string } };

export function registerAdminRoutes(app: FastifyInstance, deps: ApiDeps, pool: pg.Pool): void {
  const now = deps.now ?? (() => new Date());
  const session = requireSession(pool, now);
  /** Sitzung und Admin-Recht. Kein Eintrag im Zugriffslog für Abgewiesene: der Bus drosselt Ablehnungen, Lesen gab es keins. */
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await session(req, reply);
    if (reply.sent) return;
    if (!(await deps.admins.isAdmin(pool, req.session!.pid))) {
      const h = rejectionToHttp(NOT_ADMIN());
      await reply.code(h.status).send(h.body);
    }
  };
  const guard = { preHandler: requireAdmin };
  const read = (req: FastifyRequest, action: string, target: string) => logRead(pool, { actor: `user:${req.session!.pid}`, action, target, ip: req.ip, at: now() });
  const h = deps.platform;

  app.get('/admin/ops', guard, async (req) => {
    await read(req, 'admin_view_ops', PLATFORM_STREAM);
    return opsView(pool, now());
  });

  app.get<{ Querystring: { q?: string } }>('/admin/streamers', guard, async (req) => {
    await read(req, 'admin_search', PLATFORM_STREAM);
    return searchStreamers(pool, req.query.q ?? '');
  });

  app.post('/admin/bans', guard, async (req, reply) => {
    const b = bodyOf<{ pid: string; reason: string }>(req);
    await executeAs(deps, req, reply, h.ban, { pid: String(b.pid ?? ''), reason: String(b.reason ?? '') });
  });
  app.post<PidParams>('/admin/bans/:pid/lift', guard, async (req, reply) => {
    await executeAs(deps, req, reply, h.unban, { pid: req.params.pid, reason: String(bodyOf<{ reason: string }>(req).reason ?? '') });
  });
  app.post('/admin/warnings', guard, async (req, reply) => {
    const b = bodyOf<{ pid: string; reason: string }>(req);
    await executeAs(deps, req, reply, h.warn, { pid: String(b.pid ?? ''), reason: String(b.reason ?? '') });
  });
  app.post<EventParams>('/admin/warnings/:eventId/withdraw', guard, async (req, reply) => {
    const b = bodyOf<{ pid: string; reason: string }>(req);
    await executeAs(deps, req, reply, h.withdrawWarning, { pid: String(b.pid ?? ''), warningEventId: req.params.eventId, reason: String(b.reason ?? '') });
  });
  app.post('/admin/terms', guard, async (req, reply) => {
    await executeAs(deps, req, reply, h.publishTerms, { text: String(bodyOf<{ text: string }>(req).text ?? '') });
  });
  app.post('/admin/revert', guard, async (req, reply) => {
    const b = bodyOf<{ eventId: string; reason: string }>(req);
    await executeAs(deps, req, reply, h.revert, { stream: PLATFORM_STREAM, eventId: String(b.eventId ?? ''), reason: String(b.reason ?? '') });
  });

  app.get<{ Querystring: { done?: string } }>('/admin/feedback', guard, async (req) => {
    // Namen der Absender sind personenbezogen (5.5).
    await read(req, 'admin_view_feedback', 'feedback');
    const done = req.query.done === 'true' ? true : req.query.done === 'false' ? false : undefined;
    return listFeedback(pool, done === undefined ? {} : { done });
  });
  app.put<IdParams>('/admin/feedback/:id', guard, async (req, reply) => {
    const id = Number(req.params.id);
    const done = bodyOf<{ done: boolean }>(req).done === true;
    if (!Number.isInteger(id) || !(await setFeedbackDone(pool, id, done))) {
      const e = rejectionToHttp({ rejected: true, code: 'feedback_not_found', message: 'Diese Rückmeldung gibt es nicht.' });
      return reply.code(e.status).send(e.body);
    }
    return reply.code(204).send();
  });
}
