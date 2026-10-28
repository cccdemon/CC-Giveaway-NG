import type pg from 'pg';
import { logDenied } from '../audit/access-log.js';
import { withTx } from '../db/pool.js';
import type { EventTypeRegistry } from '../journal/event-types.js';
import { appendLocked, lockStream } from '../journal/journal.js';
import { ensurePartitions, isMissingPartition } from '../journal/partitions.js';
import { saveSnapshot } from '../journal/snapshots.js';
import { JournalError, type Actor, type EventRecord, type NewEvent, type StreamId } from '../journal/types.js';
import { isRejection, type Rejection } from '../shared/rejection.js';
import type { ProjectionRegistry } from './projections.js';
import type { Publisher } from './publisher.js';
import { loadStreamState } from './state.js';

/** Rein und unveränderlich: apply liefert ein neues Objekt. S muss JSON-serialisierbar sein (Snapshots). */
export interface StreamReducer<S> {
  name: string;
  version: number;
  initial(): S;
  apply(state: S, e: EventRecord): S;
}

export interface CommandContext {
  actor: Actor;
  correlationId: string;
  now: Date;
  ip?: string | null;
}

export interface CommandHandler<C, S, P = undefined> {
  type: string;
  streamOf(cmd: C): StreamId;
  reducer: StreamReducer<S>;
  /** In der Transaktion, VOR der Stromsperre. Darf lesen. */
  authorize(cmd: C, ctx: CommandContext, c: pg.PoolClient): Rejection | null | Promise<Rejection | null>;
  /** Läuft nach der Stromsperre in derselben Transaktion. Für Daten, die nicht im Reducer-Zustand stehen. */
  prepare?(c: pg.PoolClient, cmd: C, ctx: CommandContext): Promise<P>;
  decide(state: S, cmd: C, ctx: CommandContext, prepared: P): NewEvent[] | Rejection;
}

export type CommandResult = { ok: true; events: EventRecord[] } | { ok: false; rejection: Rejection };

export interface BusLogger {
  error(obj: object, msg: string): void;
}

export interface CommandBusDeps {
  pool: pg.Pool;
  registry: EventTypeRegistry;
  projections: ProjectionRegistry;
  publisher: Publisher;
  log: BusLogger;
  snapshotEvery?: number;
}

export const SNAPSHOT_EVERY = 1000;
const RETRYABLE_SQLSTATE = new Set(['40001', '40P01']);

/** Trägt eine Ablehnung aus withTx heraus, damit die Transaktion zurückrollt. Nur in dieser Datei. */
class RejectionSignal extends Error {
  constructor(readonly rejection: Rejection) {
    super(rejection.code);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CommandBus {
  constructor(private readonly d: CommandBusDeps) {}

  async execute<C, S, P>(h: CommandHandler<C, S, P>, cmd: C, ctx: CommandContext): Promise<CommandResult> {
    if (!UUID_RE.test(ctx.correlationId)) {
      throw new TypeError(`Die correlationId "${ctx.correlationId}" ist keine UUID. Erzeuge sie mit randomUUID().`);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await withTx(this.d.pool, (c) => this.runOnce(h, cmd, ctx, c));
        if (out.length > 0) await this.publishSafe(h.streamOf(cmd), out);
        return { ok: true, events: out };
      } catch (e) {
        // Zuerst: Eine Ablehnung wird nie wiederholt. Der Rollback ist schon passiert, deny schreibt über eine eigene Verbindung.
        if (e instanceof RejectionSignal) return this.deny(h, cmd, ctx, e.rejection);
        if (attempt === 0 && isMissingPartition(e)) {
          await ensurePartitions(this.d.pool, ctx.now, 2);
          continue;
        }
        if (attempt === 0 && (RETRYABLE_SQLSTATE.has((e as { code?: string }).code ?? '') || (e instanceof JournalError && e.code === 'seq_conflict'))) continue;
        throw e;
      }
    }
  }

  async loadState<S>(c: pg.PoolClient, stream: StreamId, reducer: StreamReducer<S>): Promise<S> {
    return loadStreamState(c, this.d.registry, stream, reducer);
  }

  private async runOnce<C, S, P>(h: CommandHandler<C, S, P>, cmd: C, ctx: CommandContext, c: pg.PoolClient): Promise<EventRecord[]> {
    const denied = await h.authorize(cmd, ctx, c);
    if (denied) throw new RejectionSignal(denied);
    const stream = h.streamOf(cmd);
    const lastSeq = await lockStream(c, stream);
    const state = await this.loadState(c, stream, h.reducer);
    const prepared = h.prepare ? await h.prepare(c, cmd, ctx) : (undefined as P);
    const decided = h.decide(state, cmd, ctx, prepared);
    if (isRejection(decided)) throw new RejectionSignal(decided);
    const events = await appendLocked(c, this.d.registry, {
      stream, lastSeq, events: decided, actor: ctx.actor, correlationId: ctx.correlationId, at: ctx.now,
    });
    if (events.length === 0) return events;
    const next = events.reduce<S>((s, e) => h.reducer.apply(s, e), state);
    await this.d.projections.applyAll(c, events);
    await this.d.projections.applyState(c, stream, h.reducer.name, next, { seq: lastSeq + events.length, at: ctx.now });
    await this.maybeSnapshot(c, stream, h.reducer, next, lastSeq, lastSeq + events.length, ctx.now);
    return events;
  }

  private async maybeSnapshot<S>(c: pg.PoolClient, stream: StreamId, reducer: StreamReducer<S>, next: S, lastSeq: number, newSeq: number, now: Date) {
    const every = this.d.snapshotEvery ?? SNAPSHOT_EVERY;
    if (Math.floor(lastSeq / every) === Math.floor(newSeq / every)) return;
    await saveSnapshot(c, stream, reducer, newSeq, next, now);
  }

  private async deny<C, S, P>(h: CommandHandler<C, S, P>, cmd: C, ctx: CommandContext, rejection: Rejection): Promise<CommandResult> {
    let target: string | null = null;
    try {
      target = h.streamOf(cmd);
    } catch {
      target = null;
    }
    try {
      await logDenied(this.d.pool, { actor: ctx.actor, action: h.type, reason: rejection.code, target, ip: ctx.ip ?? null, at: ctx.now });
    } catch (err) {
      this.d.log.error({ err, action: h.type, target }, 'Die Ablehnung konnte nicht protokolliert werden. Der Grund wird trotzdem gemeldet.');
    }
    return { ok: false, rejection };
  }

  private async publishSafe(stream: StreamId, events: EventRecord[]): Promise<void> {
    try {
      await this.d.publisher.publish(stream, events);
    } catch (err) {
      this.d.log.error({ err, stream }, 'Der Push an die Oberflächen ist fehlgeschlagen. Der Befehl ist gespeichert.');
    }
  }
}
