import { describe, expect, it } from 'vitest';
import { FRAMEWORK_EVENTS, isRejection, reject, type Kernel } from '../src/kernel-api/index.js';

describe('kernel-api', () => {
  it('reject baut eine Rejection, isRejection erkennt sie', () => {
    const r = reject('x', 'y');
    expect(r).toEqual({ rejected: true, code: 'x', message: 'y' });
    expect(isRejection(r)).toBe(true);
    expect(isRejection(null)).toBe(false);
    expect(isRejection({})).toBe(false);
  });

  it('FRAMEWORK_EVENTS ist exakt festgelegt', () => {
    expect(FRAMEWORK_EVENTS).toEqual({ registered: 'participant_registered', withdrawn: 'participant_withdrawn' });
  });

  it('Kernel-Literal ist typisiert', () => {
    const base = {
      id: 'k', version: 1, label: 'K',
      configSchema: { n: { kind: 'int', label: 'N', help: 'h', default: 1, min: 0, max: 5 } },
      supportedGates: [], usesServices: [], drawMode: 'equal',
      events: [], commands: [],
      initialState: () => ({ x: 0 }),
      reduce: (s: { x: number }) => s,
      viewerView: () => ({ registered: false, inPool: false, weight: 0, lines: [] as { label: string; value: string }[] }),
      display: { icon: 'i', unit: null, beta: true, emptyPool: 'leer', columns: [] as { key: string; label: string }[] },
    } as const;
    const ok: Kernel<{ n: number }, { x: number }> = { ...base, pool: () => [] };
    expect(ok.id).toBe('k');
    // @ts-expect-error pool fehlt
    const bad: Kernel<{ n: number }, { x: number }> = { ...base };
    expect(bad).toBeDefined();
  });
});
