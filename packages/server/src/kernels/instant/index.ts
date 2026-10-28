// Kern B „Sofortverlosung“: Anmeldung im offenen Fenster, alle gleich gewichtet. Rein, ohne I/O und Uhr.
import {
  FRAMEWORK_EVENTS,
  reject,
  type Kernel,
  type KernelEvent,
  type Pid,
} from '../../kernel-api/index.js';

export interface InstantConfig {
  windowSec: number;
}

export interface InstantState {
  registered: Pid[]; // sortiert, eindeutig
  window: { until: string } | null;
  windowsOpened: number;
}

export const INSTANT_EVENTS = { windowOpened: 'instant_window_opened', windowClosed: 'instant_window_closed' } as const;

const WINDOW_MIN = 10;
const WINDOW_MAX = 3600;

function isIso(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
}

function pidOf(event: KernelEvent): Pid | null {
  const p = event.payload as { pid?: unknown } | null;
  return p && typeof p.pid === 'string' ? p.pid : null;
}

function untilOf(event: KernelEvent): string | null {
  const p = event.payload as { until?: unknown } | null;
  return p && typeof p.until === 'string' ? p.until : null;
}

export const instantKernel: Kernel<InstantConfig, InstantState> = {
  id: 'instant',
  version: 1,
  label: 'Sofortverlosung',
  configSchema: {
    windowSec: {
      kind: 'int',
      label: 'Fensterlänge',
      help: 'So lange ist das Anmeldefenster offen.',
      default: 120,
      min: WINDOW_MIN,
      max: WINDOW_MAX,
      unit: 'sec',
    },
  },
  supportedGates: ['follow', 'account_age'],
  usesServices: ['registration'],
  drawMode: 'equal',
  events: [
    {
      type: INSTANT_EVENTS.windowOpened,
      version: 1,
      check(payload) {
        const until = (payload as { until?: unknown } | null)?.until;
        return isIso(until) ? null : 'until muss ein gültiges ISO-Datum sein.';
      },
      reversal: { kind: 'compensate', inverse: () => ({ type: INSTANT_EVENTS.windowClosed, payload: {} }) },
    },
    {
      type: INSTANT_EVENTS.windowClosed,
      version: 1,
      check: () => null,
      reversal: { kind: 'none', why: 'Ein geschlossenes Fenster bleibt zu. Öffne ein neues Fenster.' },
    },
  ],
  commands: [
    { type: 'open_window', label: 'Anmeldefenster öffnen', issuer: 'streamer' },
    { type: 'close_window', label: 'Anmeldefenster schließen', issuer: 'scheduler' },
  ],

  initialState() {
    return { registered: [], window: null, windowsOpened: 0 };
  },

  reduce(state, event) {
    switch (event.type) {
      case FRAMEWORK_EVENTS.registered: {
        const pid = pidOf(event);
        if (pid === null || state.registered.includes(pid)) return state;
        return { ...state, registered: [...state.registered, pid].sort() };
      }
      case FRAMEWORK_EVENTS.withdrawn: {
        const pid = pidOf(event);
        if (pid === null || !state.registered.includes(pid)) return state;
        return { ...state, registered: state.registered.filter((p) => p !== pid) };
      }
      case INSTANT_EVENTS.windowOpened: {
        const until = untilOf(event);
        if (until === null) return state;
        return { ...state, window: { until }, windowsOpened: state.windowsOpened + 1 };
      }
      case INSTANT_EVENTS.windowClosed:
        return { ...state, window: null };
      default:
        return state;
    }
  },

  pool(state) {
    return state.registered.map((pid) => ({ pid, weight: 1 }));
  },

  decide(state, cmd, config, now) {
    switch (cmd.type) {
      case 'open_window': {
        const sec = cmd.args.windowSec === undefined ? config.windowSec : cmd.args.windowSec;
        if (typeof sec !== 'number' || !Number.isInteger(sec) || sec < WINDOW_MIN || sec > WINDOW_MAX) {
          return reject('invalid_window', 'Die Fensterlänge muss zwischen 10 und 3600 Sekunden liegen.');
        }
        if (state.window) return reject('window_open', 'Ein Anmeldefenster ist schon offen. Schließe es zuerst.');
        const until = new Date(Date.parse(now) + sec * 1000).toISOString();
        return [{ type: INSTANT_EVENTS.windowOpened, payload: { until } }];
      }
      case 'close_window':
        return state.window ? [{ type: INSTANT_EVENTS.windowClosed, payload: {} }] : [];
      default:
        return reject('unknown_command', 'Diesen Befehl kennt die Sofortverlosung nicht.');
    }
  },

  gateRegistration(state, _config, now) {
    if (!state.window || Date.parse(now) >= Date.parse(state.window.until)) {
      return reject('window_closed', 'Das Anmeldefenster ist zu. Warte auf das nächste Fenster.');
    }
    return null;
  },

  timers(state) {
    if (!state.window) return [];
    return [{ key: 'window_end', dueAt: state.window.until, command: { type: 'close_window', args: {} } }];
  },

  viewerView(state, pid) {
    const registered = state.registered.includes(pid);
    return {
      registered,
      inPool: registered,
      weight: registered ? 1 : 0,
      lines: [{ label: 'Anmeldefenster', value: state.window ? `offen bis ${state.window.until}` : 'geschlossen' }],
    };
  },

  display: {
    icon: '⚡',
    unit: null,
    beta: true,
    emptyPool: 'Niemand hat sich im Anmeldefenster angemeldet.',
    columns: [{ key: 'registered', label: 'Angemeldet' }],
  },
};
