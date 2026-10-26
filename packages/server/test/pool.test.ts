import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONNECTION_TIMEOUT_MS, DEFAULT_QUERY_TIMEOUT_MS, createPool } from '../src/db/pool.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('createPool', () => {
  it('sets connection and query timeouts by default', () => {
    const pool = createPool('postgres://x:y@127.0.0.1:1/none');
    close = () => pool.end();
    expect(pool.options.connectionTimeoutMillis).toBe(DEFAULT_CONNECTION_TIMEOUT_MS);
    expect(pool.options.query_timeout).toBe(DEFAULT_QUERY_TIMEOUT_MS);
  });

  it('accepts overrides', () => {
    const pool = createPool('postgres://x:y@127.0.0.1:1/none', { connectionTimeoutMillis: 42, queryTimeoutMillis: 43 });
    close = () => pool.end();
    expect(pool.options.connectionTimeoutMillis).toBe(42);
    expect(pool.options.query_timeout).toBe(43);
  });

  it('handles idle client errors instead of crashing the process', () => {
    const onError = vi.fn();
    const pool = createPool('postgres://x:y@127.0.0.1:1/none', { onError });
    close = () => pool.end();
    expect(pool.listenerCount('error')).toBe(1);
    const boom = new Error('Verbindung weg');
    expect(() => pool.emit('error', boom)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('logs idle client errors in German when no handler is given', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = createPool('postgres://x:y@127.0.0.1:1/none');
    close = async () => {
      spy.mockRestore();
      await pool.end();
    };
    pool.emit('error', new Error('x'));
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]![0])).toContain('Datenbankverbindung ist abgebrochen');
  });
});
