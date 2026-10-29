// Rechte-Schnittstelle für Giveaway-Befehle. Die Umsetzung auf Basis der Konten liegt in identity/account/authorizer.ts.
import type pg from 'pg';
import type { Actor } from '../../journal/types.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import { UUID_RE } from '../authorize.js';
import type { CommandContext } from '../command-bus.js';
import type { GiveawayStatus } from './state.js';

export { INVALID_ID, UUID_RE, authorizeSelf } from '../authorize.js';

export interface GiveawayAuthorizer {
  controls(c: pg.PoolClient, actor: Actor, teamId: string): Promise<Rejection | null>;
}

export const allowAll: GiveawayAuthorizer = {
  controls: async () => null,
};

/** Nur Systembefehle, z. B. im Scheduler-Prozess. Nutzerbefehle laufen über die app mit accountAuthorizer. */
export const denyUsers: GiveawayAuthorizer = {
  controls: async (_c, actor) =>
    actor.startsWith('system:') ? null : reject('no_accounts', 'Dieser Prozess nimmt keine Nutzerbefehle an. Nutze die App.'),
};

export interface GiveawayRow {
  id: string;
  teamId: string;
  kernel: string;
  status: GiveawayStatus;
}

/** Liest die Lesetabelle `giveaways`. Keine UUID oder keine Zeile → null. */
export async function loadGiveawayRow(c: pg.PoolClient, giveawayId: string): Promise<GiveawayRow | null> {
  if (!UUID_RE.test(giveawayId)) return null;
  const r = await c.query<{ id: string; team_id: string; kernel: string; status: GiveawayStatus }>(
    'SELECT id, team_id, kernel, status FROM giveaways WHERE id = $1',
    [giveawayId],
  );
  const row = r.rows[0];
  return row ? { id: row.id, teamId: row.team_id, kernel: row.kernel, status: row.status } : null;
}

export const GIVEAWAY_NOT_FOUND = (): Rejection => reject('giveaway_not_found', 'Dieses Giveaway gibt es nicht.');

export function authorizeControl(
  auth: GiveawayAuthorizer,
): (cmd: { giveawayId: string }, ctx: CommandContext, c: pg.PoolClient) => Promise<Rejection | null> {
  return async (cmd, ctx, c) => {
    const row = await loadGiveawayRow(c, cmd.giveawayId);
    if (!row) return GIVEAWAY_NOT_FOUND();
    return auth.controls(c, ctx.actor, row.teamId);
  };
}
