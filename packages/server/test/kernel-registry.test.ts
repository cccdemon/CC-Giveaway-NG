import { describe, expect, it } from 'vitest';
import type { AnyKernel, KernelCommandSpec } from '../src/kernel-api/index.js';
import { FRAMEWORK_REDUCER_VERSION, KernelRegistry, defaultKernels, versionStamp } from '../src/framework/kernel-registry.js';
import { instantKernel } from '../src/kernels/instant/index.js';
import { watchtimeKernel } from '../src/kernels/watchtime/index.js';
import { ticketsKernel } from '../src/kernels/tickets/index.js';
import { JournalError } from '../src/journal/types.js';

function fake(id: string, eventType: string, commands: string[] = [], commandSpecs: KernelCommandSpec[] = []): AnyKernel {
  return {
    ...instantKernel,
    id,
    events: [{ type: eventType, version: 1, check: () => null, reversal: { kind: 'void' } }],
    commands: [...commands.map((type) => ({ type, label: type, issuer: 'streamer' as const })), ...commandSpecs],
  };
}

describe('KernelRegistry', () => {
  it('defaultKernels has instant, watchtime and tickets', () => {
    const r = defaultKernels();
    expect(r.get('instant').id).toBe('instant');
    expect(r.get('watchtime').id).toBe('watchtime');
    expect(r.get('tickets').id).toBe('tickets');
    expect(r.has('instant')).toBe(true);
    expect(r.has('nope')).toBe(false);
    expect(r.list().map((x) => x.id)).toEqual(['instant', 'watchtime', 'tickets']);
  });

  it('refuses a chat word on a streamer command, an invalid chat word and a duplicate chat word', () => {
    const r = new KernelRegistry();
    expect(() => r.register(fake('c1', 'c1_x', [], [{ type: 'go', label: 'Go', issuer: 'streamer', chat: { word: '!go' } }]))).toThrow(/issuer 'participant'/);
    expect(() => r.register(fake('c2', 'c2_x', [], [{ type: 'go', label: 'Go', issuer: 'participant', chat: { word: 'x' } }]))).toThrow(/2 bis 32 Zeichen/);
    expect(() => r.register(fake('c3', 'c3_x', [], [{ type: 'go', label: 'Go', issuer: 'participant', chat: { word: 'a b' } }]))).toThrow(/2 bis 32 Zeichen/);
    expect(() =>
      r.register(
        fake('c4', 'c4_x', [], [
          { type: 'go', label: 'Go', issuer: 'participant', chat: { word: '!buy' } },
          { type: 'go2', label: 'Go 2', issuer: 'participant', chat: { word: '!BUY' } },
        ]),
      ),
    ).toThrow(/doppelt/);
    expect(['c1', 'c2', 'c3', 'c4'].some((id) => r.has(id))).toBe(false);
    expect(() => r.register(fake('c5', 'c5_x', [], [{ type: 'go', label: 'Go', issuer: 'participant', chat: { word: '!buy' } }]))).not.toThrow();
  });

  it('refuses a kernel command type with a colon', () => {
    const r = new KernelRegistry();
    expect(() => r.register(fake('baz', 'baz_x', ['framework:stop_boost']))).toThrow(/Doppelpunkt/);
    expect(r.has('baz')).toBe(false);
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
    expect(() => r.register(instantKernel)).toThrow(/schon registriert/);
  });

  it('event type without kernel prefix throws', () => {
    const r = new KernelRegistry();
    expect(() => r.register(fake('bar', 'foo_x'))).toThrow(/Präfix/);
    expect(r.has('bar')).toBe(false);
    expect(() => r.register(fake('bar', 'bar_x'))).not.toThrow();
  });

  it('duplicate command type throws', () => {
    const r = new KernelRegistry();
    expect(() => r.register(fake('baz', 'baz_x', ['go', 'go']))).toThrow(/doppelt/);
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
    expect(defaultKernels().versionStamp()).toBe(versionStamp(FRAMEWORK_REDUCER_VERSION, [instantKernel, watchtimeKernel, ticketsKernel]));
    expect(FRAMEWORK_REDUCER_VERSION).toBe(6);
  });
});
