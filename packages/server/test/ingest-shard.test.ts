import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fnv1a, shardOf } from '../src/ingest/shard.js';

describe('shardOf', () => {
  it('is stable and within [0, workers)', () => {
    const pids = Array.from({ length: 1000 }, () => randomUUID());
    for (const pid of pids) {
      expect(shardOf(pid, 1)).toBe(0);
      const s = shardOf(pid, 7);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(7);
      expect(shardOf(pid, 7)).toBe(s);
    }
    expect(fnv1a('')).toBe(0x811c9dc5 & 0x7fffffff);
  });

  it('distributes 1000 pids over 4 workers with at most 35 % on one', () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 1000; i++) counts[shardOf(randomUUID(), 4)]!++;
    for (const c of counts) expect(c).toBeLessThanOrEqual(350);
  });
});
