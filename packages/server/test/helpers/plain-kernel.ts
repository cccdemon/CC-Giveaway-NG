// Testkern ohne Fenster: Anmeldung jederzeit im Zustand Offen, alle Angemeldeten gleich gewichtet.
import { FRAMEWORK_EVENTS, type Kernel, type Pid } from '../../src/kernel-api/index.js';
import { defaultKernels, type KernelRegistry } from '../../src/framework/kernel-registry.js';

function pidOf(payload: unknown): Pid | null {
  const p = payload as { pid?: unknown } | null;
  return p && typeof p.pid === 'string' ? p.pid : null;
}

export const plainKernel: Kernel<Record<string, never>, { registered: Pid[] }> = {
  id: 'plain',
  version: 1,
  label: 'Testkern',
  configSchema: {},
  supportedGates: [],
  usesServices: ['registration'],
  drawMode: 'equal',
  events: [],
  commands: [],
  initialState: () => ({ registered: [] }),
  reduce(state, event) {
    const pid = pidOf(event.payload);
    if (pid === null) return state;
    if (event.type === FRAMEWORK_EVENTS.registered) {
      return state.registered.includes(pid) ? state : { registered: [...state.registered, pid].sort() };
    }
    if (event.type === FRAMEWORK_EVENTS.withdrawn) {
      return { registered: state.registered.filter((p) => p !== pid) };
    }
    return state;
  },
  pool: (state) => state.registered.map((pid) => ({ pid, weight: 1 })),
  viewerView(state, pid) {
    const registered = state.registered.includes(pid);
    return { registered, inPool: registered, weight: registered ? 1 : 0, lines: [] };
  },
  display: { icon: '🧪', unit: null, beta: true, emptyPool: 'Niemand ist angemeldet.', columns: [] },
};

export function kernelsWithPlain(): KernelRegistry {
  const r = defaultKernels();
  r.register(plainKernel);
  return r;
}
