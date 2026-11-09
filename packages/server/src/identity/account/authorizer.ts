// Rechte für Giveaway- und Team-Befehle aus den Lesetabellen accounts und team_members (NEW_DESIGN.md 9.2, 9.3).
import type pg from 'pg';
import { UUID_RE, pidOfActor } from '../../framework/authorize.js';
import type { GiveawayAuthorizer } from '../../framework/giveaway/authorize.js';
import type { TeamAuthorizer } from '../../framework/team/commands.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import { PLATFORM_TERMS_VERSION } from '../terms.js';

interface AccountRow {
  solo_team_id: string;
  terms_version: number;
  channel_connected: boolean;
  deleted: boolean;
}

const NO_ACCOUNT = (): Rejection => reject('no_account', 'Melde dich zuerst an.');
const NOT_MEMBER = (): Rejection => reject('not_member', 'Du bist kein Mitglied dieses Teams.');

/** Konto des Akteurs, wenn es existiert und nicht gelöscht ist. */
async function accountOf(c: pg.PoolClient, actor: string): Promise<{ pid: string; row: AccountRow } | null> {
  const pid = pidOfActor(actor);
  if (pid === null) return null;
  const r = await c.query<AccountRow>('SELECT solo_team_id, terms_version, channel_connected, deleted FROM accounts WHERE pid = $1', [pid]);
  const row = r.rows[0];
  return !row || row.deleted ? null : { pid, row };
}

/** Onboarding abgeschlossen (9.2): Nutzungsbedingungen akzeptiert, Kanal verbunden. */
function onboarded(row: AccountRow): Rejection | null {
  if (row.terms_version !== PLATFORM_TERMS_VERSION) return reject('terms_required', 'Akzeptiere zuerst die Nutzungsbedingungen.');
  if (!row.channel_connected) return reject('channel_required', 'Verbinde zuerst deinen Kanal.');
  return null;
}

async function isMemberRow(c: pg.PoolClient, pid: string, teamId: string): Promise<boolean> {
  if (!UUID_RE.test(teamId)) return false;
  const r = await c.query('SELECT 1 FROM team_members WHERE team_id = $1 AND pid = $2 LIMIT 1', [teamId, pid]);
  return (r.rowCount ?? 0) > 0;
}

export function accountAuthorizer(): GiveawayAuthorizer {
  return {
    async controls(c: pg.PoolClient, actor, teamId) {
      if (actor.startsWith('system:')) return null;
      const account = await accountOf(c, actor);
      if (!account) return NO_ACCOUNT();
      const missing = onboarded(account.row);
      if (missing) return missing;
      // Solo-Team oder Mitglied eines echten Teams. Ein deaktiviertes Team behält seine Nachweise und bleibt steuerbar (9.3).
      if (account.row.solo_team_id === teamId || (await isMemberRow(c, account.pid, teamId))) return null;
      return reject('not_your_team', 'Dieses Giveaway gehört nicht zu deinem Team.');
    },
  };
}

export function accountTeamAuthorizer(): TeamAuthorizer {
  return {
    async canFound(c, actor) {
      if (actor.startsWith('system:')) return null;
      const account = await accountOf(c, actor);
      return account ? onboarded(account.row) : NO_ACCOUNT();
    },
    async isMember(c, actor, teamId) {
      if (actor.startsWith('system:')) return null;
      const account = await accountOf(c, actor);
      if (!account) return NO_ACCOUNT();
      return (await isMemberRow(c, account.pid, teamId)) ? null : NOT_MEMBER();
    },
  };
}
