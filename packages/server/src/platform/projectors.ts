// Lesetabellen des Stroms platform: platform_bans und platform_warnings aus dem Zustand, platform_terms je Ereignis (Text steht nur dort).
import type pg from 'pg';
import type { Projector, StateProjector } from '../framework/projections.js';
import type { EventRecord, StreamId } from '../journal/types.js';
import { PLATFORM_EVENTS, type PlatformState } from './state.js';

export function platformProjector(): StateProjector<PlatformState> {
  return {
    name: 'platform',
    reducer: 'platform',
    async apply(c: pg.PoolClient, _stream: StreamId, state: PlatformState) {
      const bans = Object.entries(state.bans);
      await c.query('DELETE FROM platform_bans');
      if (bans.length > 0) {
        await c.query(
          'INSERT INTO platform_bans (pid, reason, since, event_id) SELECT * FROM unnest($1::uuid[], $2::text[], $3::timestamptz[], $4::text[])',
          [bans.map(([pid]) => pid), bans.map(([, b]) => b.reason), bans.map(([, b]) => new Date(b.since)), bans.map(([, b]) => b.eventId)],
        );
      }
      const warnings = Object.entries(state.warnings).flatMap(([pid, list]) => list.map((w) => ({ pid, ...w })));
      // Alle bekannten als zurückgenommen markieren, die aktiven dann neu setzen: zurückgenommene bleiben sichtbar.
      await c.query('UPDATE platform_warnings SET withdrawn = true WHERE NOT withdrawn');
      if (warnings.length > 0) {
        await c.query(
          `INSERT INTO platform_warnings (event_id, pid, reason, at, withdrawn)
           SELECT e, p, r, a, false FROM unnest($1::text[], $2::uuid[], $3::text[], $4::timestamptz[]) AS t(e, p, r, a)
           ON CONFLICT (event_id) DO UPDATE SET withdrawn = false`,
          [warnings.map((w) => w.eventId), warnings.map((w) => w.pid), warnings.map((w) => w.reason), warnings.map((w) => new Date(w.at))],
        );
      }
    },
    async reset(c: pg.PoolClient) {
      await c.query('DELETE FROM platform_bans');
      await c.query('DELETE FROM platform_warnings');
    },
  };
}

export function termsProjector(): Projector {
  return {
    name: 'platform_terms',
    handles: [PLATFORM_EVENTS.termsPublished],
    async apply(c: pg.PoolClient, e: EventRecord) {
      const { version, text } = e.payload as { version: number; text: string };
      await c.query('INSERT INTO platform_terms (version, text, published_at) VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING', [version, text, e.createdAt]);
    },
    async reset(c: pg.PoolClient) {
      await c.query('DELETE FROM platform_terms');
    },
  };
}
