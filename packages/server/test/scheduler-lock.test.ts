import { afterEach, describe, expect, it } from 'vitest';
import { SchedulerLockError, acquireSchedulerLock } from '../src/scheduler/lock.js';
import { freshDb } from './helpers/db.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('acquireSchedulerLock', () => {
  it('a second scheduler on the same DB is refused until the first releases', async () => {
    const db = await freshDb({ migrate: false });
    close = db.close;
    const first = await acquireSchedulerLock(db.pool);
    const err = await acquireSchedulerLock(db.pool).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchedulerLockError);
    expect((err as Error).message).toBe('Ein Scheduler läuft schon. Beende diesen Prozess, es darf nur einen geben.');
    await first.release();
    const second = await acquireSchedulerLock(db.pool);
    await second.release();
  });
});
