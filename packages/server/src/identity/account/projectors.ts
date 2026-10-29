// Lesetabelle accounts und Aufräumen der Twitch-Daten nach Ereignissen des Stroms account:<pid>.
import type pg from 'pg';
import { UUID_RE } from '../../framework/authorize.js';
import type { Projector, StateProjector } from '../../framework/projections.js';
import type { EventRecord, StreamId } from '../../journal/types.js';
import { deleteIdentity } from '../identities.js';
import { deleteSessionsOf } from '../sessions.js';
import { deleteChannelToken } from '../tokens.js';
import { ACCOUNT_EVENTS, pidOfStream, type AccountState } from './state.js';

export function accountsProjector(): StateProjector<AccountState> {
  return {
    name: 'accounts',
    reducer: 'account',
    async apply(c: pg.PoolClient, stream: StreamId, state: AccountState, head: { seq: number; at: Date }) {
      const pid = pidOfStream(stream);
      if (!state.exists || pid === null) return;
      await c.query(
        `INSERT INTO accounts (pid, solo_team_id, terms_version, channel_connected, legal, deleted, last_seq, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (pid) DO UPDATE SET solo_team_id = EXCLUDED.solo_team_id, terms_version = EXCLUDED.terms_version,
           channel_connected = EXCLUDED.channel_connected, legal = EXCLUDED.legal, deleted = EXCLUDED.deleted,
           last_seq = EXCLUDED.last_seq, updated_at = EXCLUDED.updated_at`,
        [pid, state.soloTeamId, state.termsVersion, state.channelConnected, JSON.stringify(state.legal), state.deleted, head.seq, head.at],
      );
    },
    async reset(c: pg.PoolClient, stream?: StreamId) {
      if (stream === undefined) await c.query('DELETE FROM accounts');
      else {
        const pid = pidOfStream(stream);
        if (pid !== null && UUID_RE.test(pid)) await c.query('DELETE FROM accounts WHERE pid = $1', [pid]);
      }
    },
  };
}

/**
 * Löschung entfernt identities, sessions und channel_tokens (NEW_DESIGN.md 12.4). Kanal trennen entfernt die Tokens.
 * Beides passiert in der Transaktion des Befehls. Beim Neuaufbau laufen alte Ereignisse erneut: Ein altes
 * channel_disconnected darf den Token einer späteren Verbindung nicht löschen, darum prüft es auf ein späteres channel_connected.
 */
export function identityCleanupProjector(): Projector {
  return {
    name: 'identity_cleanup',
    handles: [ACCOUNT_EVENTS.deleted, ACCOUNT_EVENTS.channelDisconnected],
    async apply(c: pg.PoolClient, e: EventRecord) {
      const pid = pidOfStream(e.stream);
      if (pid === null) return;
      if (e.type === ACCOUNT_EVENTS.channelDisconnected) {
        const later = await c.query('SELECT 1 FROM events WHERE stream = $1 AND seq > $2 AND type = $3 LIMIT 1', [
          e.stream, e.seq, ACCOUNT_EVENTS.channelConnected,
        ]);
        if ((later.rowCount ?? 0) > 0) return;
      }
      await deleteChannelToken(c, pid);
      if (e.type === ACCOUNT_EVENTS.deleted) {
        await deleteIdentity(c, pid);
        await deleteSessionsOf(c, pid);
      }
    },
    async reset() {
      // Nichts zu löschen: Die Wirkung ist das Fehlen von Zeilen.
    },
  };
}
