// Teilnehmer-Portal (NEW_DESIGN.md 11.3) und öffentliche Giveaway-Seite. Eigene Daten über die Sitzung, Befehle über den Bus.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { UUID_RE } from '../framework/authorize.js';
import { GIVEAWAY_NOT_FOUND } from '../framework/giveaway/authorize.js';
import { GateCheckError, type GateConfig } from '../framework/giveaway/gates.js';
import type { GiveawayState, WinnerStatus } from '../framework/giveaway/state.js';
import { displayNamesOf, displayNameOf } from '../identity/identities.js';
import { readEvent } from '../journal/journal.js';
import type { Pid, ViewerView } from '../kernel-api/index.js';
import { reject } from '../shared/rejection.js';
import type { ApiDeps } from './auth.js';
import { bodyOf, executeAs } from './commands.js';
import { kernelInfo, loadGiveaway } from './giveaways-read.js';
import { rejectionToHttp } from './http.js';
import { requireSession } from './session.js';

type IdParams = { Params: { id: string } };

interface PublicGiveaway {
  id: string;
  prize: string;
  sponsor: string | null;
  kernel: { id: string; label: string; display: ReturnType<typeof kernelInfo>['display']; commands: ReturnType<typeof kernelInfo>['commands'] };
  status: GiveawayState['status'];
  channels: { pid: Pid; displayName: string }[];
  keyword: string | null;
  legal: GiveawayState['legal'] | GiveawayState['settings']['legal'];
  claimDays: number;
  counting: GiveawayState['settings']['counting'];
  winnersCount: number;
}

interface ParticipationRow {
  id: string;
  prize: string;
  kernel: string;
  status: GiveawayState['status'];
  registered: boolean;
  in_pool: boolean;
  weight: number;
  pool_weight: number;
  winner_status: WinnerStatus | null;
  updated_at: Date;
}

const DAY_MS = 86_400_000;

async function publicView(c: pg.PoolClient, deps: ApiDeps, id: string, state: GiveawayState): Promise<PublicGiveaway> {
  const k = kernelInfo(deps.rt.kernels.get(state.kernelId));
  const names = await displayNamesOf(c, state.settings.channels);
  return {
    id,
    prize: state.settings.prize,
    sponsor: state.settings.sponsor,
    kernel: { id: k.id, label: k.label, display: k.display, commands: k.commands },
    status: state.status,
    channels: state.settings.channels.map((pid) => ({ pid, displayName: names.get(pid) ?? displayNameOf(null, pid) })),
    keyword: state.settings.keyword,
    legal: state.legal ?? state.settings.legal,
    claimDays: state.settings.claimDays,
    counting: state.settings.counting,
    winnersCount: state.settings.winnersCount,
  };
}

export function registerPortalRoutes(app: FastifyInstance, deps: ApiDeps, pool: pg.Pool): void {
  const now = deps.now ?? (() => new Date());
  const guard = { preHandler: requireSession(pool, now) };
  const send = (reply: FastifyReply, h: { status: number; body: unknown }) => reply.code(h.status).send(h.body);
  const notFound = (reply: FastifyReply) => send(reply, rejectionToHttp(GIVEAWAY_NOT_FOUND()));
  const h = deps.rt.handlers;

  /** Lädt das Giveaway oder antwortet 404 und liefert null. */
  const load = async (req: FastifyRequest<IdParams>, reply: FastifyReply, c: pg.PoolClient) => {
    const g = UUID_RE.test(req.params.id) ? await loadGiveaway(c, deps.rt, req.params.id) : null;
    if (!g) await notFound(reply);
    return g;
  };

  app.get<IdParams>('/public/giveaways/:id', async (req, reply) => {
    const c = await pool.connect();
    try {
      const g = await load(req, reply, c);
      if (!g) return reply;
      // Ein Entwurf ist nicht geöffnet und gehört dem Team: nach außen gibt es ihn noch nicht.
      if (g.state.status === 'draft') return notFound(reply);
      return await publicView(c, deps, req.params.id, g.state);
    } finally {
      c.release();
    }
  });

  app.get('/portal/giveaways', guard, async (req) => {
    const r = await pool.query<ParticipationRow>(
      `SELECT g.id, g.prize, g.kernel, g.status, gp.registered, gp.in_pool, gp.weight, g.pool_weight, gp.winner_status, g.updated_at
         FROM giveaway_participants gp JOIN giveaways g ON g.id = gp.giveaway_id
        WHERE gp.pid = $1 ORDER BY g.updated_at DESC, g.id`,
      [req.session!.pid],
    );
    return r.rows.map((x) => ({
      id: x.id,
      prize: x.prize,
      kernelLabel: deps.rt.kernels.has(x.kernel) ? deps.rt.kernels.get(x.kernel).label : x.kernel,
      status: x.status,
      registered: x.registered,
      inPool: x.in_pool,
      weight: x.weight,
      chance: x.in_pool && x.pool_weight > 0 ? x.weight / x.pool_weight : null,
      winnerStatus: x.winner_status,
      updatedAt: x.updated_at.toISOString(),
    }));
  });

  app.get<IdParams>('/portal/giveaways/:id', guard, async (req, reply) => {
    const pid = req.session!.pid;
    const c = await pool.connect();
    try {
      const g = await load(req, reply, c);
      if (!g) return reply;
      const { state } = g;
      const involved = (await c.query('SELECT 1 FROM giveaway_participants WHERE giveaway_id = $1 AND pid = $2', [req.params.id, pid])).rowCount ?? 0;
      // Wer nicht beteiligt ist, sieht nur offene Giveaways (zum Teilnehmen). Festlegung 6.
      if (involved === 0 && state.status !== 'open') return notFound(reply);
      const kernel = deps.rt.kernels.get(state.kernelId);
      const view: ViewerView = kernel.viewerView(state.kernelState, pid, state.settings.config);
      const pool_ = kernel.pool(state.kernelState, state.settings.config);
      const poolWeight = pool_.reduce((sum, e) => sum + e.weight, 0);
      const draw = [...state.draws].reverse().find((d) => !d.voided) ?? null;
      const drawEvent = draw ? await readEvent(c, deps.rt.registry, draw.eventId) : null;
      const gateResult = (drawEvent?.payload as { gates?: { pid: Pid; ok: boolean; reasons: string[] }[] } | undefined)?.gates?.find((x) => x.pid === pid);
      const winnerStatus = state.winners[pid];
      return {
        ...(await publicView(c, deps, req.params.id, state)),
        registered: pid in state.registered,
        view,
        chance: view.inPool && poolWeight > 0 ? view.weight / poolWeight : null,
        gates: state.settings.gates as GateConfig[],
        lastGateResult: gateResult ? { ok: gateResult.ok, reasons: gateResult.reasons } : null,
        winner:
          winnerStatus !== undefined && drawEvent
            ? { status: winnerStatus, claimDeadline: new Date(drawEvent.createdAt.getTime() + state.settings.claimDays * DAY_MS).toISOString(), contact: state.settings.contact }
            : null,
        legalEventId: state.legalEventId,
      };
    } finally {
      c.release();
    }
  });

  /** Bedingungsstatus auf Anfrage, nur für die eigene pid (NEW_DESIGN.md 6.5). Twitch nicht erreichbar → 502. */
  app.get<IdParams>('/portal/giveaways/:id/gates', guard, async (req, reply) => {
    const pid = req.session!.pid;
    const c = await pool.connect();
    try {
      const g = await load(req, reply, c);
      if (!g) return reply;
      const { state } = g;
      // Dieselbe Sicht wie das Detail (Festlegung 6) und nur bis zur Ziehung: sonst wäre die Route ein Hebel auf das Streamer-Token.
      const involved = (await c.query('SELECT 1 FROM giveaway_participants WHERE giveaway_id = $1 AND pid = $2', [req.params.id, pid])).rowCount ?? 0;
      const beforeDraw = state.status === 'open' || state.status === 'paused' || state.status === 'closed';
      if (!beforeDraw || (involved === 0 && state.status !== 'open')) return notFound(reply);
      if (!deps.gates) return send(reply, rejectionToHttp(reject('no_checker', 'Bedingungen lassen sich in diesem Prozess nicht prüfen.')));
      try {
        const results = await deps.gates.check(c, {
          channels: state.settings.channels,
          gates: state.settings.gates as GateConfig[],
          pids: [pid],
          seen: { [pid]: state.seen[pid]?.channels ?? [] },
          now: now(),
        });
        const mine = results.find((r) => r.pid === pid);
        return mine ? { ok: mine.ok, reasons: mine.reasons } : { ok: false, reasons: ['no_result'] };
      } catch (e) {
        if (e instanceof GateCheckError) return send(reply, rejectionToHttp(reject(e.code, e.message)));
        throw e;
      }
    } finally {
      c.release();
    }
  });

  const onGiveaway = (fn: (req: FastifyRequest<IdParams>, reply: FastifyReply, id: string) => Promise<void>) => async (req: FastifyRequest<IdParams>, reply: FastifyReply) => {
    if (!UUID_RE.test(req.params.id)) {
      await notFound(reply);
      return;
    }
    await fn(req, reply, req.params.id);
  };

  app.post<IdParams>('/portal/giveaways/:id/register', guard, onGiveaway((req, reply, id) => executeAs(deps, req, reply, h.register, { giveawayId: id, pid: req.session!.pid })));
  app.post<IdParams>('/portal/giveaways/:id/withdraw', guard, onGiveaway((req, reply, id) => executeAs(deps, req, reply, h.withdraw, { giveawayId: id, pid: req.session!.pid })));
  app.post<IdParams>(
    '/portal/giveaways/:id/kernel-commands',
    guard,
    onGiveaway((req, reply, id) => {
      const b = bodyOf<{ type: string; args: Record<string, unknown> }>(req);
      // Die pid kommt immer aus der Sitzung, nie aus dem Body.
      return executeAs(deps, req, reply, h.kernelCommand, { giveawayId: id, command: { type: b.type as string, pid: req.session!.pid, args: (b.args ?? {}) as Record<string, unknown> } });
    }),
  );
}
