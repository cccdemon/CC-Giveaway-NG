// Befehle des Stroms team:<id> (NEW_DESIGN.md 9.3, 15.3, 15.9). Rechte liefert ein TeamAuthorizer, die Umsetzung über Konten liegt in identity.
import type pg from 'pg';
import type { Pid } from '../../kernel-api/index.js';
import type { EventTypeRegistry } from '../../journal/event-types.js';
import type { Actor } from '../../journal/types.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import { INVALID_ID, UUID_RE, authorizeSelf, pidOfActor } from '../authorize.js';
import type { CommandContext, CommandHandler } from '../command-bus.js';
import { makeRevertHandler, type RevertCommand, type RevertPrepared } from '../revert.js';
import { INVITE_TTL_DAYS, TEAM_EVENTS, TEAM_NAME_MAX, teamIdOfStream, teamReducer, teamStream, type TeamState } from './state.js';

export interface TeamAuthorizer {
  /** Darf der Akteur ein Team gründen oder einem beitreten? Braucht ein vollständiges Konto. */
  canFound(c: pg.PoolClient, actor: Actor): Promise<Rejection | null>;
  /** Ist der Akteur Mitglied dieses Teams? System-Akteure gelten als Mitglied. */
  isMember(c: pg.PoolClient, actor: Actor, teamId: string): Promise<Rejection | null>;
}

export const allowAllTeams: TeamAuthorizer = { canFound: async () => null, isMember: async () => null };

const NO_ACCOUNTS = (): Rejection => reject('no_accounts', 'Dieser Prozess nimmt keine Nutzerbefehle an. Nutze die App.');
const systemOnly = async (_c: pg.PoolClient, actor: Actor): Promise<Rejection | null> => (actor.startsWith('system:') ? null : NO_ACCOUNTS());

/** Nur Systembefehle, z. B. im Scheduler- oder Ingest-Prozess. */
export const denyUsersTeams: TeamAuthorizer = { canFound: systemOnly, isMember: systemOnly };

export interface TeamCmd {
  teamId: string;
}
export interface CreateTeamCmd extends TeamCmd {
  name: string;
  /** Nur für system:migration (NEW_DESIGN.md 15.9). */
  members?: Pid[];
}
export interface RenameTeamCmd extends TeamCmd {
  name: string;
}
export interface InviteCmd extends TeamCmd {
  inviteId: string;
}
export interface JoinTeamCmd extends InviteCmd {
  pid: Pid;
}
export interface MemberCmd extends TeamCmd {
  pid: Pid;
}

type Handler<C> = CommandHandler<C, TeamState>;

const MIGRATION = 'system:migration';
export const TEAM_NOT_FOUND = (): Rejection => reject('team_not_found', 'Dieses Team gibt es nicht.');
export const TEAM_INACTIVE = (): Rejection => reject('team_inactive', 'Dieses Team ist deaktiviert. Aktiviere es oder nutze ein anderes.');
const INVITE_NOT_FOUND = (): Rejection => reject('invite_not_found', 'Diese Einladung gibt es nicht.');
const NOT_MEMBER = (): Rejection => reject('not_member', 'Du bist kein Mitglied dieses Teams.');
const LAST_MEMBER = (): Rejection => reject('last_member', 'Du bist das letzte Mitglied. Deaktiviere das Team.');
export const BANNED = (): Rejection => reject('banned', 'Du bist in diesem Team gesperrt.');
const SELF_TEXT = 'Du kannst nur für dich selbst beitreten oder austreten.';

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Teamname: getrimmt, 1 bis 60 Zeichen. */
function checkName(raw: unknown): string | Rejection {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 1 || name.length > TEAM_NAME_MAX) return reject('team_name_invalid', `Der Teamname hat 1 bis ${TEAM_NAME_MAX} Zeichen.`);
  return name;
}

function member(auth: TeamAuthorizer) {
  return async (cmd: TeamCmd, ctx: CommandContext, c: pg.PoolClient): Promise<Rejection | null> => (isUuid(cmd.teamId) ? auth.isMember(c, ctx.actor, cmd.teamId) : INVALID_ID());
}

function self(auth: TeamAuthorizer, found: boolean) {
  return async (cmd: MemberCmd, ctx: CommandContext, c: pg.PoolClient): Promise<Rejection | null> => {
    if (!isUuid(cmd.teamId)) return INVALID_ID();
    const own = authorizeSelf(cmd.pid, ctx.actor, SELF_TEXT);
    if (own) return own;
    return found ? auth.canFound(c, ctx.actor) : null;
  };
}

const exists = (state: TeamState): Rejection | null => (state.exists ? null : TEAM_NOT_FOUND());

export function createTeamHandler(auth: TeamAuthorizer): Handler<CreateTeamCmd> {
  return {
    type: 'create_team',
    streamOf: (cmd) => teamStream(cmd.teamId),
    reducer: teamReducer,
    authorize: (cmd, ctx, c) => (!isUuid(cmd.teamId) ? INVALID_ID() : ctx.actor === MIGRATION ? null : auth.canFound(c, ctx.actor)),
    decide(state, cmd, ctx) {
      if (state.exists) return reject('already_exists', 'Dieses Team gibt es schon.');
      const name = checkName(cmd.name);
      if (typeof name !== 'string') return name;
      let members: Pid[];
      if (ctx.actor === MIGRATION) {
        if (!Array.isArray(cmd.members) || cmd.members.length === 0 || !cmd.members.every(isUuid)) {
          return reject('members_required', 'Gib mindestens ein Mitglied an.');
        }
        members = [...new Set(cmd.members)].sort();
      } else {
        if (cmd.members !== undefined) return reject('members_reserved', 'Mitglieder vorgeben darf nur die Übernahme.');
        const founder = pidOfActor(ctx.actor);
        if (founder === null) return reject('founder_required', 'Ein Team braucht einen Gründer mit Konto.');
        members = [founder];
      }
      return [{ type: TEAM_EVENTS.created, payload: { name, members } }];
    },
  };
}

export function renameTeamHandler(auth: TeamAuthorizer): Handler<RenameTeamCmd> {
  return {
    type: 'rename_team',
    streamOf: (cmd) => teamStream(cmd.teamId),
    reducer: teamReducer,
    authorize: member(auth),
    decide(state, cmd) {
      const missing = exists(state);
      if (missing) return missing;
      const name = checkName(cmd.name);
      if (typeof name !== 'string') return name;
      if (name === state.name) return [];
      return [{ type: TEAM_EVENTS.renamed, payload: { before: state.name, after: name } }];
    },
  };
}

export function createInviteHandler(auth: TeamAuthorizer): Handler<InviteCmd> {
  return {
    type: 'create_invite',
    streamOf: (cmd) => teamStream(cmd.teamId),
    reducer: teamReducer,
    authorize: member(auth),
    decide(state, cmd, ctx) {
      const missing = exists(state);
      if (missing) return missing;
      if (!isUuid(cmd.inviteId)) return INVALID_ID();
      if (!state.active) return TEAM_INACTIVE();
      if (state.invites[cmd.inviteId]) return reject('already_exists', 'Diese Einladung gibt es schon.');
      const expiresAt = new Date(ctx.now.getTime() + INVITE_TTL_DAYS * 86_400_000).toISOString();
      return [{ type: TEAM_EVENTS.inviteCreated, payload: { inviteId: cmd.inviteId, expiresAt } }];
    },
  };
}

export function revokeInviteHandler(auth: TeamAuthorizer): Handler<InviteCmd> {
  return {
    type: 'revoke_invite',
    streamOf: (cmd) => teamStream(cmd.teamId),
    reducer: teamReducer,
    authorize: member(auth),
    decide(state, cmd) {
      const missing = exists(state);
      if (missing) return missing;
      const invite = isUuid(cmd.inviteId) ? state.invites[cmd.inviteId] : undefined;
      if (!invite) return INVITE_NOT_FOUND();
      if (invite.revoked) return [];
      return [{ type: TEAM_EVENTS.inviteRevoked, payload: { inviteId: cmd.inviteId } }];
    },
  };
}

export function joinTeamHandler(auth: TeamAuthorizer): Handler<JoinTeamCmd> {
  return {
    type: 'join_team',
    streamOf: (cmd) => teamStream(cmd.teamId),
    reducer: teamReducer,
    authorize: self(auth, true),
    decide(state, cmd, ctx) {
      const missing = exists(state);
      if (missing) return missing;
      const invite = isUuid(cmd.inviteId) ? state.invites[cmd.inviteId] : undefined;
      if (!invite) return INVITE_NOT_FOUND();
      if (invite.revoked) return reject('invite_revoked', 'Diese Einladung ist widerrufen. Bitte um eine neue.');
      if (ctx.now.getTime() >= Date.parse(invite.expiresAt)) return reject('invite_expired', 'Diese Einladung ist abgelaufen. Bitte um eine neue.');
      if (!state.active) return TEAM_INACTIVE();
      if (state.banned[cmd.pid]) return BANNED();
      if (state.members[cmd.pid]) return [];
      return [{ type: TEAM_EVENTS.memberJoined, payload: { pid: cmd.pid, inviteId: cmd.inviteId } }];
    },
  };
}

export function leaveTeamHandler(auth: TeamAuthorizer): Handler<MemberCmd> {
  return {
    type: 'leave_team',
    streamOf: (cmd) => teamStream(cmd.teamId),
    reducer: teamReducer,
    authorize: self(auth, false),
    decide(state, cmd) {
      const missing = exists(state);
      if (missing) return missing;
      if (!state.members[cmd.pid]) return NOT_MEMBER();
      if (Object.keys(state.members).length === 1) return LAST_MEMBER();
      return [{ type: TEAM_EVENTS.memberLeft, payload: { pid: cmd.pid } }];
    },
  };
}

function toggleHandler(auth: TeamAuthorizer, type: 'deactivate_team' | 'reactivate_team'): Handler<TeamCmd> {
  const target = type === 'deactivate_team' ? false : true;
  return {
    type,
    streamOf: (cmd) => teamStream(cmd.teamId),
    reducer: teamReducer,
    authorize: member(auth),
    decide(state) {
      const missing = exists(state);
      if (missing) return missing;
      if (state.active === target) return [];
      return [{ type: target ? TEAM_EVENTS.reactivated : TEAM_EVENTS.deactivated, payload: {} }];
    },
  };
}

export const deactivateTeamHandler = (auth: TeamAuthorizer): Handler<TeamCmd> => toggleHandler(auth, 'deactivate_team');
export const reactivateTeamHandler = (auth: TeamAuthorizer): Handler<TeamCmd> => toggleHandler(auth, 'reactivate_team');

export function banParticipantHandler(auth: TeamAuthorizer): Handler<MemberCmd> {
  return {
    type: 'ban_participant',
    streamOf: (cmd) => teamStream(cmd.teamId),
    reducer: teamReducer,
    authorize: member(auth),
    decide(state, cmd) {
      const missing = exists(state);
      if (missing) return missing;
      if (!isUuid(cmd.pid)) return INVALID_ID();
      if (state.banned[cmd.pid]) return [];
      return [{ type: TEAM_EVENTS.banned, payload: { pid: cmd.pid } }];
    },
  };
}

export function unbanParticipantHandler(auth: TeamAuthorizer): Handler<MemberCmd> {
  return {
    type: 'unban_participant',
    streamOf: (cmd) => teamStream(cmd.teamId),
    reducer: teamReducer,
    authorize: member(auth),
    decide(state, cmd) {
      const missing = exists(state);
      if (missing) return missing;
      if (!isUuid(cmd.pid) || !state.banned[cmd.pid]) return reject('not_banned', 'Diese Person ist nicht gesperrt.');
      return [{ type: TEAM_EVENTS.unbanned, payload: { pid: cmd.pid } }];
    },
  };
}

export function teamRevertHandler(registry: EventTypeRegistry, auth: TeamAuthorizer): CommandHandler<RevertCommand, TeamState, RevertPrepared> {
  const base = makeRevertHandler(teamReducer, registry, (cmd: RevertCommand, ctx, c) => {
    const teamId = teamIdOfStream(cmd.stream);
    return teamId === null || !isUuid(teamId) ? TEAM_NOT_FOUND() : auth.isMember(c, ctx.actor, teamId);
  });
  return {
    ...base,
    decide(state, cmd, ctx, prepared) {
      // Ein Beitritt gehört der Person: sonst wäre Rückgängig ein verstecktes Entfernen durch andere Mitglieder (Spec 9.3 kennt kein Entfernen).
      const target = prepared.target;
      if (target && target.type === TEAM_EVENTS.memberJoined && !ctx.actor.startsWith('system:')) {
        const { pid } = target.payload as { pid: Pid };
        if (ctx.actor !== `user:${pid}`) return reject('not_you', 'Nur die Person selbst nimmt ihren Beitritt zurück.');
      }
      return base.decide(state, cmd, ctx, prepared);
    },
  };
}
