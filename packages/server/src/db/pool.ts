import pg from 'pg';

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
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
