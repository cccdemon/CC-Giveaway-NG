// Löschung der Zuordnung Unangemeldeter (NEW_DESIGN.md 12.4): entfernt identities-Zeilen nach unregistered_purged.
import type pg from 'pg';
import { SERVICE_EVENT_TYPES } from '../framework/giveaway/services.js';
import type { Projector } from '../framework/projections.js';
import type { EventRecord } from '../journal/types.js';

/**
 * Läuft in der Transaktion des Befehls. Beim Neuaufbau laufen alte Ereignisse erneut: Hat sich die Person inzwischen
 * angemeldet (Konto), bleibt ihre Zeile, darum prüft die Löschung weiter auf ein fehlendes Konto.
 */
export function unregisteredPurgeProjector(): Projector {
  return {
    name: 'unregistered_purge',
    handles: [SERVICE_EVENT_TYPES.unregisteredPurged],
    async apply(c: pg.PoolClient, e: EventRecord) {
      const { pids } = e.payload as { pids: string[] };
      if (pids.length === 0) return;
      await c.query('DELETE FROM identities i WHERE i.pid = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.pid = i.pid)', [pids]);
    },
    async reset() {
      // Nichts zu löschen: Die Wirkung ist das Fehlen von Zeilen.
    },
  };
}
