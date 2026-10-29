// Twitch-OAuth (NEW_DESIGN.md 9.2, 10.2): Anmelde-URL, Code-Tausch, Refresh, Nutzer lesen. Kein Backoff: Der Nutzer wiederholt.
import type { TwitchUser } from './identities.js';

/** Scopes für „Kanal verbinden“ (NEW_DESIGN.md 9.2). */
export const REQUIRED_CHANNEL_SCOPES = ['moderator:read:followers', 'moderator:read:chatters', 'channel:bot'] as const;

export const ID_BASE = 'https://id.twitch.tv';
export const HELIX_BASE = 'https://api.twitch.tv/helix';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
}

export type TwitchErrorCode = 'twitch_unreachable' | 'twitch_denied' | 'twitch_invalid';

const MESSAGES: Record<TwitchErrorCode, string> = {
  twitch_unreachable: 'Twitch antwortet nicht. Versuche es gleich noch einmal.',
  twitch_denied: 'Twitch hat die Anmeldung abgelehnt. Starte die Anmeldung neu.',
  twitch_invalid: 'Twitch hat unerwartet geantwortet. Versuche es gleich noch einmal.',
};

export class TwitchError extends Error {
  constructor(readonly code: TwitchErrorCode) {
    super(MESSAGES[code]);
    this.name = 'TwitchError';
  }
}

export interface TwitchAuthClient {
  authorizeUrl(p: { redirectUri: string; scopes: readonly string[]; state: string }): string;
  exchangeCode(code: string, redirectUri: string): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  getUser(accessToken: string): Promise<TwitchUser>;
}

export interface TwitchClientOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  idBase?: string;
  helixBase?: string;
}

async function call(doFetch: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch {
    throw new TwitchError('twitch_unreachable');
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new TwitchError('twitch_denied');
  if (res.status !== 200) throw new TwitchError('twitch_invalid');
  try {
    return await res.json();
  } catch {
    throw new TwitchError('twitch_invalid');
  }
}

function toTokenSet(body: unknown): TokenSet {
  const b = body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  if (typeof b?.access_token !== 'string' || typeof b.refresh_token !== 'string' || typeof b.expires_in !== 'number') {
    throw new TwitchError('twitch_invalid');
  }
  const scopes = Array.isArray(b.scope) ? b.scope.filter((s): s is string => typeof s === 'string') : [];
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresIn: b.expires_in, scopes };
}

export function twitchAuthClient(o: TwitchClientOptions): TwitchAuthClient {
  const doFetch = o.fetch ?? fetch;
  const idBase = o.idBase ?? ID_BASE;
  const helixBase = o.helixBase ?? HELIX_BASE;

  const token = async (params: Record<string, string>): Promise<TokenSet> => {
    const body = new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, ...params });
    const res = await call(doFetch, `${idBase}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    return toTokenSet(res);
  };

  return {
    authorizeUrl(p) {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: o.clientId,
        redirect_uri: p.redirectUri,
        scope: p.scopes.join(' '),
        state: p.state,
        force_verify: 'true',
      });
      return `${idBase}/oauth2/authorize?${q.toString()}`;
    },
    exchangeCode: (code, redirectUri) => token({ code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
    refresh: (refreshToken) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    async getUser(accessToken) {
      const res = (await call(doFetch, `${helixBase}/users`, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}`, 'client-id': o.clientId },
      })) as { data?: unknown };
      const first = Array.isArray(res?.data) ? (res.data[0] as { id?: unknown; login?: unknown; display_name?: unknown } | undefined) : undefined;
      if (!first || typeof first.id !== 'string' || typeof first.login !== 'string' || typeof first.display_name !== 'string') {
        throw new TwitchError('twitch_invalid');
      }
      return { id: first.id, login: first.login, displayName: first.display_name };
    },
  };
}
