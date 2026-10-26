import { afterEach, describe, expect, it } from 'vitest';
import { CommandBus, type CommandHandler } from '../src/framework/command-bus.js';
import { ProjectionRegistry } from '../src/framework/projections.js';
import { InMemoryPublisher } from '../src/framework/publisher.js';
import { EVENT_VOIDED, makeRevertHandler, registerRevertTypes } from '../src/framework/revert.js';
import { readStream } from '../src/journal/journal.js';
import { reject } from '../src/shared/rejection.js';
import { freshDb } from './helpers/db.js';
import { OTHER_STREAM, STREAM, counterReducer, ctx, incrementHandler, testRegistry, type CounterState } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

const registry = testRegistry();
registerRevertTypes(registry);

const allow = () => null;
const revert = makeRevertHandler(counterReducer, registry, allow);

function emit(type: string, payload: unknown, reason?: string): CommandHandler<{ stream: string }, CounterState> {
  return { type: `emit_${type}`, streamOf: (c) => c.stream, reducer: counterReducer, authorize: allow, decide: () => [{ type, payload, reason }] };
}

async function setup() {
  const db = await freshDb();
  close = db.close;
  const bus = new CommandBus({ pool: db.pool, registry, projections: new ProjectionRegistry(), publisher: new InMemoryPublisher(), log: { error: () => undefined } });
  return { pool: db.pool, bus };
}

async function firstId(bus: CommandBus, h: CommandHandler<{ stream: string }, CounterState>, stream = STREAM) {
  const r = await bus.execute(h, { stream }, ctx());
  if (!r.ok) throw new Error('setup failed');
  return r.events[0]!.id;
}

describe('revert', () => {
  it('compensate writes the inverse event with reason and link', async () => {
    const { pool, bus } = await setup();
    const r1 = await bus.execute(incrementHandler, { stream: STREAM, by: 4 }, ctx());
    const id = r1.ok ? r1.events[0]!.id : '';
    const res = await bus.execute(revert, { stream: STREAM, eventId: id, reason: '  Falscher Kanal ' }, ctx());
    expect(res.ok).toBe(true);
    const events = await readStream(pool, registry, STREAM);
    expect(events[1]).toMatchObject({ type: 'counter_decremented', payload: { by: 4 }, reason: 'Falscher Kanal', reversesEventId: id });
    expect(events.reduce(counterReducer.apply, counterReducer.initial())).toEqual({ total: 0 });
  });

  it('a reversal can itself be reverted', async () => {
    const { pool, bus } = await setup();
    const r1 = await bus.execute(incrementHandler, { stream: STREAM, by: 4 }, ctx());
    const r2 = await bus.execute(revert, { stream: STREAM, eventId: r1.ok ? r1.events[0]!.id : '', reason: 'a' }, ctx());
    const r3 = await bus.execute(revert, { stream: STREAM, eventId: r2.ok ? r2.events[0]!.id : '', reason: 'b' }, ctx());
    expect(r3.ok).toBe(true);
    expect((await readStream(pool, registry, STREAM)).reduce(counterReducer.apply, counterReducer.initial())).toEqual({ total: 4 });
  });

  it('void writes event_voided', async () => {
    const { pool, bus } = await setup();
    const id = await firstId(bus, emit('thing_drawn', { winner: '44444444-4444-4444-8444-444444444444' }));
    const res = await bus.execute(revert, { stream: STREAM, eventId: id, reason: 'Gewinner meldet sich nicht' }, ctx());
    expect(res.ok).toBe(true);
    const last = (await readStream(pool, registry, STREAM)).at(-1)!;
    expect(last).toMatchObject({ type: EVENT_VOIDED, payload: { targetType: 'thing_drawn' }, reversesEventId: id });
  });

  it('rejects: none, twice, unknown, foreign stream, missing reason', async () => {
    const { pool, bus } = await setup();
    const note = await firstId(bus, emit('note_sent', { text: 'x', channel: 'y' }));
    const inc = (await bus.execute(incrementHandler, { stream: STREAM, by: 1 }, ctx()));
    const incId = inc.ok ? inc.events[0]!.id : '';
    const foreign = await firstId(bus, emit('note_sent', { text: 'x', channel: 'y' }), OTHER_STREAM);
    await bus.execute(revert, { stream: STREAM, eventId: incId, reason: 'ok' }, ctx());
    const codes = [];
    for (const cmd of [
      { eventId: note, reason: 'r' },
      { eventId: incId, reason: 'r' },
      { eventId: '987654', reason: 'r' },
      { eventId: '99999999999999999999', reason: 'r' },
      { eventId: foreign, reason: 'r' },
      { eventId: incId, reason: '  ' },
      { eventId: incId, reason: 7 as unknown as string },
    ]) {
      const r = await bus.execute(revert, { stream: STREAM, ...cmd }, ctx());
      codes.push(r.ok ? 'ok' : r.rejection.code);
    }
    expect(codes).toEqual(['not_reversible', 'already_reverted', 'event_not_found', 'event_not_found', 'event_not_found', 'reason_required', 'reason_required']);
    const after = (await readStream(pool, registry, STREAM)).length;
    expect(after).toBe(3);
  });

  it('none rejection carries the reason text from the event type', async () => {
    const { bus } = await setup();
    const note = await firstId(bus, emit('note_sent', { text: 'x', channel: 'y' }));
    const r = await bus.execute(revert, { stream: STREAM, eventId: note, reason: 'r' }, ctx());
    expect(r.ok ? '' : r.rejection.message).toBe('Eine gesendete Chatnachricht lässt sich nicht zurückholen.');
  });

  it('inverse may reject based on current state', async () => {
    const { pool, bus } = await setup();
    const r1 = await bus.execute(incrementHandler, { stream: STREAM, by: 4 }, ctx());
    await bus.execute(emit('counter_corrected', { to: 1 }, 'Zählfehler'), { stream: STREAM }, ctx());
    const r = await bus.execute(revert, { stream: STREAM, eventId: r1.ok ? r1.events[0]!.id : '', reason: 'r' }, ctx());
    expect(r.ok ? '' : r.rejection.code).toBe('would_go_negative');
    expect(r.ok ? '' : r.rejection.message).toBe('Der Zähler würde negativ. Nimm zuerst die späteren Einträge zurück.');
    expect(await readStream(pool, registry, STREAM)).toHaveLength(2);
  });

  it('authorize is applied', async () => {
    const { bus } = await setup();
    const denyAll = makeRevertHandler(counterReducer, registry, () => reject('forbidden', 'Du darfst nichts zurücknehmen.'));
    const r = await bus.execute(denyAll, { stream: STREAM, eventId: '1', reason: 'r' }, ctx());
    expect(r.ok ? '' : r.rejection.code).toBe('forbidden');
  });
});
