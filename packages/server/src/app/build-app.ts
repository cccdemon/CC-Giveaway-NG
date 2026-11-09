import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import type { WebSocket } from 'ws';
import { registerAuthRoutes, type ApiDeps } from '../api/auth.js';
import { registerMeRoutes } from '../api/me.js';
import { registerGiveawayRoutes } from '../api/giveaways.js';
import { registerPortalRoutes } from '../api/portal.js';
import { registerTeamRoutes } from '../api/teams.js';
import { registerNoPush, registerWsRoutes } from '../api/ws.js';

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
    registerTeamRoutes(app, deps.api, deps.pool);
    registerGiveawayRoutes(app, deps.api, deps.pool);
    registerPortalRoutes(app, deps.api, deps.pool);
    app.decorate('wsSockets', new Set<WebSocket>());
    if (deps.api.subscriber) {
      const api = deps.api;
      // Das WebSocket-Plugin braucht einen eigenen Kontext: die Route darf erst nach dem Plugin entstehen.
      void app.register(async (inst) => {
        await inst.register(websocket);
        registerWsRoutes(inst, api, deps.pool);
      });
    } else {
      registerNoPush(app);
    }
  }
  return app;
}
