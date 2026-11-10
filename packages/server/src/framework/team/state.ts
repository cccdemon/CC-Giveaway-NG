// Zustand des Stroms team:<id> (NEW_DESIGN.md 5.1, 9.3): Mitglieder, Einladungen, Aktivität, team-weite Sperren. Rein und unveränderlich.
import type { Pid } from '../../kernel-api/index.js';
import type { EventRecord, StreamId } from '../../journal/types.js';
import type { StreamReducer } from '../command-bus.js';

export interface TeamState {
  exists: boolean;
  name: string;
  active: boolean;
  members: Record<Pid, { since: string; eventId: string }>;
  invites: Record<string, { expiresAt: string; revoked: boolean }>;
  banned: Record<Pid, { since: string; eventId: string }>;
}

export const TEAM_EVENTS = {
  created: 'team_created',
  renamed: 'team_renamed',
  inviteCreated: 'invite_created',
  inviteRevoked: 'invite_revoked',
  memberJoined: 'member_joined',
  memberLeft: 'member_left',
  deactivated: 'team_deactivated',
  reactivated: 'team_reactivated',
  banned: 'participant_banned',
  unbanned: 'participant_unbanned',
  /** Zuordnung zum Team des Altsystems (NEW_DESIGN.md 15.6), direkt nach team_created. */
  imported: 'team_imported',
} as const;

export const TEAM_NAME_MAX = 60;
export const INVITE_TTL_DAYS = 7;

const PREFIX = 'team:';

export function teamStream(teamId: string): StreamId {
  return `${PREFIX}${teamId}`;
}

export function teamIdOfStream(stream: StreamId): string | null {
  return stream.startsWith(PREFIX) ? stream.slice(PREFIX.length) : null;
}

const without = <V>(record: Record<string, V>, key: string): Record<string, V> => Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

function apply(s: TeamState, e: EventRecord): TeamState {
  const at = e.createdAt.toISOString();
  switch (e.type) {
    case TEAM_EVENTS.created: {
      const { name, members } = e.payload as { name: string; members: Pid[] };
      return { ...s, exists: true, name, active: true, members: Object.fromEntries(members.map((pid) => [pid, { since: at, eventId: e.id }])) };
    }
    case TEAM_EVENTS.renamed:
      return { ...s, name: (e.payload as { after: string }).after };
    case TEAM_EVENTS.inviteCreated: {
      const { inviteId, expiresAt } = e.payload as { inviteId: string; expiresAt: string };
      return { ...s, invites: { ...s.invites, [inviteId]: { expiresAt, revoked: false } } };
    }
    case TEAM_EVENTS.inviteRevoked: {
      const { inviteId } = e.payload as { inviteId: string };
      const invite = s.invites[inviteId];
      return invite ? { ...s, invites: { ...s.invites, [inviteId]: { ...invite, revoked: true } } } : s;
    }
    case TEAM_EVENTS.memberJoined: {
      const { pid } = e.payload as { pid: Pid };
      return { ...s, members: { ...s.members, [pid]: { since: at, eventId: e.id } } };
    }
    case TEAM_EVENTS.memberLeft:
      return { ...s, members: without(s.members, (e.payload as { pid: Pid }).pid) };
    case TEAM_EVENTS.deactivated:
      return { ...s, active: false };
    case TEAM_EVENTS.reactivated:
      return { ...s, active: true };
    case TEAM_EVENTS.banned: {
      const { pid } = e.payload as { pid: Pid };
      return { ...s, banned: { ...s.banned, [pid]: { since: at, eventId: e.id } } };
    }
    case TEAM_EVENTS.unbanned:
      return { ...s, banned: without(s.banned, (e.payload as { pid: Pid }).pid) };
    default:
      return s;
  }
}

export const teamReducer: StreamReducer<TeamState> = {
  name: 'team',
  version: 1,
  initial: () => ({ exists: false, name: '', active: false, members: {}, invites: {}, banned: {} }),
  apply,
};
