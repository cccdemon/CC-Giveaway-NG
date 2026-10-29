// Eigenes Konto: Stand, Nutzungsbedingungen, Rechtstexte, Kanal, Meine Daten (NEW_DESIGN.md 9.2, 11.3).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { logRead } from '../audit/access-log.js';
import type { CommandHandler } from '../framework/command-bus.js';
import { loadStreamState } from '../framework/state.js';
import { accountReducer, accountStream, type AccountState } from '../identity/account/state.js';
import { findIdentity } from '../identity/identities.js';
import { SESSION_COOKIE } from '../identity/sessions.js';
import { PLATFORM_TERMS_VERSION } from '../identity/terms.js';
import { readStream } from '../journal/journal.js';
import type { ApiDeps } from './auth.js';
import { serializeCookie } from './cookies.js';
import { NO_SESSION, rejectionToHttp } from './http.js';
import { requireSession } from './session.js';

interface ParticipantRow {
  giveaway_id: string;
  registered: boolean;
  in_pool: boolean;
  weight: number;
  winner_status: string | null;
}

export function registerMeRoutes(app: FastifyInstance, deps: ApiDeps, pool: pg.Pool): void {
  const now = deps.now ?? (() => new Date());
  const guard = { preHandler: requireSession(pool, now) };

  /** Führt einen Konto-Befehl als die angemeldete Person aus und antwortet 204 oder mit der Ablehnung. */
  const run = async <C, P>(req: FastifyRequest, reply: FastifyReply, h: CommandHandler<C, AccountState, P>, cmd: C, after?: () => void) => {
    const pid = req.session!.pid;
    const r = await deps.rt.bus.execute(h, cmd, { actor: `user:${pid}`, correlationId: randomUUID(), now: now(), ip: req.ip });
    if (!r.ok) {
      const h2 = rejectionToHttp(r.rejection);
      return reply.code(h2.status).send(h2.body);
    }
    after?.();
    return reply.code(204).send();
  };

  app.get('/me', guard, async (req, reply) => {
    const pid = req.session!.pid;
    const c = await pool.connect();
    try {
      const identity = await findIdentity(c, pid);
      const state = await loadStreamState(c, deps.rt.registry, accountStream(pid), accountReducer);
      if (!identity || !state.exists || state.deleted) return reply.code(NO_SESSION.status).send(NO_SESSION.body);
      return {
        pid,
        login: identity.login,
        displayName: identity.displayName,
        soloTeamId: state.soloTeamId,
        termsVersion: state.termsVersion,
        currentTermsVersion: PLATFORM_TERMS_VERSION,
        channelConnected: state.channelConnected,
        legal: state.legal,
      };
    } finally {
      c.release();
    }
  });

  app.post('/me/terms', guard, async (req: FastifyRequest<{ Body: { version?: unknown } | null }>, reply) =>
    run(req, reply, deps.accounts.acceptTerms, { pid: req.session!.pid, version: req.body?.version as number }),
  );

  app.put('/me/profile', guard, async (req: FastifyRequest<{ Body: { legal?: unknown } | null }>, reply) =>
    run(req, reply, deps.accounts.updateProfile, { pid: req.session!.pid, legal: req.body?.legal as never }),
  );

  app.delete('/me/channel', guard, async (req, reply) => run(req, reply, deps.accounts.disconnectChannel, { pid: req.session!.pid }));

  app.get('/me/data', guard, async (req, reply) => {
    const pid = req.session!.pid;
    const at = now();
    await logRead(pool, { actor: `user:${pid}`, action: 'export_data', target: accountStream(pid), ip: req.ip, at });
    const c = await pool.connect();
    try {
      const identity = await findIdentity(c, pid);
      const account = await loadStreamState(c, deps.rt.registry, accountStream(pid), accountReducer);
      const events = await readStream(c, deps.rt.registry, accountStream(pid));
      const parts = await c.query<ParticipantRow>(
        'SELECT giveaway_id, registered, in_pool, weight, winner_status FROM giveaway_participants WHERE pid = $1 ORDER BY giveaway_id',
        [pid],
      );
      reply.header('content-disposition', 'attachment; filename="meine-daten.json"');
      return {
        exportedAt: at.toISOString(),
        identity: identity
          ? { pid: identity.pid, twitchId: identity.twitchId, login: identity.login, displayName: identity.displayName, createdAt: identity.createdAt }
          : null,
        account,
        events,
        participations: parts.rows.map((r) => ({
          giveawayId: r.giveaway_id, registered: r.registered, inPool: r.in_pool, weight: r.weight, winnerStatus: r.winner_status,
        })),
      };
    } finally {
      c.release();
    }
  });

  app.delete('/me', guard, async (req, reply) =>
    run(req, reply, deps.accounts.deleteAccount, { pid: req.session!.pid }, () => {
      reply.header('set-cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSec: 0, secure: deps.secureCookies }));
    }),
  );
}
