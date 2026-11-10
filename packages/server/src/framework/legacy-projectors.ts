// Lesetabellen der Übernahme (NEW_DESIGN.md 15.6): legacy_imports und legacy_teams, je ein Projector auf das Zuordnungs-Ereignis.
import type pg from 'pg';
import { FRAMEWORK_EVENTS, type LegacyImportedPayload } from '../kernel-api/index.js';
import type { EventRecord, StreamId } from '../journal/types.js';
import { UUID_RE } from './authorize.js';
import type { Projector } from './projections.js';
import { TEAM_EVENTS, teamIdOfStream } from './team/state.js';

const GIVEAWAY_PREFIX = 'giveaway:';
const giveawayIdOf = (stream: StreamId): string => stream.slice(GIVEAWAY_PREFIX.length);

export function legacyImportsProjector(): Projector {
  return {
    name: 'legacy_imports',
    handles: [FRAMEWORK_EVENTS.legacyImported],
    async apply(c: pg.PoolClient, e: EventRecord) {
      const { legacySessionId } = e.payload as LegacyImportedPayload;
      await c.query('INSERT INTO legacy_imports (legacy_session_id, giveaway_id, imported_at) VALUES ($1, $2, $3) ON CONFLICT (legacy_session_id) DO NOTHING', [
        legacySessionId, giveawayIdOf(e.stream), e.createdAt,
      ]);
    },
    async reset(c: pg.PoolClient, stream?: StreamId) {
      if (stream === undefined) await c.query('DELETE FROM legacy_imports');
      else if (UUID_RE.test(giveawayIdOf(stream))) await c.query('DELETE FROM legacy_imports WHERE giveaway_id = $1', [giveawayIdOf(stream)]);
    },
  };
}

export function legacyTeamsProjector(): Projector {
  return {
    name: 'legacy_teams',
    handles: [TEAM_EVENTS.imported],
    async apply(c: pg.PoolClient, e: EventRecord) {
      const { legacyTeamId } = e.payload as { legacyTeamId: string };
      const teamId = teamIdOfStream(e.stream);
      if (teamId === null) return;
      await c.query('INSERT INTO legacy_teams (legacy_team_id, team_id, imported_at) VALUES ($1, $2, $3) ON CONFLICT (legacy_team_id) DO NOTHING', [legacyTeamId, teamId, e.createdAt]);
    },
    async reset(c: pg.PoolClient, stream?: StreamId) {
      if (stream === undefined) await c.query('DELETE FROM legacy_teams');
      else {
        const teamId = teamIdOfStream(stream);
        if (teamId !== null && UUID_RE.test(teamId)) await c.query('DELETE FROM legacy_teams WHERE team_id = $1', [teamId]);
      }
    },
  };
}
