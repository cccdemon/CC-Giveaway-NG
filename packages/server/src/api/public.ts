// Routen ohne Admin-Rechte rund um die Plattform: Fassung der Nutzungsbedingungen, Browser-Fehler, Rückmeldungen (NEW_DESIGN.md 9.2, 11.4, 12.4).
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { addFeedback, recordBrowserError } from '../platform/ops.js';
import { currentTerms } from '../platform/terms.js';
import { isRejection, reject } from '../shared/rejection.js';
import type { ApiDeps } from './auth.js';
import { bodyOf } from './commands.js';
import { rejectionToHttp } from './http.js';
import { requireSession } from './session.js';

/** Größte Fehlermeldung aus dem Browser. Mehr braucht kein Stacktrace. */
export const BROWSER_ERROR_BODY_LIMIT = 8192;

export function registerPublicRoutes(app: FastifyInstance, deps: ApiDeps, pool: pg.Pool): void {
  const now = deps.now ?? (() => new Date());
  const guard = { preHandler: requireSession(pool, now) };

  app.get('/terms', async () => currentTerms(pool));

  // Ohne Sitzung und ohne IP: die Meldung trägt keinen Personenbezug (12.4).
  app.post('/errors', { bodyLimit: BROWSER_ERROR_BODY_LIMIT }, async (req, reply) => {
    const b = bodyOf<{ message: unknown; stack: unknown; url: unknown }>(req);
    if (typeof b.message !== 'string' || b.message.trim() === '') {
      const h = rejectionToHttp(reject('invalid_error_report', 'Die Fehlermeldung braucht einen Text.'));
      return reply.code(h.status).send(h.body);
    }
    const userAgent = req.headers['user-agent'];
    await recordBrowserError(
      pool,
      {
        message: b.message,
        ...(typeof b.stack === 'string' ? { stack: b.stack } : {}),
        ...(typeof b.url === 'string' ? { url: b.url } : {}),
        ...(typeof userAgent === 'string' ? { userAgent } : {}),
      },
      now(),
    );
    return reply.code(202).send();
  });

  app.post('/feedback', guard, async (req, reply) => {
    const r = await addFeedback(pool, req.session!.pid, bodyOf<{ text: unknown }>(req).text, now());
    if (isRejection(r)) {
      const h = rejectionToHttp(r);
      return reply.code(h.status).send(h.body);
    }
    return reply.code(201).send(r);
  });
}
