import { afterEach, describe, expect, it } from 'vitest';
import { LOAD_START, MINUTE_TARGET_MS, P95_TARGET_MS, runLoadTest } from '../src/loadtest/run.js';
import { freshDb } from './helpers/db.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('Lasttest', () => {
  it('runLoadTest drives simulator signals through apply_signals for every channel and minute, writes events and reports per-command summaries and the p95 target', async () => {
    const db = await freshDb();
    close = db.close;
    const minutes: number[] = [];
    const r = await runLoadTest({ pool: db.pool, channels: 5, viewers: 10, minutes: 2, seed: 7, onMinute: (m) => minutes.push(m) });
    expect(r.config).toEqual({ channels: 5, viewers: 10, minutes: 2, seed: 7 });
    expect(minutes).toEqual([1, 2]);
    expect(r.perMinute.map((x) => x.minute)).toEqual([1, 2]);
    // Je Kanal und Minute genau ein Bündel, also ein apply_signals je offenem Giveaway des Kanals.
    expect(r.commands.apply_signals?.count).toBe(10);
    expect(r.commands.create_giveaway?.count).toBe(5);
    expect(r.commands.open_giveaway?.count).toBe(5);
    expect(r.commands.apply_signals!.p95).toBeGreaterThan(0);
    expect(r.commands.apply_signals!.p95).toBeGreaterThanOrEqual(r.commands.apply_signals!.p50);
    expect(r.failed).toBe(0);
    expect(r.rejected).toBe(0);
    expect(r.events).toBeGreaterThan(20);
    expect(r.wallMs).toBeGreaterThan(0);
    const p95Ok = Object.values(r.commands).every((s) => s.p95 < P95_TARGET_MS);
    const minuteOk = r.perMinute.every((m) => m.ms < MINUTE_TARGET_MS);
    expect(r.target).toEqual({ p95Ms: P95_TARGET_MS, minuteMs: MINUTE_TARGET_MS, p95Ok, minuteOk, ok: p95Ok && minuteOk });
    expect(MINUTE_TARGET_MS).toBe(60_000);
    expect(LOAD_START.toISOString()).toBe('2026-10-15T12:00:00.000Z');

    const events = await db.pool.query<{ type: string; n: string }>('SELECT type, count(*)::int AS n FROM events GROUP BY type ORDER BY type');
    const byType = Object.fromEntries(events.rows.map((x) => [x.type, Number(x.n)]));
    expect(byType.giveaway_created).toBe(5);
    expect(byType.watch_credited).toBe(10);
    expect(byType.chat_credited ?? 0).toBeGreaterThan(0);
    const identities = Number((await db.pool.query('SELECT count(*)::int AS n FROM identities')).rows[0]!.n);
    expect(identities).toBeGreaterThan(0);
    expect(identities).toBeLessThanOrEqual(50);
    const participants = Number((await db.pool.query('SELECT count(*)::int AS n FROM giveaway_participants')).rows[0]!.n);
    expect(participants).toBe(identities);
    // Der Lauf schreibt Betriebsdaten der Kanäle wie der echte Ingest.
    expect(Number((await db.pool.query('SELECT count(*)::int AS n FROM channel_status WHERE live')).rows[0]!.n)).toBe(5);
  });
});
