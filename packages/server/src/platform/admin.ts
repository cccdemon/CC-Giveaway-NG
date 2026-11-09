// Superadmin (NEW_DESIGN.md 11.4): eine Person, deren Twitch-ID in ADMIN_TWITCH_IDS steht. Admin-Handlungen tragen den Akteur der Person.
import type { Queryable } from '../db/pool.js';
import { pidOfActor } from '../framework/authorize.js';
import type { CommandContext } from '../framework/command-bus.js';
import { reject, type Rejection } from '../shared/rejection.js';

export interface AdminCheck {
  isAdmin(c: Queryable, pid: string): Promise<boolean>;
}

/** Admins über identities: die Twitch-ID der Person steht in der Liste. */
export function twitchIdAdmins(ids: readonly string[]): AdminCheck {
  const list = [...ids];
  return {
    async isAdmin(c, pid) {
      if (list.length === 0) return false;
      const r = await c.query('SELECT 1 FROM identities WHERE pid = $1 AND twitch_id = ANY($2::text[]) LIMIT 1', [pid, list]);
      return (r.rowCount ?? 0) > 0;
    },
  };
}

export const noAdmins: AdminCheck = { isAdmin: async () => false };
export const allAdmins: AdminCheck = { isAdmin: async () => true };

export const NOT_ADMIN = (): Rejection => reject('not_admin', 'Diese Aktion ist dem Betreiber vorbehalten.');

/** authorize für Plattform-Befehle: nur eine Person, die Admin ist. System-Akteure dürfen nicht, Admin-Handlungen sind Personen zuzuordnen. */
export function authorizeAdmin(check: AdminCheck): (cmd: unknown, ctx: CommandContext, c: Queryable) => Promise<Rejection | null> {
  return async (_cmd, ctx, c) => {
    const pid = pidOfActor(ctx.actor);
    if (pid === null) return NOT_ADMIN();
    return (await check.isAdmin(c, pid)) ? null : NOT_ADMIN();
  };
}
