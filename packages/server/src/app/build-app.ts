import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';

export function buildApp(deps: { pool: pg.Pool }, opts: { logger?: FastifyServerOptions['logger'] } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
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
  return app;
}
