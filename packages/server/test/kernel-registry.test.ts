import { describe, expect, it } from 'vitest';
import type { AnyKernel } from '../src/kernel-api/index.js';
import { FRAMEWORK_REDUCER_VERSION, KernelRegistry, defaultKernels, versionStamp } from '../src/framework/kernel-registry.js';
import { instantKernel } from '../src/kernels/instant/index.js';
import { JournalError } from '../src/journal/types.js';

function fake(id: string, eventType: string, commands: string[] = []): AnyKernel {
  return {
    ...instantKernel,
    id,
    events: [{ type: eventType, version: 1, check: () => null, reversal: { kind: 'void' } }],
    commands: commands.map((type) => ({ type, label: type, issuer: 'streamer' as const })),
  };
}

describe('KernelRegistry', () => {
  it('defaultKernels kennt instant', () => {
    const r = defaultKernels();
    expect(r.get('instant').id).toBe('instant');
    expect(r.has('instant')).toBe(true);
    expect(r.has('nope')).toBe(false);
    expect(r.list().map((x) => x.id)).toEqual(['instant']);
  });

  it('get unknown throws unknown_kernel', () => {
    let err: unknown;
    try {
      defaultKernels().get('nope');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JournalError);
    expect((err as JournalError).code).toBe('unknown_kernel');
    expect((err as JournalError).message).toBe('Unbekannter Kern: nope. Prüfe die Registry.');
  });

  it('register twice throws', () => {
    const r = defaultKernels();
    expect(() => r.register(instantKernel)).toThrow();
  });

  it('event type without kernel prefix throws', () => {
    const r = new KernelRegistry();
    expect(() => r.register(fake('bar', 'foo_x'))).toThrow(/Präfix/);
    expect(r.has('bar')).toBe(false);
    expect(() => r.register(fake('bar', 'bar_x'))).not.toThrow();
  });

  it('duplicate command type throws', () => {
    const r = new KernelRegistry();
    expect(() => r.register(fake('baz', 'baz_x', ['go', 'go']))).toThrow();
    expect(r.has('baz')).toBe(false);
  });

  it('version stamp changes with any kernel version', () => {
    const a = versionStamp(1, [{ id: 'a', version: 1 }, { id: 'b', version: 1 }]);
    expect(versionStamp(1, [{ id: 'b', version: 1 }, { id: 'a', version: 1 }])).toBe(a);
    expect(versionStamp(1, [{ id: 'a', version: 1 }, { id: 'b', version: 2 }])).not.toBe(a);
    expect(versionStamp(2, [{ id: 'a', version: 1 }, { id: 'b', version: 1 }])).not.toBe(a);
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(2 ** 31);
  });

  it('defaultKernels versionStamp', () => {
    expect(defaultKernels().versionStamp()).toBe(versionStamp(FRAMEWORK_REDUCER_VERSION, [instantKernel]));
  });
});
