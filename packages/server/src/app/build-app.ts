import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import { registerAuthRoutes, type ApiDeps } from '../api/auth.js';
import { registerMeRoutes } from '../api/me.js';

export type { ApiDeps } from '../api/auth.js';

export interface AppDeps {
  pool: pg.Pool;
  /** Ohne api gibt es nur /healthz (Tests des Fundaments). */
  api?: ApiDeps;
}

export function buildApp(deps: AppDeps, opts: { logger?: FastifyServerOptions['logger'] } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  app.decorateRequest('session', null);
  app.addHook('onClose', async () => {
    await deps.pool.end();
  });
  app.get('/healthz', async (_req, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'error', reason: 'Die Datenbank antwortet nicht.' });
    }
  });
  if (deps.api) {
    registerAuthRoutes(app, deps.api, deps.pool);
    registerMeRoutes(app, deps.api, deps.pool);
  }
  return app;
}
