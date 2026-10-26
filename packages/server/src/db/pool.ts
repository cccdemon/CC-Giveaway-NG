import pg from 'pg';

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export interface PoolOptions {
  /** Wartezeit auf eine Verbindung. Danach schlägt die Anfrage fehl statt zu hängen. */
  connectionTimeoutMillis?: number;
  /** Höchstdauer einer Abfrage. */
  queryTimeoutMillis?: number;
  /** Wird gerufen, wenn eine ruhende Verbindung stirbt (z. B. DB-Neustart). Ohne Listener beendet Node den Prozess. */
  onError?: (e: Error) => void;
}

export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

export function createPool(url: string, opts: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    query_timeout: opts.queryTimeoutMillis ?? DEFAULT_QUERY_TIMEOUT_MS,
  });
  const onError = opts.onError ?? ((e: Error) => console.error(JSON.stringify({ msg: 'Eine ruhende Datenbankverbindung ist abgebrochen. Der Pool verbindet bei der nächsten Anfrage neu.', err: e.message })));
  pool.on('error', onError);
  return pool;
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
