// Team-Verzeichnisse des Rahmens aus den Lesetabellen accounts, teams, team_members und team_bans (NEW_DESIGN.md 9.3, 15.3).
import { UUID_RE } from '../framework/authorize.js';
import type { BanDirectory, TeamDirectory } from '../framework/team/directory.js';

/** Echtes Team: Mitglieder-pids und Aktivität. Solo-Team: die eigene pid des Kontos. Sonst null. */
export function pgTeamDirectory(): TeamDirectory {
  return {
    async channelsOf(db, teamId) {
      if (!UUID_RE.test(teamId)) return null;
      const team = await db.query<{ active: boolean }>('SELECT active FROM teams WHERE id = $1', [teamId]);
      const row = team.rows[0];
      if (row) {
        const members = await db.query<{ pid: string }>('SELECT pid FROM team_members WHERE team_id = $1', [teamId]);
        return { channels: new Set(members.rows.map((m) => m.pid)), active: row.active };
      }
      const solo = await db.query<{ pid: string }>('SELECT pid FROM accounts WHERE solo_team_id = $1 AND NOT deleted', [teamId]);
      const owner = solo.rows[0];
      return owner ? { channels: new Set([owner.pid]), active: true } : null;
    },
  };
}

export function pgBanDirectory(): BanDirectory {
  return {
    async bannedOf(db, teamId) {
      if (!UUID_RE.test(teamId)) return new Set();
      const r = await db.query<{ pid: string }>('SELECT pid FROM team_bans WHERE team_id = $1', [teamId]);
      return new Set(r.rows.map((x) => x.pid));
    },
  };
}
