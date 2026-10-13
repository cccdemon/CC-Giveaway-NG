import { z } from 'zod';
import { EventTypeRegistry } from '../../src/journal/event-types.js';
import type { EventRecord } from '../../src/journal/types.js';
import { reject } from '../../src/shared/rejection.js';

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
