import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

export function buildApp(deps: { pool: pg.Pool }, opts: { logger?: boolean | object } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
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
