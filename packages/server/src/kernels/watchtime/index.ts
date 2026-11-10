// Kern A „Zuschauzeit + Follow“ (NEW_DESIGN.md 8.1): Sekunden je pid und Kanal aus den Diensten Zuschauzeit und Chat-Bonus,
// Coins = Sekunden ÷ Coin-Basis abgerundet, Topf = alle mit mindestens 1 Coin. Rein, ohne I/O und Uhr.
import {
  FRAMEWORK_EVENTS,
  formatDuration,
  type CorrectedPayload,
  type CreditedPayload,
  type Kernel,
  type LegacyImportedPayload,
  type KernelEvent,
  type Pid,
} from '../../kernel-api/index.js';

export interface WatchtimeConfig {
  coinBaseSec: number;
}

export interface WatchtimeState {
  /** pid → Kanal → wirksame Sekunden. Kann durch Korrekturen negativ werden, Coins nie. */
  sec: Record<Pid, Record<Pid, number>>;
  registered: Pid[]; // sortiert, eindeutig
}

const COIN_BASE_MIN = 60;
const COIN_BASE_MAX = 360_000;

export function secondsOf(state: WatchtimeState, pid: Pid): number {
  return Object.values(state.sec[pid] ?? {}).reduce((sum, s) => sum + s, 0);
}

export function coinsOf(state: WatchtimeState, config: WatchtimeConfig, pid: Pid): number {
  return Math.floor(Math.max(0, secondsOf(state, pid)) / config.coinBaseSec);
}

function pidOf(event: KernelEvent): Pid | null {
  const p = event.payload as { pid?: unknown } | null;
  return p && typeof p.pid === 'string' ? p.pid : null;
}

function entriesOf(payload: unknown): { channel: Pid; entries: { pid: Pid; sec: number }[]; factor: number } | null {
  const p = payload as Partial<CreditedPayload & CorrectedPayload> | null;
  if (!p || typeof p.channel !== 'string' || !Array.isArray(p.entries)) return null;
  const factor = typeof p.factor === 'number' ? p.factor : 1;
  const entries = p.entries.filter((e): e is { pid: Pid; sec: number } => typeof e?.pid === 'string' && typeof e?.sec === 'number');
  return { channel: p.channel, entries, factor };
}

function add(state: WatchtimeState, channel: Pid, entries: { pid: Pid; sec: number }[], factor: number): WatchtimeState {
  const sec = { ...state.sec };
  for (const e of entries) {
    const row = { ...(sec[e.pid] ?? {}) };
    row[channel] = (row[channel] ?? 0) + e.sec * factor;
    sec[e.pid] = row;
  }
  return { ...state, sec };
}

export const watchtimeKernel: Kernel<WatchtimeConfig, WatchtimeState> = {
  id: 'watchtime',
  version: 1,
  label: 'Zuschauzeit + Follow',
  configSchema: {
    coinBaseSec: {
      kind: 'int',
      label: 'Coin-Basis',
      help: 'So viel Zuschauzeit ergibt einen Coin.',
      default: 7200,
      min: COIN_BASE_MIN,
      max: COIN_BASE_MAX,
      unit: 'sec',
    },
  },
  supportedGates: ['follow', 'account_age', 'follow_age', 'presence'],
  usesServices: ['watchtime', 'chatBonus', 'boost', 'registration'],
  drawMode: 'weighted',
  events: [],
  commands: [],

  initialState() {
    return { sec: {}, registered: [] };
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
      case FRAMEWORK_EVENTS.watchCredited:
      case FRAMEWORK_EVENTS.chatCredited: {
        const c = entriesOf(event.payload);
        return c ? add(state, c.channel, c.entries, c.factor) : state;
      }
      case FRAMEWORK_EVENTS.watchCorrected: {
        const c = entriesOf(event.payload);
        return c ? add(state, c.channel, c.entries, 1) : state;
      }
      case FRAMEWORK_EVENTS.legacyImported: {
        // Altbestand (NEW_DESIGN.md 15.6): derselbe Zustand, als hätte der Rahmen die Sekunden minütlich gebucht.
        const p = event.payload as Partial<LegacyImportedPayload> | null;
        if (!p || !Array.isArray(p.entries)) return state;
        const byChannel = new Map<Pid, { pid: Pid; sec: number }[]>();
        for (const e of p.entries) {
          if (typeof e?.pid !== 'string' || typeof e?.channel !== 'string' || typeof e?.sec !== 'number') continue;
          const list = byChannel.get(e.channel) ?? [];
          list.push({ pid: e.pid, sec: e.sec });
          byChannel.set(e.channel, list);
        }
        let next = state;
        for (const [channel, entries] of byChannel) next = add(next, channel, entries, 1);
        const registered = Array.isArray(p.registered) ? p.registered.filter((x): x is Pid => typeof x === 'string') : [];
        if (registered.length === 0) return next;
        return { ...next, registered: [...new Set([...next.registered, ...registered])].sort() };
      }
      default:
        return state;
    }
  },

  pool(state, config) {
    return Object.keys(state.sec)
      .sort()
      .map((pid) => ({ pid, weight: coinsOf(state, config, pid) }))
      .filter((e) => e.weight >= 1);
  },

  viewerView(state, pid, config) {
    const total = Math.max(0, secondsOf(state, pid));
    const coins = coinsOf(state, config, pid);
    return {
      registered: state.registered.includes(pid),
      inPool: coins >= 1,
      weight: coins,
      lines: [
        { label: 'Zuschauzeit', value: formatDuration(total) },
        { label: 'Coins', value: String(coins) },
        { label: 'Bis zum nächsten Coin', value: formatDuration((coins + 1) * config.coinBaseSec - total) },
      ],
    };
  },

  display: {
    icon: '⏱',
    unit: 'Coins',
    beta: true,
    emptyPool: 'Niemand hat genug Zuschauzeit für einen Coin.',
    columns: [
      { key: 'watch', label: 'Zuschauzeit' },
      { key: 'coins', label: 'Coins' },
    ],
  },
};
