import type pg from 'pg';
import { logDenied } from '../audit/access-log.js';
import { withTx } from '../db/pool.js';
import type { EventTypeRegistry } from '../journal/event-types.js';
import { appendLocked, lockStream, readStream } from '../journal/journal.js';
import { ensurePartitions, isMissingPartition } from '../journal/partitions.js';
import { loadSnapshot, saveSnapshot } from '../journal/snapshots.js';
import { JournalError, type Actor, type EventRecord, type NewEvent, type StreamId } from '../journal/types.js';
import { isRejection, type Rejection } from '../shared/rejection.js';
import type { ProjectionRegistry } from './projections.js';
import type { Publisher } from './publisher.js';

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
  authorize(cmd: C, ctx: CommandContext): Rejection | null;
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

export class CommandBus {
  constructor(private readonly d: CommandBusDeps) {}

  async execute<C, S, P>(h: CommandHandler<C, S, P>, cmd: C, ctx: CommandContext): Promise<CommandResult> {
    const denied = h.authorize(cmd, ctx);
    if (denied) return this.deny(h, cmd, ctx, denied);
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await withTx(this.d.pool, (c) => this.runOnce(h, cmd, ctx, c));
        if (isRejection(out)) return this.deny(h, cmd, ctx, out);
        if (out.length > 0) await this.publishSafe(h.streamOf(cmd), out);
        return { ok: true, events: out };
      } catch (e) {
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
    const snap = await loadSnapshot<S>(c, stream, reducer);
    let state = snap ? snap.state : reducer.initial();
    for (const e of await readStream(c, this.d.registry, stream, snap?.seq ?? 0)) state = reducer.apply(state, e);
    return state;
  }

  private async runOnce<C, S, P>(h: CommandHandler<C, S, P>, cmd: C, ctx: CommandContext, c: pg.PoolClient): Promise<EventRecord[] | Rejection> {
    const stream = h.streamOf(cmd);
    const lastSeq = await lockStream(c, stream);
    const state = await this.loadState(c, stream, h.reducer);
    const prepared = h.prepare ? await h.prepare(c, cmd, ctx) : (undefined as P);
    const decided = h.decide(state, cmd, ctx, prepared);
    if (isRejection(decided)) return decided;
    const events = await appendLocked(c, this.d.registry, {
      stream, lastSeq, events: decided, actor: ctx.actor, correlationId: ctx.correlationId, at: ctx.now,
    });
    await this.d.projections.applyAll(c, events);
    await this.maybeSnapshot(c, stream, h.reducer, state, events, lastSeq, ctx.now);
    return events;
  }

  private async maybeSnapshot<S>(c: pg.PoolClient, stream: StreamId, reducer: StreamReducer<S>, state: S, events: EventRecord[], lastSeq: number, now: Date) {
    const every = this.d.snapshotEvery ?? SNAPSHOT_EVERY;
    const newSeq = lastSeq + events.length;
    if (Math.floor(lastSeq / every) === Math.floor(newSeq / every)) return;
    const next = events.reduce(reducer.apply, state);
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
