import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventTypeRegistry } from '../src/journal/event-types.js';
import { assertNoTwitchIdentity } from '../src/journal/guard.js';
import { JournalError, assertActor, assertStreamId, type EventRecord } from '../src/journal/types.js';
import { isRejection, reject } from '../src/shared/rejection.js';
import { testRegistry } from './helpers/fixtures.js';

const record = (over: Partial<EventRecord>): EventRecord => ({
  id: '1', stream: 'platform', seq: 1, type: 'note_sent', typeVersion: 1, payload: {}, actor: 'system:scheduler',
  reason: null, reversesEventId: null, correlationId: '00000000-0000-4000-8000-000000000000', createdAt: new Date(0), ...over,
});

describe('EventTypeRegistry', () => {
  it('prepare stamps current version and validates payload', () => {
    const p = testRegistry().prepare({ type: 'counter_incremented', payload: { by: 2 } });
    expect(p).toEqual({ type: 'counter_incremented', typeVersion: 1, payload: { by: 2 }, reason: null, reversesEventId: null });
  });

  it('prepare rejects invalid payload with code invalid_payload', () => {
    expect(() => testRegistry().prepare({ type: 'counter_incremented', payload: { by: -1 } }))
      .toThrow(expect.objectContaining({ code: 'invalid_payload' }));
  });

  it('prepare rejects unknown type', () => {
    expect(() => testRegistry().prepare({ type: 'nope', payload: {} })).toThrow(expect.objectContaining({ code: 'unknown_event_type' }));
  });

  it('prepare requires reason for requiresReason types and for reversals', () => {
    const r = testRegistry();
    expect(() => r.prepare({ type: 'counter_corrected', payload: { to: 1 } })).toThrow(expect.objectContaining({ code: 'reason_required' }));
    expect(() => r.prepare({ type: 'counter_decremented', payload: { by: 1 }, reversesEventId: '5', reason: '  ' }))
      .toThrow(expect.objectContaining({ code: 'reason_required' }));
    expect(r.prepare({ type: 'counter_corrected', payload: { to: 1 }, reason: 'Zählfehler' }).reason).toBe('Zählfehler');
  });

  it('upcast runs the chain up to the current version', () => {
    const up = testRegistry().upcast(record({ type: 'note_sent', typeVersion: 1, payload: { text: 'hi' } }));
    expect(up.typeVersion).toBe(2);
    expect(up.payload).toEqual({ text: 'hi', channel: 'unbekannt' });
  });

  it('register refuses duplicates and missing upcasters', () => {
    const r = testRegistry();
    expect(() => r.register({ type: 'note_sent', version: 1, schema: z.object({}), reversal: { kind: 'void' } })).toThrow(/doppelt/);
    expect(() => new EventTypeRegistry().register({ type: 'x', version: 3, schema: z.object({}), reversal: { kind: 'void' }, upcasters: { 1: (p) => p } }))
      .toThrow(/Upcaster fehlt: x v2→v3/);
  });
});

describe('assertNoTwitchIdentity', () => {
  it('rejects twitch identity keys at any depth', () => {
    for (const key of ['twitchId', 'twitch_id', 'login', 'userName', 'user_name', 'displayName', 'display_name', 'twitch_login']) {
      expect(() => assertNoTwitchIdentity({ entries: [{ pid: 'a', [key]: 'x' }] }), key).toThrow(JournalError);
    }
  });
  it('accepts pid-only payloads', () => {
    expect(() => assertNoTwitchIdentity({ entries: [{ pid: 'a', sek: 60 }], minute: '2026-10-15T12:00Z' })).not.toThrow();
  });
  it('prepare applies the guard', () => {
    const r = new EventTypeRegistry();
    r.register({ type: 'leaky', version: 1, schema: z.object({ login: z.string() }), reversal: { kind: 'void' } });
    expect(() => r.prepare({ type: 'leaky', payload: { login: 'bob' } })).toThrow(expect.objectContaining({ code: 'identity_in_payload' }));
  });
});

describe('ids and rejection', () => {
  it('validates stream ids and actors', () => {
    expect(() => assertStreamId('giveaway:11111111-1111-4111-8111-111111111111')).not.toThrow();
    expect(() => assertStreamId('platform')).not.toThrow();
    expect(() => assertStreamId('giveaway:abc')).toThrow(JournalError);
    expect(() => assertActor('system:scheduler')).not.toThrow();
    expect(() => assertActor('user:22222222-2222-4222-8222-222222222222')).not.toThrow();
    expect(() => assertActor('system:bot')).toThrow(JournalError);
  });
  it('reject builds a recognizable rejection', () => {
    const r = reject('x', 'y');
    expect(isRejection(r)).toBe(true);
    expect(isRejection({ code: 'x' })).toBe(false);
  });
});
