import type pg from 'pg';
import { withTx } from '../db/pool.js';
import type { EventTypeRegistry } from '../journal/event-types.js';
import { rowToRecord, type EventRow } from '../journal/journal.js';
import type { EventRecord } from '../journal/types.js';

export interface Projector {
  name: string;
  handles: readonly string[];
  apply(c: pg.PoolClient, e: EventRecord): Promise<void>;
  reset(c: pg.PoolClient): Promise<void>;
}

export class ProjectionRegistry {
  private readonly projectors: Projector[] = [];

  register(p: Projector): void {
    if (this.projectors.some((x) => x.name === p.name)) throw new Error(`Projektion doppelt registriert: ${p.name}`);
    this.projectors.push(p);
  }

  async applyAll(c: pg.PoolClient, events: EventRecord[]): Promise<void> {
    for (const e of events) {
      for (const p of this.projectors) {
        if (p.handles.includes(e.type)) await p.apply(c, e);
      }
    }
  }

  /**
   * Baut eine Projektion aus dem Journal neu auf. Liefert die Zahl der angewendeten Ereignisse.
   * Läuft in einer Transaktion. Live-Neuaufbau während laufender Befehle regelt Teilprojekt 2.
   */
  async rebuild(pool: pg.Pool, registry: EventTypeRegistry, name: string, batchSize = 1000): Promise<number> {
    const p = this.projectors.find((x) => x.name === name);
    if (!p) throw new Error(`Unbekannte Projektion: ${name}`);
    return withTx(pool, async (c) => {
      await p.reset(c);
      let lastId = '0';
      let applied = 0;
      for (;;) {
        const r = await c.query<EventRow>(
          `SELECT id, stream, seq, type, type_version, payload, actor, reason, reverses_event_id, correlation_id, created_at
           FROM events WHERE id > $1 AND type = ANY($2) ORDER BY id LIMIT $3`,
          [lastId, [...p.handles], batchSize],
        );
        if (r.rows.length === 0) return applied;
        for (const row of r.rows) {
          await p.apply(c, registry.upcast(rowToRecord(row)));
          applied += 1;
        }
        lastId = String(r.rows[r.rows.length - 1]!.id);
      }
    });
  }
}
