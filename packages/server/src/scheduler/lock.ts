import type pg from 'pg';

/** Schlüssel des Advisory-Locks, der den Scheduler auf eine Instanz begrenzt (NEW_DESIGN.md 3.1). */
export const SCHEDULER_LOCK_KEY = 4242002;

export class SchedulerLockError extends Error {
  constructor() {
    super('Ein Scheduler läuft schon. Beende diesen Prozess, es darf nur einen geben.');
    this.name = 'SchedulerLockError';
  }
}

/** Hält einen eigenen Client mit pg_try_advisory_lock bis release(). */
export async function acquireSchedulerLock(pool: pg.Pool): Promise<{ release(): Promise<void> }> {
  const c = await pool.connect();
  let got: boolean;
  try {
    got = (await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [SCHEDULER_LOCK_KEY])).rows[0]!.ok;
  } catch (e) {
    c.release();
    throw e;
  }
  if (!got) {
    c.release();
    throw new SchedulerLockError();
  }
  return {
    async release() {
      try {
        await c.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY]);
      } finally {
        c.release();
      }
    },
  };
}
