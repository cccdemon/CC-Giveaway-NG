import { describe, expect, it, vi } from 'vitest';
import { BACKOFF_ATTEMPTS, BACKOFF_BASE_MS, withBackoff } from '../src/ingest/backoff.js';

describe('withBackoff', () => {
  it('returns on first success without sleeping', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    expect(await withBackoff(async () => 42, { sleep })).toBe(42);
    expect(sleep).not.toHaveBeenCalled();
    expect(BACKOFF_ATTEMPTS).toBe(3);
    expect(BACKOFF_BASE_MS).toBe(1000);
  });

  it('retries 3 times with 1 s, 2 s, 4 s and rethrows the last error', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const attempts: number[] = [];
    await expect(
      withBackoff(async (attempt) => {
        attempts.push(attempt);
        throw new Error(`fehler ${attempt}`);
      }, { sleep }),
    ).rejects.toThrow('fehler 2');
    expect(attempts).toEqual([0, 1, 2]);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it('succeeds on a later attempt', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    let n = 0;
    const out = await withBackoff(async () => {
      n++;
      if (n < 3) throw new Error('noch nicht');
      return 'ok';
    }, { sleep, attempts: 5, baseMs: 10 });
    expect(out).toBe('ok');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
  });

  it('delayMs overrides the wait for one error', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    let n = 0;
    await withBackoff(async () => {
      n++;
      if (n === 1) throw new Error('warte 7');
      if (n === 2) throw new Error('normal');
      return 'ok';
    }, { sleep, delayMs: (e) => ((e as Error).message === 'warte 7' ? 7 : undefined) });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([7, 2000]);
  });

  it('does not retry when retryOn says no', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    let n = 0;
    await expect(
      withBackoff(async () => {
        n++;
        throw new Error('endgültig');
      }, { sleep, retryOn: () => false }),
    ).rejects.toThrow('endgültig');
    expect(n).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
