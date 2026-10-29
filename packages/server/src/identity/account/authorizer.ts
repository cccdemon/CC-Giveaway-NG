// Rechte für Giveaway-Befehle aus der Lesetabelle accounts (NEW_DESIGN.md 9.2, 9.3).
// Teilprojekt 7 ergänzt hier Mitgliedschaften in echten Teams.
import type pg from 'pg';
import { pidOfActor } from '../../framework/authorize.js';
import type { GiveawayAuthorizer } from '../../framework/giveaway/authorize.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import { PLATFORM_TERMS_VERSION } from '../terms.js';

interface AccountRow {
  solo_team_id: string;
  terms_version: number;
  channel_connected: boolean;
  deleted: boolean;
}

const NO_ACCOUNT = (): Rejection => reject('no_account', 'Melde dich zuerst an.');

export function accountAuthorizer(): GiveawayAuthorizer {
  return {
    async controls(c: pg.PoolClient, actor, teamId) {
      if (actor.startsWith('system:')) return null;
      const pid = pidOfActor(actor);
      if (pid === null) return NO_ACCOUNT();
      const r = await c.query<AccountRow>('SELECT solo_team_id, terms_version, channel_connected, deleted FROM accounts WHERE pid = $1', [pid]);
      const row = r.rows[0];
      if (!row || row.deleted) return NO_ACCOUNT();
      if (row.solo_team_id !== teamId) return reject('not_your_team', 'Dieses Giveaway gehört nicht zu deinem Team.');
      if (row.terms_version !== PLATFORM_TERMS_VERSION) return reject('terms_required', 'Akzeptiere zuerst die Nutzungsbedingungen.');
      if (!row.channel_connected) return reject('channel_required', 'Verbinde zuerst deinen Kanal.');
      return null;
    },
  };
}
