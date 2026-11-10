import { describe, expect, it } from 'vitest';
import { percentile, summarize } from '../src/loadtest/stats.js';

describe('Lasttest-Statistik', () => {
  it('percentile uses nearest rank and summarize reports count, mean, p50, p95, p99, max; empty input gives zeros', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBe(0);
    const s = summarize([30, 10, 20, 100, 40]);
    expect(s).toEqual({ count: 5, mean: 40, p50: 30, p95: 100, p99: 100, max: 100 });
    expect(summarize([])).toEqual({ count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 });
    // Eingabe bleibt unverändert.
    const input = [3, 1, 2];
    summarize(input);
    expect(input).toEqual([3, 1, 2]);
  });
});
