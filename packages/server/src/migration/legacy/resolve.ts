// Logins und Twitch-IDs des Altsystems zu Twitch-Nutzern (NEW_DESIGN.md 15.6): Helix Get Users mit App-Token, 100 je Aufruf.
// Umbenannte oder gelöschte Logins fehlen in der Antwort und kommen in den Bericht. Mitglieder mit bekannter Twitch-ID
// löst der Lauf über die ID auf: ein freigegebener Login kann sonst einer fremden Person gehören.
import type { TwitchUser } from '../../identity/identities.js';
import type { HelixClient } from '../../ingest/twitch/helix.js';

export interface LoginResolver {
  /** Login (klein) → Nutzer. Unbekannte Logins fehlen. Wirft, wenn Twitch nach Wiederholungen nicht antwortet. */
  byLogin(logins: string[]): Promise<Map<string, TwitchUser>>;
  /** Twitch-ID → Nutzer. Unbekannte IDs fehlen. */
  byId(ids: string[]): Promise<Map<string, TwitchUser>>;
}

export const LOGINS_PER_CALL = 100;

export function helixLoginResolver(helix: Pick<HelixClient, 'getUsersByLogin' | 'getUsers'>): LoginResolver {
  const fetchAll = async (values: string[], get: (chunk: string[]) => ReturnType<HelixClient['getUsers']>, keyOf: (u: TwitchUser) => string) => {
    const unique = [...new Set(values)];
    const out = new Map<string, TwitchUser>();
    for (let i = 0; i < unique.length; i += LOGINS_PER_CALL) {
      const users = await get(unique.slice(i, i + LOGINS_PER_CALL));
      for (const u of users) {
        const user = { id: u.id, login: u.login.toLowerCase(), displayName: u.displayName };
        out.set(keyOf(user), user);
      }
    }
    return out;
  };
  return {
    byLogin: (logins) => fetchAll(logins.map((l) => l.toLowerCase()), (chunk) => helix.getUsersByLogin(chunk), (u) => u.login),
    byId: (ids) => fetchAll(ids, (chunk) => helix.getUsers(chunk), (u) => u.id),
  };
}
