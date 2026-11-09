import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import type { WebSocket } from 'ws';
import { registerAdminRoutes } from '../api/admin.js';
import { registerAuthRoutes, type ApiDeps } from '../api/auth.js';
import { registerMeRoutes } from '../api/me.js';
import { registerGiveawayRoutes } from '../api/giveaways.js';
import { registerPortalRoutes } from '../api/portal.js';
import { registerPublicRoutes } from '../api/public.js';
import { registerTeamRoutes } from '../api/teams.js';
import { WS_MAX_PAYLOAD, registerNoPush, registerWsRoutes } from '../api/ws.js';

export type { ApiDeps } from '../api/auth.js';

/** Präfix aller API-Routen. Nur /healthz liegt an der Wurzel. */
export const API_PREFIX = '/api';

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
    const api = deps.api;
    app.decorate('wsSockets', new Set<WebSocket>());
    // Alle Routen außer /healthz unter /api: so kollidieren Seiten der Web-App und API-Pfade nicht (Teilprojekt 8b).
    void app.register(
      async (inst) => {
        registerAuthRoutes(inst, api, deps.pool);
        registerMeRoutes(inst, api, deps.pool);
        registerTeamRoutes(inst, api, deps.pool);
        registerGiveawayRoutes(inst, api, deps.pool);
        registerPortalRoutes(inst, api, deps.pool);
        registerPublicRoutes(inst, api, deps.pool);
        registerAdminRoutes(inst, api, deps.pool);
        if (api.subscriber) {
          // Das WebSocket-Plugin braucht einen eigenen Kontext: die Route darf erst nach dem Plugin entstehen.
          await inst.register(async (ws) => {
            // Protokollnachrichten sind klein. Ohne Grenze nähme ws 100 MiB an.
            await ws.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD } });
            registerWsRoutes(ws, api, deps.pool);
          });
        } else {
          registerNoPush(inst);
        }
      },
      { prefix: API_PREFIX },
    );
  }
  return app;
}
