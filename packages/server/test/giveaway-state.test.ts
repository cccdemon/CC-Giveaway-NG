import { describe, expect, it } from 'vitest';
import { defaultKernels } from '../src/framework/kernel-registry.js';
import { EVENT_VOIDED } from '../src/framework/revert.js';
import { registerGiveawayEvents } from '../src/framework/giveaway/events.js';
import {
  GIVEAWAY_EVENTS,
  TRANSITIONS,
  giveawayStream,
  makeGiveawayReducer,
  toKernelEvent,
  type GiveawayState,
} from '../src/framework/giveaway/state.js';
import { EventTypeRegistry } from '../src/journal/event-types.js';
import { JournalError, type EventRecord } from '../src/journal/types.js';
import { INSTANT_EVENTS, type InstantState } from '../src/kernels/instant/index.js';
import type { WatchtimeState } from '../src/kernels/watchtime/index.js';
import { SERVICE_DEFAULTS, SERVICE_EVENT_TYPES, boostFactor } from '../src/framework/giveaway/services.js';
import { FRAMEWORK_EVENTS } from '../src/kernel-api/index.js';
import { isRejection } from '../src/shared/rejection.js';
import { kernelsWithPlain } from './helpers/plain-kernel.js';

const GID = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const P2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const P3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const AT = new Date('2026-10-28T12:00:00.000Z');

function rec(seq: number, type: string, payload: unknown, over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: String(seq),
    stream: giveawayStream(GID),
    seq,
    type,
    typeVersion: 1,
    payload,
    actor: 'user:44444444-4444-4444-8444-444444444444',
    reason: null,
    reversesEventId: null,
    correlationId: '55555555-5555-4555-8555-555555555555',
    createdAt: AT,
    ...over,
  };
}

const legacySettings = {
  config: { windowSec: 120 },
  prize: 'Spiel-Schlüssel',
  sponsor: null,
  channels: [CH],
  winnersCount: 1,
  claimDays: 14,
  gates: [],
};
const settings = { ...legacySettings, legal: null, ...SERVICE_DEFAULTS };
const MINUTE = '2026-10-28T12:00:00.000Z';

const created = (seq = 1, kernelId = 'instant') =>
  rec(seq, GIVEAWAY_EVENTS.created, { teamId: TEAM, kernelId, kernelVersion: 1, settings: { ...settings, config: kernelId === 'instant' ? settings.config : {} } }, { typeVersion: 2 });
const credited = (seq: number, entries: { pid: string; sec: number }[], channel = CH, factor = 1) =>
  rec(seq, FRAMEWORK_EVENTS.watchCredited, { minute: MINUTE, channel, factor, entries });
const chatCredited = (seq: number, entries: { pid: string; sec: number; lastAt: string }[], channel = CH, factor = 1) =>
  rec(seq, FRAMEWORK_EVENTS.chatCredited, { minute: MINUTE, channel, factor, entries });
const status = (seq: number, from: string, to: string) => rec(seq, GIVEAWAY_EVENTS.statusChanged, { from, to });
const drawn = (seq: number, winners: string[]) =>
  rec(seq, GIVEAWAY_EVENTS.drawn, {
    mode: 'equal',
    winners,
    pool: winners.map((pid) => ({ pid, weight: 1 })),
    poolHash: 'abc',
    random: [0.5],
    gates: [],
    excluded: [],
  });
const voided = (seq: number, target: string) =>
  rec(seq, EVENT_VOIDED, { targetType: GIVEAWAY_EVENTS.drawn }, { reason: 'Ersatz', reversesEventId: target });

const kernels = defaultKernels();
const reducer = makeGiveawayReducer(kernels);

function reduce(events: EventRecord[]): GiveawayState {
  return events.reduce((s, e) => reducer.apply(s, e), reducer.initial());
}

describe('giveaway reducer', () => {
  it('has name and version stamp', () => {
    expect(reducer.name).toBe('giveaway');
    expect(reducer.version).toBe(kernels.versionStamp());
    expect(giveawayStream(GID)).toBe(`giveaway:${GID}`);
  });

  it('initial is an empty draft', () => {
    const s = reducer.initial();
    expect(s.exists).toBe(false);
    expect(s.status).toBe('draft');
    expect(s.registered).toEqual({});
    expect(s.draws).toEqual([]);
    expect(s.winners).toEqual({});
    expect(s.kernelState).toBeNull();
    expect(s.settings).toEqual({ config: {}, prize: '', sponsor: null, channels: [], winnersCount: 1, claimDays: 14, gates: [], legal: null, ...SERVICE_DEFAULTS });
    expect(s.seen).toEqual({});
    expect(s.watchMinutes).toEqual({});
    expect(s.chatLast).toEqual({});
    expect(s.boost).toBeNull();
    expect(s.closedAt).toBeNull();
    expect(s.purgedAt).toBeNull();
  });

  it('created sets draft and kernel initial state', () => {
    const s0 = reducer.initial();
    const s = reducer.apply(s0, created());
    expect(s).not.toBe(s0);
    expect(s0.exists).toBe(false);
    expect(s.exists).toBe(true);
    expect(s.teamId).toBe(TEAM);
    expect(s.kernelId).toBe('instant');
    expect(s.kernelVersionAtCreate).toBe(1);
    expect(s.settings).toEqual(settings);
    expect(s.status).toBe('draft');
    expect(s.kernelState).toEqual({ registered: [], window: null, windowsOpened: 0 });
  });

  it('lifecycle follows status_changed', () => {
    const seen: string[] = [];
    let s = reduce([created()]);
    seen.push(s.status);
    const steps: [string, string][] = [
      ['draft', 'open'],
      ['open', 'paused'],
      ['paused', 'open'],
      ['open', 'closed'],
    ];
    steps.forEach(([from, to], i) => {
      s = reducer.apply(s, status(i + 2, from, to));
      seen.push(s.status);
    });
    expect(seen).toEqual(['draft', 'open', 'paused', 'open', 'closed']);
  });

  it('settings_changed replaces settings', () => {
    const after = { ...settings, prize: 'Neu' };
    const s = reduce([created(), rec(2, GIVEAWAY_EVENTS.settingsChanged, { before: settings, after })]);
    expect(s.settings).toEqual(after);
  });

  it('watch_credited and chat_credited update seen, watchMinutes and chatLast', () => {
    const lastAt = '2026-10-28T12:00:30.000Z';
    const s = reduce([
      created(1, 'watchtime'),
      status(2, 'draft', 'open'),
      credited(3, [{ pid: P1, sec: 60 }]),
      chatCredited(4, [{ pid: P2, sec: 2, lastAt }]),
      credited(5, [{ pid: P1, sec: 60 }], P3),
    ]);
    expect(s.seen).toEqual({ [P1]: { since: AT.toISOString(), channels: [CH, P3] }, [P2]: { since: AT.toISOString(), channels: [CH] } });
    expect(s.watchMinutes).toEqual({ [CH]: MINUTE, [P3]: MINUTE });
    expect(s.chatLast).toEqual({ [P2]: lastAt });
    expect((s.kernelState as WatchtimeState).sec).toEqual({ [P1]: { [CH]: 60, [P3]: 60 }, [P2]: { [CH]: 2 } });
  });

  it('a credit for an already seen pid and channel keeps the seen object identical', () => {
    const s1 = reduce([created(1, 'watchtime'), status(2, 'draft', 'open'), credited(3, [{ pid: P1, sec: 60 }])]);
    const s2 = reducer.apply(s1, credited(4, [{ pid: P1, sec: 60 }]));
    expect(s2.seen).toBe(s1.seen);
    const s3 = reducer.apply(s2, credited(5, [{ pid: P2, sec: 60 }]));
    expect(s3.seen).not.toBe(s2.seen);
  });

  it('reopening after a purge clears purgedAt so new unregistered pids are purged again', () => {
    const s = reduce([created(), status(2, 'draft', 'open'), status(3, 'open', 'closed'), rec(4, SERVICE_EVENT_TYPES.unregisteredPurged, { pids: [] })]);
    expect(s.purgedAt).toBe(AT.toISOString());
    expect(reducer.apply(s, status(5, 'closed', 'open')).purgedAt).toBeNull();
    expect(reducer.apply(s, status(5, 'closed', 'cancelled')).purgedAt).toBe(AT.toISOString());
  });

  it('boost_started sets boost with eventId, boost_ended clears it, boostFactor respects until and since', () => {
    const until = '2026-10-28T12:10:00.000Z';
    const s = reduce([created(), status(2, 'draft', 'open'), rec(3, SERVICE_EVENT_TYPES.boostStarted, { factor: 3, until })]);
    expect(s.boost).toEqual({ factor: 3, since: AT.toISOString(), until, eventId: '3' });
    expect(boostFactor(s.boost, '2026-10-28T12:05:00.000Z')).toBe(3);
    expect(boostFactor(s.boost, '2026-10-28T12:00:00.000Z')).toBe(3);
    expect(boostFactor(s.boost, '2026-10-28T12:10:00.000Z')).toBe(1);
    expect(boostFactor(s.boost, '2026-10-28T11:59:00.000Z')).toBe(1);
    expect(boostFactor(null, '2026-10-28T12:05:00.000Z')).toBe(1);
    const ended = reducer.apply(s, rec(4, SERVICE_EVENT_TYPES.boostEnded, {}));
    expect(ended.boost).toBeNull();
    expect(s.boost).not.toBeNull();
  });

  it('closedAt is set on closed and cancelled, cleared on open, purgedAt on unregistered_purged', () => {
    const later = new Date('2026-10-28T13:00:00.000Z');
    const s1 = reduce([created(), status(2, 'draft', 'open'), rec(3, GIVEAWAY_EVENTS.statusChanged, { from: 'open', to: 'closed' }, { createdAt: later })]);
    expect(s1.closedAt).toBe(later.toISOString());
    const s2 = reducer.apply(s1, status(4, 'closed', 'open'));
    expect(s2.closedAt).toBeNull();
    const s3 = reducer.apply(s2, status(5, 'open', 'cancelled'));
    expect(s3.closedAt).toBe(AT.toISOString());
    const s4 = reducer.apply(s3, rec(6, SERVICE_EVENT_TYPES.unregisteredPurged, { pids: [P1] }, { createdAt: later }));
    expect(s4.purgedAt).toBe(later.toISOString());
    expect(s3.purgedAt).toBeNull();
  });

  it('a kernel only receives events of its services', () => {
    const plainReducer = makeGiveawayReducer(kernelsWithPlain());
    const base = [created(1, 'plain'), status(2, 'draft', 'open')];
    const s1 = base.reduce((s, e) => plainReducer.apply(s, e), plainReducer.initial());
    const s2 = plainReducer.apply(s1, credited(3, [{ pid: P1, sec: 60 }]));
    expect(s2.kernelState).toBe(s1.kernelState);
    expect(s2.seen[P1]).toBeDefined();
    const w = reduce([created(1, 'watchtime'), status(2, 'draft', 'open'), credited(3, [{ pid: P1, sec: 60 }], CH, 2)]);
    expect((w.kernelState as WatchtimeState).sec).toEqual({ [P1]: { [CH]: 120 } });
  });

  it('v1 created and settings_changed payloads upcast to the defaults', () => {
    const registry = new EventTypeRegistry();
    registerGiveawayEvents(registry, kernels);
    const c = registry.upcast(rec(1, GIVEAWAY_EVENTS.created, { teamId: TEAM, kernelId: 'instant', kernelVersion: 1, settings: legacySettings }));
    expect(c.typeVersion).toBe(2);
    expect((c.payload as { settings: unknown }).settings).toEqual(settings);
    const withLegal = { ...legacySettings, legal: { impressumUrl: 'https://x.example/i', terms: null, privacyUrl: null } };
    const sc = registry.upcast(rec(2, GIVEAWAY_EVENTS.settingsChanged, { before: legacySettings, after: withLegal }));
    expect(sc.payload).toEqual({ before: settings, after: { ...settings, legal: withLegal.legal } });
    expect(reducer.apply(reducer.initial(), c).settings).toEqual(settings);
  });

  it('registered and withdrawn maintain the registration list', () => {
    const s1 = reduce([created(), status(2, 'draft', 'open'), rec(3, GIVEAWAY_EVENTS.registered, { pid: P1 })]);
    expect(s1.registered).toEqual({ [P1]: { since: AT.toISOString(), eventId: '3', legalEventId: null } });
    const s2 = reducer.apply(s1, rec(4, GIVEAWAY_EVENTS.withdrawn, { pid: P1 }));
    expect(s2.registered).toEqual({});
    expect((s2.kernelState as InstantState).registered).toEqual([]);
    expect(s1.registered).toEqual({ [P1]: { since: AT.toISOString(), eventId: '3', legalEventId: null } });
  });

  it('drawn then voided falls back to closed and clears winners', () => {
    const s1 = reduce([created(), status(2, 'draft', 'closed'), drawn(3, [P1])]);
    expect(s1.status).toBe('drawn');
    expect(s1.winners).toEqual({ [P1]: 'pending' });
    expect(s1.draws).toEqual([{ eventId: '3', winners: [P1], excluded: [], voided: false }]);
    const s2 = reducer.apply(s1, voided(4, '3'));
    expect(s2.status).toBe('closed');
    expect(s2.winners).toEqual({});
    expect(s2.draws[0]?.voided).toBe(true);
    expect(s1.draws[0]?.voided).toBe(false);
  });

  it('replacement draw keeps winner statuses of kept winners', () => {
    const s = reduce([
      created(),
      status(2, 'draft', 'closed'),
      drawn(3, [P1, P2]),
      rec(4, GIVEAWAY_EVENTS.winnerStatusSet, { pid: P1, from: 'pending', to: 'done' }),
      drawn(5, [P1, P3]),
      voided(6, '3'),
    ]);
    expect(s.winners).toEqual({ [P1]: 'done', [P3]: 'pending' });
    expect(s.status).toBe('drawn');
  });

  it('voiding one of two valid draws keeps status drawn', () => {
    const s = reduce([created(), status(2, 'draft', 'closed'), drawn(3, [P1]), drawn(4, [P2]), voided(5, '3')]);
    expect(s.status).toBe('drawn');
    expect(s.winners).toEqual({ [P2]: 'pending' });
  });

  it('unrelated event_voided leaves state unchanged', () => {
    const s1 = reduce([created(), status(2, 'draft', 'closed'), drawn(3, [P1])]);
    const s2 = reducer.apply(s1, voided(4, '2'));
    expect(s2).toEqual(s1);
  });

  it('kernel sees registration and own events only', () => {
    const s1 = reduce([created(), status(2, 'draft', 'open'), rec(3, GIVEAWAY_EVENTS.registered, { pid: P1 })]);
    expect((s1.kernelState as InstantState).registered).toEqual([P1]);
    const s2 = reducer.apply(s1, status(4, 'open', 'paused'));
    expect(s2.kernelState).toBe(s1.kernelState);
    const until = '2026-10-28T12:02:00.000Z';
    const s3 = reducer.apply(s2, rec(5, INSTANT_EVENTS.windowOpened, { until }));
    expect((s3.kernelState as InstantState).window).toEqual({ until });
  });

  it('toKernelEvent maps the record', () => {
    expect(toKernelEvent(rec(7, 'x', { a: 1 }, { reversesEventId: '3' }))).toEqual({
      id: '7',
      type: 'x',
      payload: { a: 1 },
      at: AT.toISOString(),
      reversesEventId: '3',
    });
  });

  it('TRANSITIONS match the lifecycle', () => {
    expect(TRANSITIONS).toEqual({
      draft: ['open', 'cancelled'],
      open: ['paused', 'closed', 'cancelled'],
      paused: ['open', 'closed', 'cancelled'],
      closed: ['open', 'cancelled'],
      drawn: ['completed', 'cancelled'],
      completed: [],
      cancelled: [],
    });
  });
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof JournalError ? e.code : 'other';
  }
  return undefined;
}

describe('registerGiveawayEvents', () => {
  const registry = new EventTypeRegistry();
  registerGiveawayEvents(registry, kernels);

  it('accepts valid payloads and rejects identity and bad kernel payloads', () => {
    const d = drawn(1, [P1]);
    expect(registry.prepare({ type: GIVEAWAY_EVENTS.drawn, payload: d.payload }).payload).toEqual(d.payload);
    expect(code(() => registry.prepare({ type: GIVEAWAY_EVENTS.registered, payload: { login: 'x' } }))).toBe(
      'invalid_payload',
    );
    const leaky = { ...(created().payload as object), settings: { ...settings, config: { login: 'x' } } };
    expect(code(() => registry.prepare({ type: GIVEAWAY_EVENTS.created, payload: leaky }))).toBe('identity_in_payload');
    expect(registry.get(INSTANT_EVENTS.windowOpened).type).toBe(INSTANT_EVENTS.windowOpened);
    expect(registry.get(EVENT_VOIDED).type).toBe(EVENT_VOIDED);
    expect(
      code(() => registry.prepare({ type: INSTANT_EVENTS.windowOpened, payload: { until: 'kein datum' } })),
    ).toBe('invalid_payload');
  });

  it('created payload is validated', () => {
    expect(code(() => registry.prepare({ type: GIVEAWAY_EVENTS.created, payload: created().payload }))).toBeUndefined();
    const bad = { teamId: TEAM, kernelId: 'instant', kernelVersion: 1, settings: { ...settings, channels: [] } };
    expect(code(() => registry.prepare({ type: GIVEAWAY_EVENTS.created, payload: bad }))).toBe('invalid_payload');
    expect(registry.get(GIVEAWAY_EVENTS.created).reversal).toEqual({
      kind: 'none',
      why: 'Einen Entwurf nimmst du nicht zurück. Brich das Giveaway ab.',
    });
    expect(registry.get(GIVEAWAY_EVENTS.drawn).reversal).toEqual({ kind: 'void' });
  });

  it('service payloads are validated, watch_corrected needs a reason', () => {
    const ok = { minute: MINUTE, channel: CH, factor: 1, entries: [{ pid: P1, sec: 60 }] };
    expect(code(() => registry.prepare({ type: FRAMEWORK_EVENTS.watchCredited, payload: ok }))).toBeUndefined();
    expect(code(() => registry.prepare({ type: FRAMEWORK_EVENTS.watchCredited, payload: { ...ok, entries: [] } }))).toBe('invalid_payload');
    expect(code(() => registry.prepare({ type: FRAMEWORK_EVENTS.watchCredited, payload: { ...ok, entries: [{ pid: P1, sec: 0 }] } }))).toBe('invalid_payload');
    expect(code(() => registry.prepare({ type: FRAMEWORK_EVENTS.watchCredited, payload: { ...ok, minute: '2026-10-28T12:00:01.000Z' } }))).toBe('invalid_payload');
    expect(code(() => registry.prepare({ type: FRAMEWORK_EVENTS.chatCredited, payload: ok }))).toBe('invalid_payload');
    expect(code(() => registry.prepare({ type: FRAMEWORK_EVENTS.chatCredited, payload: { ...ok, entries: [{ pid: P1, sec: 2, lastAt: AT.toISOString() }] } }))).toBeUndefined();
    expect(code(() => registry.prepare({ type: FRAMEWORK_EVENTS.watchCorrected, payload: { channel: CH, entries: [{ pid: P1, sec: -60 }] } }))).toBe('reason_required');
    expect(code(() => registry.prepare({ type: FRAMEWORK_EVENTS.watchCorrected, payload: { channel: CH, entries: [{ pid: P1, sec: 0 }] }, reason: 'x' }))).toBe('invalid_payload');
    expect(code(() => registry.prepare({ type: SERVICE_EVENT_TYPES.boostStarted, payload: { factor: 11, until: AT.toISOString() } }))).toBe('invalid_payload');
    expect(registry.get(SERVICE_EVENT_TYPES.boostEnded).reversal).toEqual({ kind: 'none', why: 'Ein beendeter Boost bleibt beendet. Starte einen neuen Boost.' });
    expect(registry.get(SERVICE_EVENT_TYPES.unregisteredPurged).reversal).toEqual({ kind: 'none', why: 'DSGVO-Löschung. Die Zuordnung ist entfernt.' });
  });

  it('watch_credited inverse is a watch_corrected with negated effective seconds', () => {
    const base = reduce([created(1, 'watchtime')]);
    const wc = registry.get(FRAMEWORK_EVENTS.watchCredited).reversal;
    const cc = registry.get(FRAMEWORK_EVENTS.chatCredited).reversal;
    const co = registry.get(FRAMEWORK_EVENTS.watchCorrected).reversal;
    if (wc.kind !== 'compensate' || cc.kind !== 'compensate' || co.kind !== 'compensate') throw new Error('compensate erwartet');
    expect(wc.inverse(credited(2, [{ pid: P1, sec: 60 }, { pid: P2, sec: 60 }], CH, 2), base)).toEqual({
      type: FRAMEWORK_EVENTS.watchCorrected,
      payload: { channel: CH, entries: [{ pid: P1, sec: -120 }, { pid: P2, sec: -120 }] },
    });
    expect(cc.inverse(chatCredited(3, [{ pid: P1, sec: 2, lastAt: AT.toISOString() }], CH, 3), base)).toEqual({
      type: FRAMEWORK_EVENTS.watchCorrected,
      payload: { channel: CH, entries: [{ pid: P1, sec: -6 }] },
    });
    expect(co.inverse(rec(4, FRAMEWORK_EVENTS.watchCorrected, { channel: CH, entries: [{ pid: P1, sec: -120 }] }), base)).toEqual({
      type: FRAMEWORK_EVENTS.watchCorrected,
      payload: { channel: CH, entries: [{ pid: P1, sec: 120 }] },
    });
  });

  it('boost_started inverse only while that boost is active', () => {
    const until = '2026-10-28T12:10:00.000Z';
    const target = rec(3, SERVICE_EVENT_TYPES.boostStarted, { factor: 3, until });
    const s = reduce([created(), status(2, 'draft', 'open'), target]);
    const bs = registry.get(SERVICE_EVENT_TYPES.boostStarted).reversal;
    if (bs.kind !== 'compensate') throw new Error('compensate erwartet');
    expect(bs.inverse(target, s)).toEqual({ type: SERVICE_EVENT_TYPES.boostEnded, payload: {} });
    const gone = bs.inverse(target, { ...s, boost: null });
    expect(isRejection(gone) && gone.code).toBe('boost_not_active');
    expect(isRejection(gone) && gone.message).toBe('Dieser Boost läuft nicht mehr.');
    const other = bs.inverse(target, { ...s, boost: { ...s.boost!, eventId: '9' } });
    expect(isRejection(other) && other.code).toBe('boost_not_active');
  });

  it('status_changed inverse only for the latest transition', () => {
    const spec = registry.get(GIVEAWAY_EVENTS.statusChanged).reversal;
    if (spec.kind !== 'compensate') throw new Error('compensate erwartet');
    const target = status(2, 'open', 'paused');
    const base = reduce([created()]);
    const r1 = spec.inverse(target, { ...base, status: 'open' });
    expect(isRejection(r1) && r1.code).toBe('not_latest_transition');
    expect(isRejection(r1) && r1.message).toBe('Nimm zuerst die späteren Übergänge zurück.');
    const r2 = spec.inverse(target, { ...base, status: 'paused' });
    expect(r2).toEqual({ type: GIVEAWAY_EVENTS.statusChanged, payload: { from: 'paused', to: 'open' } });
  });

  it('settings, winner status, registration and kernel inverses', () => {
    const base = reduce([created()]);
    const after = { ...settings, prize: 'Neu' };
    const sc = registry.get(GIVEAWAY_EVENTS.settingsChanged).reversal;
    const ws = registry.get(GIVEAWAY_EVENTS.winnerStatusSet).reversal;
    const rg = registry.get(GIVEAWAY_EVENTS.registered).reversal;
    const wd = registry.get(GIVEAWAY_EVENTS.withdrawn).reversal;
    const wo = registry.get(INSTANT_EVENTS.windowOpened).reversal;
    const wc = registry.get(INSTANT_EVENTS.windowClosed).reversal;
    if (
      sc.kind !== 'compensate' ||
      ws.kind !== 'compensate' ||
      rg.kind !== 'compensate' ||
      wd.kind !== 'compensate' ||
      wo.kind !== 'compensate'
    ) {
      throw new Error('compensate erwartet');
    }

    const scT = rec(2, GIVEAWAY_EVENTS.settingsChanged, { before: settings, after });
    const stale = sc.inverse(scT, base);
    expect(isRejection(stale) && stale.code).toBe('not_latest_transition');
    expect(sc.inverse(scT, { ...base, settings: after })).toEqual({
      type: GIVEAWAY_EVENTS.settingsChanged,
      payload: { before: after, after: settings },
    });

    const wsT = rec(3, GIVEAWAY_EVENTS.winnerStatusSet, { pid: P1, from: 'pending', to: 'done' });
    const r = ws.inverse(wsT, { ...base, winners: { [P1]: 'shipped' } });
    expect(isRejection(r) && r.code).toBe('not_latest_transition');
    expect(ws.inverse(wsT, { ...base, winners: { [P1]: 'done' } })).toEqual({
      type: GIVEAWAY_EVENTS.winnerStatusSet,
      payload: { pid: P1, from: 'done', to: 'pending' },
    });

    const rgT = rec(4, GIVEAWAY_EVENTS.registered, { pid: P1 });
    const current = { [P1]: { since: AT.toISOString(), eventId: '4', legalEventId: null } };
    expect(rg.inverse(rgT, { ...base, status: 'open', registered: current })).toEqual({
      type: GIVEAWAY_EVENTS.withdrawn,
      payload: { pid: P1 },
    });
    const gone = rg.inverse(rgT, { ...base, status: 'open' });
    expect(isRejection(gone) && gone.code).toBe('not_registered');
    const later = rg.inverse(rgT, { ...base, status: 'open', registered: { [P1]: { since: AT.toISOString(), eventId: '9', legalEventId: null } } });
    expect(isRejection(later) && later.code).toBe('not_registered');
    const late = rg.inverse(rgT, { ...base, status: 'drawn', registered: current });
    expect(isRejection(late) && late.code).toBe('too_late');
    const wdT = rec(5, GIVEAWAY_EVENTS.withdrawn, { pid: P1 });
    const notOpen = wd.inverse(wdT, { ...base, status: 'closed' });
    expect(isRejection(notOpen) && notOpen.code).toBe('not_open');
    expect(isRejection(notOpen) && notOpen.message).toBe('Das Giveaway nimmt gerade keine Anmeldungen an.');
    expect(wd.inverse(wdT, { ...base, status: 'open' })).toEqual({
      type: GIVEAWAY_EVENTS.registered,
      payload: { pid: P1 },
    });

    const woT = rec(6, INSTANT_EVENTS.windowOpened, { until: '2026-10-28T12:02:00.000Z' });
    const windowOpen = { ...base, kernelState: { ...(base.kernelState as InstantState), window: { until: '2026-10-28T12:02:00.000Z' } } };
    expect(wo.inverse(woT, windowOpen)).toEqual({
      type: INSTANT_EVENTS.windowClosed,
      payload: {},
    });
    const closedWindow = wo.inverse(woT, base);
    expect(isRejection(closedWindow) && closedWindow.code).toBe('not_latest_window');
    expect(wc).toEqual({ kind: 'none', why: 'Ein geschlossenes Fenster bleibt zu. Öffne ein neues Fenster.' });
  });
});
