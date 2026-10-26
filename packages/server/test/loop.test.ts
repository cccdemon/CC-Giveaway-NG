import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleLoop } from '../src/scheduler/loop.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('scheduleLoop', () => {
  it('runs immediately and then interval after the previous run ended', async () => {
    const calls: number[] = [];
    let release: () => void = () => undefined;
    const fn = vi.fn(async () => {
      calls.push(Date.now());
      await new Promise<void>((r) => (release = r));
    });
    const loop = scheduleLoop(fn, 1000);
    expect(fn).toHaveBeenCalledTimes(1);

    // Erster Lauf dauert 3 s — länger als das Intervall. Kein zweiter Lauf währenddessen.
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // Erst 1 s nach dem Ende kommt der nächste.
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    release();
    await loop.stop();
  });

  it('keeps going after a rejected run', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('kaputt');
    });
    const onError = vi.fn();
    const loop = scheduleLoop(fn, 100, onError);
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(String((onError.mock.calls[0]![0] as Error).message)).toBe('kaputt');
    await loop.stop();
  });

  it('stop waits for the running call and schedules nothing more', async () => {
    let release: () => void = () => undefined;
    let finished = false;
    const fn = vi.fn(async () => {
      await new Promise<void>((r) => (release = r));
      finished = true;
    });
    const loop = scheduleLoop(fn, 100);
    const stopping = loop.stop();
    release();
    await stopping;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
