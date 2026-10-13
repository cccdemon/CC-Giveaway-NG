import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { CommandContext, CommandHandler, StreamReducer } from '../../src/framework/command-bus.js';
import type { Projector } from '../../src/framework/projections.js';
import { z } from 'zod';
import { EventTypeRegistry } from '../../src/journal/event-types.js';
import type { EventRecord } from '../../src/journal/types.js';
import { reject } from '../../src/shared/rejection.js';
import { AT } from './db.js';

export const STREAM = 'giveaway:11111111-1111-4111-8111-111111111111';
export const OTHER_STREAM = 'giveaway:33333333-3333-4333-8333-333333333333';
export const ACTOR = 'user:22222222-2222-4222-8222-222222222222';

export interface CounterState { total: number }

export function testRegistry(): EventTypeRegistry {
  const r = new EventTypeRegistry();
  const by = z.object({ by: z.number().int().positive() });
  r.register({
    type: 'counter_incremented',
    version: 1,
    schema: by,
    reversal: {
      kind: 'compensate',
      inverse: (t: EventRecord, state: unknown) => {
        const amount = (t.payload as { by: number }).by;
        return rejectNegative(state as CounterState, amount) ?? { type: 'counter_decremented', payload: { by: amount } };
      },
    },
  });
  r.register({
    type: 'counter_decremented',
    version: 1,
    schema: by,
    reversal: { kind: 'compensate', inverse: (t: EventRecord) => ({ type: 'counter_incremented', payload: { by: (t.payload as { by: number }).by } }) },
  });
  r.register({
    type: 'counter_corrected',
    version: 1,
    schema: z.object({ to: z.number().int() }),
    requiresReason: true,
    reversal: { kind: 'none', why: 'Eine Korrektur hebst du mit einer neuen Korrektur auf.' },
  });
  r.register({
    type: 'note_sent',
    version: 2,
    schema: z.object({ text: z.string(), channel: z.string() }),
    upcasters: { 1: (p) => ({ ...(p as object), channel: 'unbekannt' }) },
    reversal: { kind: 'none', why: 'Eine gesendete Chatnachricht lässt sich nicht zurückholen.' },
  });
  r.register({
    type: 'thing_drawn',
    version: 1,
    schema: z.object({ winner: z.string().uuid() }),
    reversal: { kind: 'void' },
  });
  return r;
}

export function rejectNegative(state: CounterState, by: number) {
  return state.total < by ? reject('would_go_negative', 'Der Zähler würde negativ. Nimm zuerst die späteren Einträge zurück.') : null;
}

export const totalsProjector: Projector = {
  name: 'totals',
  handles: ['counter_incremented', 'counter_decremented'],
  async apply(c: pg.PoolClient, e: EventRecord) {
    const by = (e.payload as { by: number }).by * (e.type === 'counter_incremented' ? 1 : -1);
    await c.query(
      'INSERT INTO test_totals (stream, total) VALUES ($1, $2) ON CONFLICT (stream) DO UPDATE SET total = test_totals.total + $2',
      [e.stream, by],
    );
  },
  async reset(c: pg.PoolClient) {
    await c.query('DELETE FROM test_totals');
  },
};

export const counterReducer: StreamReducer<CounterState> = {
  name: 'counter',
  version: 1,
  initial: () => ({ total: 0 }),
  apply(state, e) {
    if (e.type === 'counter_incremented') return { total: state.total + (e.payload as { by: number }).by };
    if (e.type === 'counter_decremented') return { total: state.total - (e.payload as { by: number }).by };
    if (e.type === 'counter_corrected') return { total: (e.payload as { to: number }).to };
    return state;
  },
};

export interface IncrementCmd { stream: string; by: number; deny?: boolean }

export const incrementHandler: CommandHandler<IncrementCmd, CounterState> = {
  type: 'increment',
  streamOf: (cmd) => cmd.stream,
  reducer: counterReducer,
  authorize: (cmd) => (cmd.deny ? reject('forbidden', 'Du darfst diesen Zähler nicht ändern.') : null),
  decide: (state, cmd) =>
    state.total + cmd.by > 100
      ? reject('too_big', 'Der Zähler darf 100 nicht überschreiten.')
      : [{ type: 'counter_incremented', payload: { by: cmd.by } }],
};

export function ctx(over: Partial<CommandContext> = {}): CommandContext {
  return { actor: ACTOR, correlationId: randomUUID(), now: AT, ip: '10.0.0.9', ...over };
}
