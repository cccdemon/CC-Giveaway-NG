// Zustand des Stroms giveaway:<id>. Rahmen-Felder hier, Kern-Zustand über kernel.reduce (F7). Rein und unveränderlich.
import { FRAMEWORK_EVENTS, type GateId, type KernelEvent, type Pid } from '../../kernel-api/index.js';
import type { EventRecord, StreamId } from '../../journal/types.js';
import type { StreamReducer } from '../command-bus.js';
import type { KernelRegistry } from '../kernel-registry.js';
import { EVENT_VOIDED } from '../revert.js';

export type GiveawayStatus = 'draft' | 'open' | 'paused' | 'closed' | 'drawn' | 'completed' | 'cancelled';
export type WinnerStatus = 'pending' | 'reported' | 'shipped' | 'done' | 'forfeited';

export interface GateConfig {
  id: GateId;
  [k: string]: unknown;
}

export interface GiveawaySettings {
  config: Record<string, unknown>;
  prize: string;
  sponsor: string | null;
  channels: Pid[];
  winnersCount: number;
  claimDays: number;
  gates: GateConfig[];
}

export interface DrawRecord {
  eventId: string;
  winners: Pid[];
  excluded: Pid[]; // Ausschlüsse früherer Ersatzziehungen, bleiben bei der nächsten draußen
  voided: boolean;
}

export interface GiveawayState {
  exists: boolean;
  teamId: string;
  kernelId: string;
  kernelVersionAtCreate: number;
  settings: GiveawaySettings;
  status: GiveawayStatus;
  registered: Record<Pid, { since: string }>;
  draws: DrawRecord[];
  winners: Record<Pid, WinnerStatus>; // Gewinner der gültigen Ziehung(en)
  kernelState: unknown;
}

export const GIVEAWAY_EVENTS = {
  created: 'giveaway_created',
  statusChanged: 'giveaway_status_changed',
  settingsChanged: 'giveaway_settings_changed',
  drawn: 'giveaway_drawn',
  winnerStatusSet: 'winner_status_set',
  registered: FRAMEWORK_EVENTS.registered,
  withdrawn: FRAMEWORK_EVENTS.withdrawn,
} as const;

/** Erlaubte Ziele je Zustand (§7.1). drawn entsteht nur über giveaway_drawn. */
export const TRANSITIONS: Record<GiveawayStatus, readonly GiveawayStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['paused', 'closed', 'cancelled'],
  paused: ['open', 'closed', 'cancelled'],
  closed: ['open', 'cancelled'],
  drawn: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function giveawayStream(id: string): StreamId {
  return `giveaway:${id}`;
}

export function toKernelEvent(e: EventRecord): KernelEvent {
  return { id: e.id, type: e.type, payload: e.payload, at: e.createdAt.toISOString(), reversesEventId: e.reversesEventId };
}

interface CreatedPayload {
  teamId: string;
  kernelId: string;
  kernelVersion: number;
  settings: GiveawaySettings;
}

function applyFramework(kernels: KernelRegistry, s: GiveawayState, e: EventRecord): GiveawayState {
  switch (e.type) {
    case GIVEAWAY_EVENTS.created: {
      const p = e.payload as CreatedPayload;
      const kernel = kernels.get(p.kernelId);
      return {
        ...s,
        exists: true,
        teamId: p.teamId,
        kernelId: p.kernelId,
        kernelVersionAtCreate: p.kernelVersion,
        settings: p.settings,
        status: 'draft',
        kernelState: kernel.initialState(p.settings.config),
      };
    }
    case GIVEAWAY_EVENTS.statusChanged:
      return { ...s, status: (e.payload as { to: GiveawayStatus }).to };
    case GIVEAWAY_EVENTS.settingsChanged:
      return { ...s, settings: (e.payload as { after: GiveawaySettings }).after };
    case GIVEAWAY_EVENTS.registered: {
      const { pid } = e.payload as { pid: Pid };
      return { ...s, registered: { ...s.registered, [pid]: { since: e.createdAt.toISOString() } } };
    }
    case GIVEAWAY_EVENTS.withdrawn: {
      const { pid } = e.payload as { pid: Pid };
      return { ...s, registered: Object.fromEntries(Object.entries(s.registered).filter(([k]) => k !== pid)) };
    }
    case GIVEAWAY_EVENTS.drawn: {
      const { winners, excluded } = e.payload as { winners: Pid[]; excluded: Pid[] };
      const next = { ...s.winners };
      for (const pid of winners) next[pid] ??= 'pending';
      return {
        ...s,
        draws: [...s.draws, { eventId: e.id, winners: [...winners], excluded: [...excluded], voided: false }],
        status: 'drawn',
        winners: next,
      };
    }
    case GIVEAWAY_EVENTS.winnerStatusSet: {
      const { pid, to } = e.payload as { pid: Pid; to: WinnerStatus };
      return { ...s, winners: { ...s.winners, [pid]: to } };
    }
    case EVENT_VOIDED: {
      // Ersatzziehung: neue Ziehung vor dem Void der alten, damit Stati bleibender Gewinner erhalten bleiben.
      if (!s.draws.some((d) => d.eventId === e.reversesEventId)) return s;
      const draws = s.draws.map((d) => (d.eventId === e.reversesEventId ? { ...d, voided: true } : d));
      const valid = draws.filter((d) => !d.voided);
      const winners: Record<Pid, WinnerStatus> = {};
      for (const d of valid) for (const pid of d.winners) winners[pid] ??= s.winners[pid] ?? 'pending';
      return { ...s, draws, winners, status: valid.length === 0 ? 'closed' : s.status };
    }
    default:
      return s;
  }
}

function applyKernel(kernels: KernelRegistry, s: GiveawayState, e: EventRecord): GiveawayState {
  if (!s.exists) return s;
  const kernel = kernels.get(s.kernelId);
  const relevant =
    e.type === FRAMEWORK_EVENTS.registered ||
    e.type === FRAMEWORK_EVENTS.withdrawn ||
    kernel.events.some((d) => d.type === e.type);
  if (!relevant) return s;
  return { ...s, kernelState: kernel.reduce(s.kernelState, toKernelEvent(e), s.settings.config) };
}

export function makeGiveawayReducer(kernels: KernelRegistry): StreamReducer<GiveawayState> {
  return {
    name: 'giveaway',
    version: kernels.versionStamp(),
    initial: () => ({
      exists: false,
      teamId: '',
      kernelId: '',
      kernelVersionAtCreate: 0,
      settings: { config: {}, prize: '', sponsor: null, channels: [], winnersCount: 1, claimDays: 14, gates: [] },
      status: 'draft',
      registered: {},
      draws: [],
      winners: {},
      kernelState: null,
    }),
    apply: (state, e) => applyKernel(kernels, applyFramework(kernels, state, e), e),
  };
}
