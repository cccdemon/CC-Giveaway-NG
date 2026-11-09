// Streamer-App (NEW_DESIGN.md 11.1): Kernkatalog, Kacheln, Detail, Teilnehmer, Verlauf. Rechte über GiveawayAuthorizer.controls.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { logRead } from '../audit/access-log.js';
import { UUID_RE } from '../framework/authorize.js';
import type { CommandHandler } from '../framework/command-bus.js';
import { GIVEAWAY_NOT_FOUND } from '../framework/giveaway/authorize.js';
import type { ChangeSettingsCmd, CreateGiveawayCmd, GiveawayCmd } from '../framework/giveaway/lifecycle.js';
import { giveawayStream, type GiveawayState, type GiveawayStatus, type WinnerStatus } from '../framework/giveaway/state.js';
import { channelStatusView } from '../ingest/status-view.js';
import type { ApiDeps } from './auth.js';
import { bodyOf, executeAs } from './commands.js';
import { giveawayDetail, historyPage, kernelInfo, loadGiveaway, participantRows } from './giveaways-read.js';
import { rejectionToHttp } from './http.js';
import { requireSession } from './session.js';

type IdParams = { Params: { id: string } };

const STATUSES: readonly GiveawayStatus[] = ['draft', 'open', 'paused', 'closed', 'drawn', 'completed', 'cancelled'];

interface TileRow {
  id: string;
  team_id: string;
  kernel: string;
  status: GiveawayStatus;
  prize: string;
  registered_count: number;
  pool_size: number;
  pool_weight: number;
  updated_at: Date;
  channels: string[];
}

export function registerGiveawayRoutes(app: FastifyInstance, deps: ApiDeps, pool: pg.Pool): void {
  const now = deps.now ?? (() => new Date());
  const guard = { preHandler: requireSession(pool, now) };
  const send = (reply: FastifyReply, h: { status: number; body: unknown }) => reply.code(h.status).send(h.body);
  const notFound = (reply: FastifyReply) => send(reply, rejectionToHttp(GIVEAWAY_NOT_FOUND()));

  /** Lädt das Giveaway und prüft die Team-Rechte der Sitzung. Antwortet selbst bei 404/403 und liefert dann null. */
  const withGiveaway = async (req: FastifyRequest<IdParams>, reply: FastifyReply, c: pg.PoolClient) => {
    if (!UUID_RE.test(req.params.id)) {
      await notFound(reply);
      return null;
    }
    const g = await loadGiveaway(c, deps.rt, req.params.id);
    if (!g) {
      await notFound(reply);
      return null;
    }
    const denied = await deps.auth.controls(c, `user:${req.session!.pid}`, g.row.teamId);
    if (denied) {
      await send(reply, rejectionToHttp(denied));
      return null;
    }
    return g;
  };

  app.get('/kernels', guard, async () => deps.rt.kernels.list().map(kernelInfo));

  app.get<{ Querystring: { status?: string } }>('/giveaways', guard, async (req) => {
    const pid = req.session!.pid;
    const wanted = (req.query.status ?? '').split(',').map((s) => s.trim()).filter((s): s is GiveawayStatus => (STATUSES as readonly string[]).includes(s));
    const r = await pool.query<TileRow>(
      `SELECT g.id, g.team_id, g.kernel, g.status, g.prize, g.registered_count, g.pool_size, g.pool_weight, g.updated_at, g.channels
         FROM giveaways g
        WHERE (g.team_id IN (SELECT solo_team_id FROM accounts WHERE pid = $1 AND NOT deleted) OR g.team_id IN (SELECT team_id FROM team_members WHERE pid = $1))
          AND ($2::text[] IS NULL OR g.status = ANY($2::text[]))
        ORDER BY g.updated_at DESC, g.id`,
      [pid, wanted.length > 0 ? wanted : null],
    );
    const channelPids = [...new Set(r.rows.flatMap((g) => g.channels))];
    const status = new Map((await channelStatusView(pool, channelPids, now())).map((v) => [v.pid, v]));
    return r.rows.map((g) => ({
      id: g.id,
      teamId: g.team_id,
      kernel: g.kernel,
      kernelLabel: deps.rt.kernels.has(g.kernel) ? deps.rt.kernels.get(g.kernel).label : g.kernel,
      status: g.status,
      prize: g.prize,
      registeredCount: g.registered_count,
      poolSize: g.pool_size,
      poolWeight: g.pool_weight,
      updatedAt: g.updated_at.toISOString(),
      warnings: g.channels.flatMap((ch) => {
        const w = status.get(ch)?.warning;
        return w ? [{ pid: ch, level: w.level, text: w.text }] : [];
      }),
    }));
  });

  app.get('/giveaways/:id', guard, async (req: FastifyRequest<IdParams>, reply) => {
    const c = await pool.connect();
    try {
      const g = await withGiveaway(req, reply, c);
      if (!g) return reply;
      return await giveawayDetail(c, deps.rt, req.params.id, g.state, now());
    } finally {
      c.release();
    }
  });

  app.get('/giveaways/:id/participants', guard, async (req: FastifyRequest<IdParams>, reply) => {
    const c = await pool.connect();
    try {
      const g = await withGiveaway(req, reply, c);
      if (!g) return reply;
      await logRead(c, { actor: `user:${req.session!.pid}`, action: 'view_participants', target: giveawayStream(req.params.id), ip: req.ip, at: now() });
      return await participantRows(c, deps.rt, req.params.id, g.state);
    } finally {
      c.release();
    }
  });

  // --- Befehle (NEW_DESIGN.md 7.1–7.3, 6.3): jeder läuft über den Bus mit der Sitzung als Akteur und antwortet mit den geschriebenen Ereignissen.

  const execute = <C, P, Q>(req: FastifyRequest, reply: FastifyReply, h: CommandHandler<C, GiveawayState, P, Q>, cmd: C, status = 200, extra: Record<string, unknown> = {}) =>
    executeAs(deps, req, reply, h, cmd, status, extra);
  const body = bodyOf;
  const idOf = (req: FastifyRequest<IdParams>) => (UUID_RE.test(req.params.id) ? req.params.id : null);
  /** Befehle auf ein Giveaway: eine ungültige ID ist „nicht gefunden“, der Rest läuft über authorize des Handlers. */
  const onGiveaway =
    <C extends { giveawayId: string }, P, Q>(h: CommandHandler<C, GiveawayState, P, Q>, cmdOf: (req: FastifyRequest<IdParams>) => Omit<C, 'giveawayId'>) =>
    async (req: FastifyRequest<IdParams>, reply: FastifyReply): Promise<void> => {
      const id = idOf(req);
      if (id === null) {
        await notFound(reply);
        return;
      }
      await execute(req, reply, h, { ...cmdOf(req), giveawayId: id } as C);
    };
  const h = deps.rt.handlers;

  app.post('/giveaways', guard, async (req, reply) => {
    const giveawayId = randomUUID();
    const b = body<{ teamId: string; kernelId: string; settings: CreateGiveawayCmd['settings'] }>(req);
    await execute(req, reply, h.create, { giveawayId, teamId: b.teamId as string, kernelId: b.kernelId as string, settings: (b.settings ?? {}) as CreateGiveawayCmd['settings'] }, 201, { giveawayId });
  });
  app.put<IdParams>('/giveaways/:id/settings', guard, onGiveaway(h.changeSettings, (req) => ({ settings: body<{ settings: ChangeSettingsCmd['settings'] }>(req).settings ?? {} })));
  const transitions = [
    ['open', h.open], ['pause', h.pause], ['resume', h.resume], ['close', h.close], ['reopen', h.reopen], ['cancel', h.cancel], ['complete', h.complete], ['draw', h.draw],
  ] as const;
  for (const [path, handler] of transitions) {
    app.post<IdParams>(`/giveaways/:id/${path}`, guard, onGiveaway(handler as CommandHandler<GiveawayCmd, GiveawayState, unknown, unknown>, () => ({})));
  }
  app.post<IdParams>('/giveaways/:id/redraw', guard, onGiveaway(h.redraw, (req) => {
    const b = body<{ replace: string; reason: string }>(req);
    return { replace: b.replace as string, reason: b.reason as string };
  }));
  app.put<{ Params: { id: string; pid: string } }>('/giveaways/:id/winners/:pid', guard, async (req, reply) => {
    const id = idOf(req);
    if (id === null) {
      await notFound(reply);
      return;
    }
    await execute(req, reply, h.setWinnerStatus, { giveawayId: id, pid: req.params.pid, status: body<{ status: WinnerStatus }>(req).status as WinnerStatus });
  });
  app.post<IdParams>('/giveaways/:id/boost', guard, onGiveaway(h.startBoost, (req) => {
    const b = body<{ factor: number; durationSec: number }>(req);
    return { factor: b.factor as number, durationSec: b.durationSec as number };
  }));
  app.delete<IdParams>('/giveaways/:id/boost', guard, onGiveaway(h.stopBoost, () => ({})));
  app.post<IdParams>('/giveaways/:id/corrections', guard, onGiveaway(h.correctWatch, (req) => {
    const b = body<{ channel: string; pid: string; sec: number; reason: string }>(req);
    return { channel: b.channel as string, pid: b.pid as string, sec: b.sec as number, reason: b.reason as string };
  }));
  app.post<IdParams>('/giveaways/:id/revert', guard, async (req, reply) => {
    const id = idOf(req);
    if (id === null) {
      await notFound(reply);
      return;
    }
    const b = body<{ eventId: string; reason: string }>(req);
    await execute(req, reply, h.revert, { stream: giveawayStream(id), eventId: String(b.eventId ?? ''), reason: b.reason as string });
  });
  app.post<IdParams>('/giveaways/:id/kernel-commands', guard, onGiveaway(h.kernelCommand, (req) => {
    const b = body<{ type: string; args: Record<string, unknown> }>(req);
    return { command: { type: b.type as string, args: (b.args ?? {}) as Record<string, unknown> } };
  }));

  app.get('/giveaways/:id/history', guard, async (req: FastifyRequest<IdParams & { Querystring: { beforeSeq?: string; limit?: string } }>, reply) => {
    const c = await pool.connect();
    try {
      const g = await withGiveaway(req, reply, c);
      if (!g) return reply;
      await logRead(c, { actor: `user:${req.session!.pid}`, action: 'view_history', target: giveawayStream(req.params.id), ip: req.ip, at: now() });
      const beforeSeq = Number(req.query.beforeSeq);
      const limit = Number(req.query.limit);
      return await historyPage(c, deps.rt, giveawayStream(req.params.id), {
        ...(Number.isInteger(beforeSeq) ? { beforeSeq } : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      });
    } finally {
      c.release();
    }
  });
}
