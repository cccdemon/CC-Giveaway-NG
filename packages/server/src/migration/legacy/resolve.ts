// Logins des Altsystems zu Twitch-Nutzern (NEW_DESIGN.md 15.6): Helix Get Users mit App-Token, 100 je Aufruf.
// Umbenannte oder gelöschte Logins fehlen in der Antwort und kommen in den Bericht.
import type { TwitchUser } from '../../identity/identities.js';
import type { HelixClient } from '../../ingest/twitch/helix.js';

export interface LoginResolver {
  /** Login (klein) → Nutzer. Unbekannte Logins fehlen. Wirft, wenn Twitch nach Wiederholungen nicht antwortet. */
  byLogin(logins: string[]): Promise<Map<string, TwitchUser>>;
}

export const LOGINS_PER_CALL = 100;

export function helixLoginResolver(helix: Pick<HelixClient, 'getUsersByLogin'>): LoginResolver {
  return {
    async byLogin(logins) {
      const unique = [...new Set(logins.map((l) => l.toLowerCase()))];
      const out = new Map<string, TwitchUser>();
      for (let i = 0; i < unique.length; i += LOGINS_PER_CALL) {
        const users = await helix.getUsersByLogin(unique.slice(i, i + LOGINS_PER_CALL));
        for (const u of users) out.set(u.login.toLowerCase(), { id: u.id, login: u.login.toLowerCase(), displayName: u.displayName });
      }
      return out;
    },
  };
}
