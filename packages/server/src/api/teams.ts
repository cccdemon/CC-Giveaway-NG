// Teams (NEW_DESIGN.md 9.3): anlegen, einladen, beitreten, verlassen, umbenennen, deaktivieren, sperren. Nur Mitglieder sehen ein Team.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { UUID_RE } from '../framework/authorize.js';
import type { CommandHandler } from '../framework/command-bus.js';
import { TEAM_NOT_FOUND } from '../framework/team/commands.js';
import { INVITE_TTL_DAYS, teamStream, type TeamState } from '../framework/team/state.js';
import { logRead } from '../audit/access-log.js';
import { displayNameOf, findIdentity } from '../identity/identities.js';
import { reject } from '../shared/rejection.js';
import type { ApiDeps } from './auth.js';
import { rejectionToHttp } from './http.js';
import { requireSession } from './session.js';

type TeamParams = { Params: { id: string } };
type InviteParams = { Params: { inviteId: string } };

const INVITE_NOT_FOUND = rejectionToHttp(reject('invite_not_found', 'Diese Einladung gibt es nicht.'));
const NOT_MEMBER = rejectionToHttp(reject('not_member', 'Du bist kein Mitglied dieses Teams.'));

export function registerTeamRoutes(app: FastifyInstance, deps: ApiDeps, pool: pg.Pool): void {
  const now = deps.now ?? (() => new Date());
  const guard = { preHandler: requireSession(pool, now) };
  const teams = deps.rt.teams;

  const send = (reply: FastifyReply, h: { status: number; body: unknown }) => reply.code(h.status).send(h.body);

  /** Führt einen Team-Befehl als die angemeldete Person aus. Antwortet 204 oder mit der Ablehnung, `ok` liefert eine eigene Antwort. */
  const run = async <C, P>(req: FastifyRequest, reply: FastifyReply, h: CommandHandler<C, TeamState, P>, cmd: C, ok?: (events: { payload: unknown }[]) => unknown) => {
    const pid = req.session!.pid;
    const r = await deps.rt.bus.execute(h, cmd, { actor: `user:${pid}`, correlationId: randomUUID(), now: now(), ip: req.ip });
    if (!r.ok) return send(reply, rejectionToHttp(r.rejection));
    if (ok) return reply.code(201).send(ok(r.events));
    return reply.code(204).send();
  };

  const body = <T>(req: FastifyRequest): Partial<T> => (typeof req.body === 'object' && req.body !== null ? (req.body as Partial<T>) : {});

  app.get('/me/teams', guard, async (req) => {
    const pid = req.session!.pid;
    const solo = await pool.query<{ solo_team_id: string }>('SELECT solo_team_id FROM accounts WHERE pid = $1 AND NOT deleted', [pid]);
    const mine = await pool.query<{ id: string; name: string; active: boolean; member_count: number }>(
      'SELECT t.id, t.name, t.active, t.member_count FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.pid = $1 ORDER BY t.name, t.id',
      [pid],
    );
    return {
      solo: solo.rows[0] ? { teamId: solo.rows[0].solo_team_id } : null,
      teams: mine.rows.map((t) => ({ teamId: t.id, name: t.name, active: t.active, memberCount: t.member_count })),
    };
  });

  app.post('/teams', guard, async (req, reply) => {
    const teamId = randomUUID();
    return run(req, reply, teams.create, { teamId, name: body<{ name: string }>(req).name as string }, () => ({ teamId }));
  });

  app.get('/teams/:id', guard, async (req: FastifyRequest<TeamParams>, reply) => {
    const teamId = req.params.id;
    if (!UUID_RE.test(teamId)) return send(reply, rejectionToHttp(TEAM_NOT_FOUND()));
    const team = await pool.query<{ name: string; active: boolean }>('SELECT name, active FROM teams WHERE id = $1', [teamId]);
    const row = team.rows[0];
    if (!row) return send(reply, rejectionToHttp(TEAM_NOT_FOUND()));
    const member = await pool.query('SELECT 1 FROM team_members WHERE team_id = $1 AND pid = $2', [teamId, req.session!.pid]);
    if ((member.rowCount ?? 0) === 0) return send(reply, NOT_MEMBER);
    const at = now();
    // Anzeigenamen anderer Personen sind personenbezogen: Lesezugriff ins Zugriffslog (NEW_DESIGN.md 5.5).
    await logRead(pool, { actor: `user:${req.session!.pid}`, action: 'view_team', target: teamStream(teamId), ip: req.ip, at });
    const c = await pool.connect();
    try {
      const members = await c.query<{ pid: string }>('SELECT pid FROM team_members WHERE team_id = $1 ORDER BY since, pid', [teamId]);
      const named = [];
      for (const m of members.rows) named.push({ pid: m.pid, displayName: displayNameOf(await findIdentity(c, m.pid), m.pid) });
      const invites = await c.query<{ invite_id: string; expires_at: Date }>(
        'SELECT invite_id, expires_at FROM team_invites WHERE team_id = $1 AND NOT revoked AND expires_at > $2 ORDER BY expires_at, invite_id',
        [teamId, at],
      );
      const banned = await c.query<{ pid: string }>('SELECT pid FROM team_bans WHERE team_id = $1 ORDER BY pid', [teamId]);
      return {
        teamId,
        name: row.name,
        active: row.active,
        members: named,
        invites: invites.rows.map((i) => ({ inviteId: i.invite_id, expiresAt: i.expires_at.toISOString() })),
        banned: banned.rows.map((b) => b.pid),
      };
    } finally {
      c.release();
    }
  });

  app.put('/teams/:id/name', guard, async (req: FastifyRequest<TeamParams>, reply) =>
    run(req, reply, teams.rename, { teamId: req.params.id, name: body<{ name: string }>(req).name as string }),
  );

  app.post('/teams/:id/invites', guard, async (req: FastifyRequest<TeamParams>, reply) => {
    const inviteId = randomUUID();
    const fallback = new Date(now().getTime() + INVITE_TTL_DAYS * 86_400_000).toISOString();
    return run(req, reply, teams.createInvite, { teamId: req.params.id, inviteId }, (events) => ({
      inviteId,
      url: `${deps.publicUrl}/teams/join/${inviteId}`,
      expiresAt: (events[0]?.payload as { expiresAt?: string } | undefined)?.expiresAt ?? fallback,
    }));
  });

  app.delete('/teams/:id/invites/:inviteId', guard, async (req: FastifyRequest<{ Params: { id: string; inviteId: string } }>, reply) =>
    run(req, reply, teams.revokeInvite, { teamId: req.params.id, inviteId: req.params.inviteId }),
  );

  const inviteOf = async (inviteId: string) => {
    if (!UUID_RE.test(inviteId)) return null;
    const r = await pool.query<{ team_id: string; expires_at: Date; revoked: boolean; name: string; active: boolean }>(
      'SELECT i.team_id, i.expires_at, i.revoked, t.name, t.active FROM team_invites i JOIN teams t ON t.id = i.team_id WHERE i.invite_id = $1',
      [inviteId],
    );
    return r.rows[0] ?? null;
  };

  /** Einladungsseite ohne Sitzung: Teamname und ob der Link noch gilt. */
  app.get('/teams/join/:inviteId', async (req: FastifyRequest<InviteParams>, reply) => {
    const invite = await inviteOf(req.params.inviteId);
    if (!invite) return send(reply, INVITE_NOT_FOUND);
    const valid = !invite.revoked && invite.active && invite.expires_at.getTime() > now().getTime();
    return { teamId: invite.team_id, name: invite.name, valid };
  });

  app.post('/teams/join/:inviteId', guard, async (req: FastifyRequest<InviteParams>, reply) => {
    const invite = await inviteOf(req.params.inviteId);
    if (!invite) return send(reply, INVITE_NOT_FOUND);
    return run(req, reply, teams.join, { teamId: invite.team_id, inviteId: req.params.inviteId, pid: req.session!.pid });
  });

  app.post('/teams/:id/leave', guard, async (req: FastifyRequest<TeamParams>, reply) =>
    run(req, reply, teams.leave, { teamId: req.params.id, pid: req.session!.pid }),
  );
  app.post('/teams/:id/deactivate', guard, async (req: FastifyRequest<TeamParams>, reply) => run(req, reply, teams.deactivate, { teamId: req.params.id }));
  app.post('/teams/:id/reactivate', guard, async (req: FastifyRequest<TeamParams>, reply) => run(req, reply, teams.reactivate, { teamId: req.params.id }));

  app.post('/teams/:id/bans', guard, async (req: FastifyRequest<TeamParams>, reply) =>
    run(req, reply, teams.ban, { teamId: req.params.id, pid: body<{ pid: string }>(req).pid as string }),
  );
  app.delete('/teams/:id/bans/:pid', guard, async (req: FastifyRequest<{ Params: { id: string; pid: string } }>, reply) =>
    run(req, reply, teams.unban, { teamId: req.params.id, pid: req.params.pid }),
  );
}
