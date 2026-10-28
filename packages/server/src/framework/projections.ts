import type pg from 'pg';
import { withTx } from '../db/pool.js';
import type { EventTypeRegistry } from '../journal/event-types.js';
import { rowToRecord, type EventRow } from '../journal/journal.js';
import type { EventRecord, StreamId } from '../journal/types.js';
import type { StreamReducer } from './command-bus.js';
import { loadStreamState } from './state.js';

export interface Projector {
  name: string;
  handles: readonly string[];
  apply(c: pg.PoolClient, e: EventRecord): Promise<void>;
  /** Ohne stream: alles löschen. Mit stream: nur diesen Strom. */
  reset(c: pg.PoolClient, stream?: StreamId): Promise<void>;
}

/** Bekommt nach jedem Befehl den Zustand des Stroms, nicht die einzelnen Ereignisse. */
export interface StateProjector<S> {
  name: string;
  /** StreamReducer.name, auf den er hört. */
  reducer: string;
  apply(c: pg.PoolClient, stream: StreamId, state: S, head: { seq: number; at: Date }): Promise<void>;
  reset(c: pg.PoolClient, stream?: StreamId): Promise<void>;
}

export class ProjectionRegistry {
  private readonly projectors: Projector[] = [];
  private readonly stateProjectors: StateProjector<unknown>[] = [];

  register(p: Projector): void {
    this.assertNewName(p.name);
    this.projectors.push(p);
  }

  registerState<S>(p: StateProjector<S>): void {
    this.assertNewName(p.name);
    this.stateProjectors.push(p as StateProjector<unknown>);
  }

  private assertNewName(name: string): void {
    if (this.projectors.some((x) => x.name === name) || this.stateProjectors.some((x) => x.name === name)) {
      throw new Error(`Projektion doppelt registriert: ${name}`);
    }
  }

  async applyAll(c: pg.PoolClient, events: EventRecord[]): Promise<void> {
    for (const e of events) {
      for (const p of this.projectors) {
        if (p.handles.includes(e.type)) await p.apply(c, e);
      }
    }
  }

  /** Ruft nur die StateProjector, die auf diesen Reducer hören. */
  async applyState<S>(c: pg.PoolClient, stream: StreamId, reducerName: string, state: S, head: { seq: number; at: Date }): Promise<void> {
    for (const p of this.stateProjectors) {
      if (p.reducer === reducerName) await p.apply(c, stream, state, head);
    }
  }

  /**
   * Baut alle StateProjector des Reducers für einen Strom neu auf. Andere Ströme bleiben unberührt.
   * Läuft in einer Transaktion und sperrt die Kopfzeile des Stroms, falls es sie gibt.
   */
  async rebuildStream<S>(pool: pg.Pool, registry: EventTypeRegistry, stream: StreamId, reducer: StreamReducer<S>): Promise<void> {
    const targets = this.stateProjectors.filter((p) => p.reducer === reducer.name);
    await withTx(pool, async (c) => {
      // FOR UPDATE ohne INSERT: wartet auf laufende Befehle, legt aber keine Kopfzeile für unbekannte Ströme an.
      await c.query('SELECT 1 FROM stream_heads WHERE stream = $1 FOR UPDATE', [stream]);
      const state = await loadStreamState(c, registry, stream, reducer);
      const last = await c.query<{ seq: number; created_at: Date }>(
        'SELECT seq, created_at FROM events WHERE stream = $1 ORDER BY seq DESC LIMIT 1',
        [stream],
      );
      // Leerer Strom: seq 0 und Zeitpunkt new Date(0), weil es kein Ereignis mit Zeitpunkt gibt.
      const head = { seq: last.rows[0]?.seq ?? 0, at: last.rows[0]?.created_at ?? new Date(0) };
      for (const p of targets) {
        await p.reset(c, stream);
        await p.apply(c, stream, state, head);
      }
    });
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
