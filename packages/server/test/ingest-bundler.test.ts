import { describe, expect, it, vi } from 'vitest';
import { BUNDLE_GRACE_MS, Bundler, minuteOf, type SignalBundle } from '../src/ingest/bundler.js';
import type { Signal, SignalUser } from '../src/ingest/signals.js';
import { AT } from './helpers/db.js';

const CH = '77777777-7777-4777-8777-777777777777';
const CH2 = '88888888-8888-4888-8888-888888888888';
const ALICE: SignalUser = { id: '12345', login: 'alice', displayName: 'Alice' };
const BOB: SignalUser = { id: '67890', login: 'bob', displayName: 'Bob' };
const M0 = minuteOf(AT); // 12:00
const at = (sec: number) => new Date(AT.getTime() + sec * 1000);

function setup(over: { flush?: (b: SignalBundle) => Promise<void>; graceMs?: number } = {}) {
  const flushed: SignalBundle[] = [];
  const log = { error: vi.fn() };
  const b = new Bundler({ flush: over.flush ?? (async (x) => void flushed.push(x)), log, ...(over.graceMs === undefined ? {} : { graceMs: over.graceMs }) });
  return { b, flushed, log };
}

describe('minuteOf', () => {
  it('floors to the full minute in UTC', () => {
    expect(minuteOf('2026-10-15T12:00:59.999Z')).toBe('2026-10-15T12:00:00.000Z');
    expect(minuteOf(new Date('2026-10-15T12:01:00.000Z'))).toBe('2026-10-15T12:01:00.000Z');
  });
});

describe('Bundler', () => {
  it('collects presence, chat and follows of one channel and minute into one bundle', async () => {
    const { b, flushed } = setup();
    b.add({ kind: 'chat', channel: CH, at: at(10).toISOString(), user: ALICE, text: 'hi', messageId: 'm1' });
    b.add({ kind: 'presence', channel: CH, minute: M0, users: [ALICE, BOB] });
    b.add({ kind: 'follow', channel: CH, at: at(20).toISOString(), user: BOB });
    await b.tick(at(60 + BUNDLE_GRACE_MS / 1000));
    expect(flushed).toEqual([
      {
        channel: CH,
        minute: M0,
        presence: [ALICE, BOB],
        chat: [{ user: ALICE, at: at(10).toISOString(), text: 'hi', messageId: 'm1' }],
        follows: [{ user: BOB, at: at(20).toISOString() }],
      },
    ]);
    expect(b.size()).toBe(0);
  });

  it('keeps channels and minutes apart', async () => {
    const { b, flushed } = setup();
    b.add({ kind: 'presence', channel: CH, minute: M0, users: [ALICE] });
    b.add({ kind: 'presence', channel: CH2, minute: M0, users: [BOB] });
    b.add({ kind: 'chat', channel: CH, at: at(61).toISOString(), user: ALICE, text: 'später', messageId: 'm2' });
    expect(b.size()).toBe(3);
    await b.drain();
    expect(flushed.map((x) => [x.channel, x.minute])).toEqual([
      [CH, M0],
      [CH2, M0],
      [CH, minuteOf(at(61))],
    ]);
    expect(flushed[2]!.presence).toBeNull();
  });

  it('flushes only after minute end plus grace, earliest minute first', async () => {
    const { b, flushed } = setup();
    b.add({ kind: 'presence', channel: CH, minute: minuteOf(at(60)), users: [ALICE] });
    b.add({ kind: 'presence', channel: CH, minute: M0, users: [ALICE] });
    await b.tick(at(64));
    expect(flushed).toHaveLength(0);
    await b.tick(at(65));
    expect(flushed.map((x) => x.minute)).toEqual([M0]);
    await b.tick(at(125));
    expect(flushed.map((x) => x.minute)).toEqual([M0, minuteOf(at(60))]);
  });

  it('a second presence of the same minute replaces the first', async () => {
    const { b, flushed } = setup();
    b.add({ kind: 'presence', channel: CH, minute: M0, users: [ALICE] });
    b.add({ kind: 'presence', channel: CH, minute: M0, users: [BOB] });
    await b.drain();
    expect(flushed[0]!.presence).toEqual([BOB]);
  });

  it('ignores stream_state signals', async () => {
    const { b, flushed } = setup();
    const s: Signal = { kind: 'stream_state', channel: CH, at: AT.toISOString(), live: true, viewers: 3 };
    b.add(s);
    expect(b.size()).toBe(0);
    await b.drain();
    expect(flushed).toHaveLength(0);
  });

  it('a throwing flush is logged and the bucket is dropped', async () => {
    const { b, log } = setup({ flush: async () => { throw new Error('kaputt'); } });
    b.add({ kind: 'presence', channel: CH, minute: M0, users: [ALICE] });
    await b.drain();
    expect(log.error).toHaveBeenCalledOnce();
    expect(b.size()).toBe(0);
  });

  it('drain flushes every bucket', async () => {
    const { b, flushed } = setup();
    b.add({ kind: 'presence', channel: CH, minute: M0, users: [ALICE] });
    b.add({ kind: 'presence', channel: CH, minute: minuteOf(at(3600)), users: [ALICE] });
    await b.drain();
    expect(flushed).toHaveLength(2);
    expect(b.size()).toBe(0);
  });
});
