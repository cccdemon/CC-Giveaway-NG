import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { appendLocked, isReverted, lockStream, readEvent, readStream } from '../src/journal/journal.js';
import { ensurePartitions, isMissingPartition, partitionName } from '../src/journal/partitions.js';
import { AT, freshDb } from './helpers/db.js';
import { ACTOR, STREAM, testRegistry } from './helpers/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());
const registry = testRegistry();

async function setup() {
  const db = await freshDb();
  close = db.close;
  return db.pool;
}

describe('partitions', () => {
  it('names partitions by UTC month', () => {
    expect(partitionName(new Date('2026-12-31T23:59:59Z'))).toBe('events_y2026m12');
    expect(partitionName(new Date('2027-01-01T00:00:00Z'))).toBe('events_y2027m01');
  });

  it('creates current and next months idempotently', async () => {
    const pool = await setup();
    expect(await ensurePartitions(pool, new Date('2026-12-10T00:00:00Z'), 2)).toEqual(['events_y2026m12', 'events_y2027m01', 'events_y2027m02']);
    await ensurePartitions(pool, new Date('2026-12-10T00:00:00Z'), 2);
    const r = await pool.query("SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'events'::regclass");
    expect(r.rows[0].n).toBe(4);
  });
});

describe('append and read', () => {
  it('appends with gapless seq and reads back upcasted', async () => {
    const pool = await setup();
    const corr = randomUUID();
    const written = await withTx(pool, async (c) => {
      const last = await lockStream(c, STREAM);
      expect(last).toBe(0);
      return appendLocked(c, registry, {
        stream: STREAM, lastSeq: last, actor: ACTOR, correlationId: corr, at: AT,
        events: [{ type: 'counter_incremented', payload: { by: 1 } }, { type: 'counter_incremented', payload: { by: 2 } }],
      });
    });
    expect(written.map((e) => e.seq)).toEqual([1, 2]);
    const read = await readStream(pool, registry, STREAM);
    expect(read).toEqual(written);
    expect(await readStream(pool, registry, STREAM, 1)).toEqual([written[1]]);
    expect(await readEvent(pool, registry, written[0]!.id)).toEqual(written[0]);
    expect(await readEvent(pool, registry, '999999')).toBeNull();
    expect(await readEvent(pool, registry, 'abc')).toBeNull();
    expect(await readEvent(pool, registry, '99999999999999999999')).toBeNull();
    expect(await readEvent(pool, registry, '9223372036854775808')).toBeNull();
    expect(await isReverted(pool, '99999999999999999999')).toBe(false);
    const head = await pool.query('SELECT last_seq FROM stream_heads WHERE stream = $1', [STREAM]);
    expect(head.rows[0].last_seq).toBe(2);
  });

  it('upcasts old rows on read', async () => {
    const pool = await setup();
    await pool.query("INSERT INTO stream_heads (stream, last_seq) VALUES ($1, 1)", [STREAM]);
    await pool.query(
      `INSERT INTO events (stream, seq, type, type_version, payload, actor, correlation_id, created_at)
       VALUES ($1, 1, 'note_sent', 1, '{"text":"alt"}', $2, $3, $4)`,
      [STREAM, ACTOR, randomUUID(), AT],
    );
    const [e] = await readStream(pool, registry, STREAM);
    expect(e!.typeVersion).toBe(2);
    expect(e!.payload).toEqual({ text: 'alt', channel: 'unbekannt' });
  });

  it('refuses UPDATE, DELETE and TRUNCATE on events', async () => {
    const pool = await setup();
    await withTx(pool, async (c) => appendLocked(c, registry, {
      stream: STREAM, lastSeq: await lockStream(c, STREAM), actor: ACTOR, correlationId: randomUUID(), at: AT,
      events: [{ type: 'counter_incremented', payload: { by: 1 } }],
    }));
    await expect(pool.query("UPDATE events SET type = 'x'")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM events')).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE events')).rejects.toThrow(/append-only/);
  });

  it('marks reverted events', async () => {
    const pool = await setup();
    const [first] = await withTx(pool, async (c) => appendLocked(c, registry, {
      stream: STREAM, lastSeq: await lockStream(c, STREAM), actor: ACTOR, correlationId: randomUUID(), at: AT,
      events: [{ type: 'counter_incremented', payload: { by: 1 } }],
    }));
    expect(await isReverted(pool, first!.id)).toBe(false);
    await withTx(pool, async (c) => appendLocked(c, registry, {
      stream: STREAM, lastSeq: await lockStream(c, STREAM), actor: ACTOR, correlationId: randomUUID(), at: AT,
      events: [{ type: 'counter_decremented', payload: { by: 1 }, reversesEventId: first!.id, reason: 'Test' }],
    }));
    expect(await isReverted(pool, first!.id)).toBe(true);
  });

  it('rejects invalid actor and invalid stream', async () => {
    const pool = await setup();
    await expect(withTx(pool, (c) => lockStream(c, 'giveaway:nope'))).rejects.toThrow(/Unbekannter Strom/);
    await expect(withTx(pool, async (c) => appendLocked(c, registry, {
      stream: STREAM, lastSeq: await lockStream(c, STREAM), actor: 'someone', correlationId: randomUUID(), at: AT,
      events: [{ type: 'counter_incremented', payload: { by: 1 } }],
    }))).rejects.toThrow(/Unbekannter Akteur/);
  });

  it('assertActor accepts system:migration and rejects system:unknown', async () => {
    const pool = await setup();
    const args = (actor: string) => withTx(pool, async (c) => appendLocked(c, registry, {
      stream: STREAM, lastSeq: await lockStream(c, STREAM), actor, correlationId: randomUUID(), at: AT,
      events: [{ type: 'counter_incremented', payload: { by: 1 } }],
    }));
    await expect(args('system:migration')).resolves.toHaveLength(1);
    await expect(args('system:unknown')).rejects.toThrow(/Unbekannter Akteur/);
  });

  it('detects a stale lastSeq as seq_conflict without duplicates', async () => {
    const pool = await setup();
    const args = (lastSeq: number) => ({
      stream: STREAM, lastSeq, actor: ACTOR, correlationId: randomUUID(), at: AT,
      events: [{ type: 'counter_incremented', payload: { by: 1 } }],
    });
    await withTx(pool, async (c) => appendLocked(c, registry, args(await lockStream(c, STREAM))));
    await expect(withTx(pool, async (c) => appendLocked(c, registry, args(0)))).rejects.toMatchObject({ code: 'seq_conflict' });
    await expect(withTx(pool, async (c) => {
      await lockStream(c, STREAM);
      return appendLocked(c, registry, args(5));
    })).rejects.toMatchObject({ code: 'seq_conflict' });
    const seqs = (await readStream(pool, registry, STREAM)).map((e) => e.seq);
    expect(seqs).toEqual([1]);
  });

  it('refuses TRUNCATE, UPDATE and DELETE directly on a partition', async () => {
    const pool = await setup();
    await expect(pool.query('TRUNCATE events_y2026m10')).rejects.toThrow(/append-only/);
    await withTx(pool, async (c) => appendLocked(c, registry, {
      stream: STREAM, lastSeq: await lockStream(c, STREAM), actor: ACTOR, correlationId: randomUUID(), at: AT,
      events: [{ type: 'counter_incremented', payload: { by: 1 } }],
    }));
    await expect(pool.query("UPDATE events_y2026m10 SET type = 'x'")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM events_y2026m10')).rejects.toThrow(/append-only/);
  });

  it('recognises a missing partition from the real pg error', async () => {
    const pool = await setup();
    const err = await pool.query(
      `INSERT INTO events (stream, seq, type, type_version, payload, actor, correlation_id, created_at)
       VALUES ($1, 1, 'x', 1, '{}', $2, $3, '2031-01-01T00:00:00Z')`,
      [STREAM, ACTOR, randomUUID()],
    ).then(() => null, (e: unknown) => e);
    expect((err as { table?: string }).table).toBe('events');
    expect(isMissingPartition(err)).toBe(true);
    expect(isMissingPartition(new Error('x'))).toBe(false);
  });
});
