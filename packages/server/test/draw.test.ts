import { describe, expect, it } from 'vitest';
import { csprng, drawWinners, poolHash, rngFrom } from '../src/framework/giveaway/draw.js';
import type { PoolEntry } from '../src/kernel-api/index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';

describe('drawWinners', () => {
  it('poolHash is order independent and sensitive to weight', () => {
    const pool: PoolEntry[] = [{ pid: A, weight: 1 }, { pid: B, weight: 2 }];
    const h = poolHash(pool);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(poolHash([...pool].reverse())).toBe(h);
    expect(poolHash([{ pid: A, weight: 1 }, { pid: B, weight: 3 }])).not.toBe(h);
  });

  it('weighted draw is reproducible from random', () => {
    const pool: PoolEntry[] = [
      { pid: A, weight: 1 }, { pid: B, weight: 2 }, { pid: C, weight: 3 }, { pid: D, weight: 4 }, { pid: E, weight: 5 },
    ];
    const first = drawWinners(pool, 'weighted', 2, csprng);
    expect(first.random).toHaveLength(2);
    expect(first.winners).toHaveLength(2);
    expect(new Set(first.winners).size).toBe(2);
    const shuffled = [pool[3], pool[0], pool[4], pool[2], pool[1]] as PoolEntry[];
    expect(drawWinners(shuffled, 'weighted', 2, rngFrom(first.random))).toEqual(first);
  });

  it('equal ignores weights', () => {
    // nach pid sortiert: A (schwer) an Position 1, B an Position 2 = ⌈0.6·2⌉
    const pool: PoolEntry[] = [{ pid: B, weight: 1 }, { pid: A, weight: 1000 }];
    expect(drawWinners(pool, 'equal', 1, rngFrom([0.6]))).toEqual({ winners: [B], random: [0.6] });
  });

  it('weighted respects weights', () => {
    const pool: PoolEntry[] = [{ pid: A, weight: 1 }, { pid: B, weight: 3 }];
    let heavy = 0;
    for (let i = 0; i < 10_000; i++) if (drawWinners(pool, 'weighted', 1, csprng).winners[0] === B) heavy++;
    expect(heavy / 10_000).toBeGreaterThanOrEqual(0.7);
    expect(heavy / 10_000).toBeLessThanOrEqual(0.8);
  });

  it('highest picks top and breaks ties randomly', () => {
    const tie = drawWinners([{ pid: C, weight: 3 }, { pid: A, weight: 5 }, { pid: B, weight: 5 }], 'highest', 1, csprng);
    expect([A, B]).toContain(tie.winners[0]);
    expect(tie.winners).toHaveLength(1);
    expect(tie.random).toHaveLength(1);
    expect(drawWinners([{ pid: B, weight: 3 }, { pid: A, weight: 5 }], 'highest', 1, csprng)).toEqual({ winners: [A], random: [] });
  });

  it('drops zero and negative weights, caps count', () => {
    const r = drawWinners([{ pid: A, weight: 0 }, { pid: B, weight: -1 }, { pid: C, weight: 2 }], 'weighted', 3, rngFrom([0.5, 0.5, 0.5]));
    expect(r.winners).toEqual([C]);
    expect(r.random).toHaveLength(1);
  });

  it('rngFrom throws when exhausted', () => {
    const rng = rngFrom([0.1]);
    expect(rng()).toBe(0.1);
    expect(() => rng()).toThrow('Der Zufallsgenerator ist erschöpft.');
  });
});
