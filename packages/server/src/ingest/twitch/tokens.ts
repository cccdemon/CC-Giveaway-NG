// Kanal-Tokens der Streamer für den Ingest (NEW_DESIGN.md 10.2): automatischer Refresh, Fehlschlag → Token invalid → Kanal rot.
import type pg from 'pg';
import type { BusLogger } from '../../framework/command-bus.js';
import { loadChannelToken, markTokenInvalid, updateChannelToken } from '../../identity/tokens.js';
import { TwitchError, type TwitchAuthClient } from '../../identity/twitch.js';
import type { Pid } from '../../kernel-api/index.js';

export const TOKEN_REFRESH_BEFORE_SEC = 300;

export interface ChannelTokenProvider {
  /** Gültiges Access-Token oder null (kein Token, ungültig, Refresh abgelehnt). */
  accessTokenFor(pid: Pid): Promise<string | null>;
  invalidate(pid: Pid): Promise<void>;
}

export function channelTokenProvider(o: { pool: pg.Pool; key: Buffer; auth: TwitchAuthClient; now: () => Date; log: BusLogger }): ChannelTokenProvider {
  const refreshing = new Map<Pid, Promise<string | null>>();

  async function refresh(pid: Pid, refreshToken: string, stillValidUntil: Date): Promise<string | null> {
    const now = o.now();
    try {
      const t = await o.auth.refresh(refreshToken);
      await updateChannelToken(o.pool, pid, { accessToken: t.accessToken, refreshToken: t.refreshToken, scopes: t.scopes, expiresAt: new Date(now.getTime() + t.expiresIn * 1000) }, o.key, now);
      return t.accessToken;
    } catch (e) {
      if (e instanceof TwitchError && e.code === 'twitch_denied') {
        await markTokenInvalid(o.pool, pid, now);
        o.log.error({ pid, code: e.code }, 'Twitch hat den Token-Refresh abgelehnt. Der Kanal ist rot, bis der Streamer ihn neu verbindet.');
        return null;
      }
      o.log.error({ err: e, pid }, 'Der Token-Refresh ist fehlgeschlagen. Das alte Token gilt, solange es nicht abgelaufen ist.');
      return stillValidUntil.getTime() > now.getTime() ? 'keep' : null;
    }
  }

  return {
    async accessTokenFor(pid) {
      const t = await loadChannelToken(o.pool, pid, o.key);
      if (!t || t.status !== 'ok') return null;
      const now = o.now();
      if (t.expiresAt.getTime() - now.getTime() > TOKEN_REFRESH_BEFORE_SEC * 1000) return t.accessToken;
      let p = refreshing.get(pid);
      if (!p) {
        p = refresh(pid, t.refreshToken, t.expiresAt).finally(() => {
          refreshing.delete(pid);
        });
        refreshing.set(pid, p);
      }
      const out = await p;
      return out === 'keep' ? t.accessToken : out;
    },
    async invalidate(pid) {
      await markTokenInvalid(o.pool, pid, o.now());
    },
  };
}
