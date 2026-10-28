import type pg from 'pg';

/** Schlüssel des Advisory-Locks, der den Scheduler auf eine Instanz begrenzt (NEW_DESIGN.md 3.1). */
export const SCHEDULER_LOCK_KEY = 4242002;

export class SchedulerLockError extends Error {
  constructor() {
    super('Ein Scheduler läuft schon. Beende diesen Prozess, es darf nur einen geben.');
    this.name = 'SchedulerLockError';
  }
}

/** Hält einen eigenen Client mit pg_try_advisory_lock bis release(). release() ist idempotent. */
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
  // Stirbt die Verbindung, ist der Lock weg. Weiterlaufen hieße: ein zweiter Scheduler könnte starten.
  const onLost = (e: Error) => {
    console.error(JSON.stringify({ msg: 'Der Scheduler-Lock ist verloren. Der Prozess beendet sich, damit nur eine Instanz läuft.', err: e.message }));
    process.exit(1);
  };
  c.on('error', onLost);
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      c.off('error', onLost);
      try {
        await c.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY]);
      } finally {
        c.release();
      }
    },
  };
}
