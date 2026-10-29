// Rechtstexte aus dem Profil des handelnden Streamers (Lesetabelle accounts).
import type { Queryable } from '../../db/pool.js';
import { pidOfActor } from '../../framework/authorize.js';
import type { LegalSource } from '../../framework/giveaway/open.js';
import type { LegalTexts } from '../../framework/legal.js';

export function accountLegalSource(): LegalSource {
  return {
    async profileOf(c: Queryable, actor) {
      const pid = pidOfActor(actor);
      if (pid === null) return null;
      const r = await c.query<{ legal: LegalTexts | null }>('SELECT legal FROM accounts WHERE pid = $1 AND NOT deleted', [pid]);
      return r.rows[0]?.legal ?? null;
    },
  };
}
