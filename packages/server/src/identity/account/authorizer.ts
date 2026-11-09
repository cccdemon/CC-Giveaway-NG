// Rechte für Giveaway- und Team-Befehle aus den Lesetabellen accounts und team_members (NEW_DESIGN.md 9.2, 9.3).
import type pg from 'pg';
import { UUID_RE, pidOfActor } from '../../framework/authorize.js';
import type { GiveawayAuthorizer } from '../../framework/giveaway/authorize.js';
import type { TeamAuthorizer } from '../../framework/team/commands.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import { currentTerms } from '../../platform/terms.js';

interface AccountRow {
  solo_team_id: string;
  terms_version: number;
  channel_connected: boolean;
  deleted: boolean;
  /** Grund der Plattform-Sperre (NEW_DESIGN.md 11.4), null ohne Sperre. */
  ban_reason: string | null;
}

const NO_ACCOUNT = (): Rejection => reject('no_account', 'Melde dich zuerst an.');
const NOT_MEMBER = (): Rejection => reject('not_member', 'Du bist kein Mitglied dieses Teams.');

/** Konto des Akteurs, wenn es existiert und nicht gelöscht ist. */
async function accountOf(c: pg.PoolClient, actor: string): Promise<{ pid: string; row: AccountRow } | null> {
  const pid = pidOfActor(actor);
  if (pid === null) return null;
  const r = await c.query<AccountRow>(
    'SELECT a.solo_team_id, a.terms_version, a.channel_connected, a.deleted, b.reason AS ban_reason FROM accounts a LEFT JOIN platform_bans b ON b.pid = a.pid WHERE a.pid = $1',
    [pid],
  );
  const row = r.rows[0];
  return !row || row.deleted ? null : { pid, row };
}

const BANNED = (reason: string): Rejection => reject('account_banned', `Dein Konto ist gesperrt. Grund: ${reason}. Wende dich an den Betreiber.`);

/** Streamer-Rechte (9.2, 11.4): nicht gesperrt, gültige Fassung der Nutzungsbedingungen akzeptiert, Kanal verbunden. */
async function onboarded(c: pg.PoolClient, row: AccountRow): Promise<Rejection | null> {
  if (row.ban_reason !== null) return BANNED(row.ban_reason);
  if (row.terms_version !== (await currentTerms(c)).version) return reject('terms_required', 'Akzeptiere zuerst die Nutzungsbedingungen.');
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
      const missing = await onboarded(c, account.row);
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
      return account ? onboarded(c, account.row) : NO_ACCOUNT();
    },
    async isMember(c, actor, teamId) {
      if (actor.startsWith('system:')) return null;
      const account = await accountOf(c, actor);
      if (!account) return NO_ACCOUNT();
      return (await isMemberRow(c, account.pid, teamId)) ? null : NOT_MEMBER();
    },
  };
}
