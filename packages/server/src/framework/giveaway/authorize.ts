// Rechte-Schnittstelle für Giveaway-Befehle. Konten kommen erst in Teilprojekt 3.
import type pg from 'pg';
import type { Actor } from '../../journal/types.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import type { CommandContext } from '../command-bus.js';
import type { GiveawayStatus } from './state.js';

export interface GiveawayAuthorizer {
  controls(c: pg.PoolClient, actor: Actor, teamId: string): Promise<Rejection | null>;
}

export const allowAll: GiveawayAuthorizer = {
  controls: async () => null,
};

export const denyUsers: GiveawayAuthorizer = {
  controls: async (_c, actor) =>
    actor.startsWith('system:')
      ? null
      : reject('no_accounts', 'Konten gibt es noch nicht. Dieser Befehl ist erst ab Teilprojekt 3 möglich.'),
};

export interface GiveawayRow {
  id: string;
  teamId: string;
  kernel: string;
  status: GiveawayStatus;
}

/** Wie z.uuid() im Ereignisschema: Version 1–8, Variante 8–b. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
