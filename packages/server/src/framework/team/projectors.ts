// Lesetabellen des Stroms team:<id>: teams, team_members, team_invites, team_bans. Aus dem Zustand nach jedem Befehl.
import type pg from 'pg';
import type { StreamId } from '../../journal/types.js';
import { UUID_RE } from '../authorize.js';
import type { StateProjector } from '../projections.js';
import { teamIdOfStream, type TeamState } from './state.js';

export function teamsProjector(): StateProjector<TeamState> {
  return {
    name: 'teams',
    reducer: 'team',
    async apply(c: pg.PoolClient, stream: StreamId, state: TeamState, head: { seq: number; at: Date }) {
      const id = teamIdOfStream(stream);
      if (!state.exists || id === null) return;
      const members = Object.entries(state.members);
      const invites = Object.entries(state.invites);
      const bans = Object.entries(state.banned);
      await c.query(
        `INSERT INTO teams (id, name, active, member_count, last_seq, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, member_count = EXCLUDED.member_count,
           last_seq = EXCLUDED.last_seq, updated_at = EXCLUDED.updated_at`,
        [id, state.name, state.active, members.length, head.seq, head.at],
      );
      await c.query('DELETE FROM team_members WHERE team_id = $1', [id]);
      if (members.length > 0) {
        await c.query('INSERT INTO team_members (team_id, pid, since) SELECT $1::uuid, * FROM unnest($2::uuid[], $3::timestamptz[])', [
          id, members.map(([pid]) => pid), members.map(([, m]) => new Date(m.since)),
        ]);
      }
      await c.query('DELETE FROM team_invites WHERE team_id = $1', [id]);
      if (invites.length > 0) {
        await c.query(
          'INSERT INTO team_invites (invite_id, team_id, expires_at, revoked) SELECT i, $1::uuid, e, r FROM unnest($2::uuid[], $3::timestamptz[], $4::bool[]) AS t(i, e, r)',
          [id, invites.map(([inviteId]) => inviteId), invites.map(([, i]) => new Date(i.expiresAt)), invites.map(([, i]) => i.revoked)],
        );
      }
      await c.query('DELETE FROM team_bans WHERE team_id = $1', [id]);
      if (bans.length > 0) {
        await c.query('INSERT INTO team_bans (team_id, pid, since) SELECT $1::uuid, * FROM unnest($2::uuid[], $3::timestamptz[])', [
          id, bans.map(([pid]) => pid), bans.map(([, b]) => new Date(b.since)),
        ]);
      }
    },
    async reset(c: pg.PoolClient, stream?: StreamId) {
      if (stream === undefined) {
        await c.query('DELETE FROM teams');
        return;
      }
      const id = teamIdOfStream(stream);
      if (id !== null && UUID_RE.test(id)) await c.query('DELETE FROM teams WHERE id = $1', [id]);
    },
  };
}
