// Zustand des Stroms giveaway:<id>. Rahmen-Felder hier, Kern-Zustand über kernel.reduce (F7). Rein und unveränderlich.
import { FRAMEWORK_EVENTS, SERVICE_EVENTS, type AnyKernel, type CreditedPayload, type KernelEvent, type LegacyImportedPayload, type NewKernelEvent, type Pid } from '../../kernel-api/index.js';
import type { EventRecord, NewEvent, StreamId } from '../../journal/types.js';
import type { StreamReducer } from '../command-bus.js';
import type { KernelRegistry } from '../kernel-registry.js';
import type { FrozenLegal, LegalTexts } from '../legal.js';
import { EVENT_VOIDED } from '../revert.js';
import { ANNOUNCEMENT_DEFAULTS, type AnnouncementSettings } from './announcements.js';
import type { GateConfig } from './gates.js';
import { SERVICE_DEFAULTS, SERVICE_EVENT_TYPES, type BoostState, type ServiceSettings } from './services.js';

export type { GateConfig } from './gates.js';

export type GiveawayStatus = 'draft' | 'open' | 'paused' | 'closed' | 'drawn' | 'completed' | 'cancelled';
export type WinnerStatus = 'pending' | 'reported' | 'shipped' | 'done' | 'forfeited';

export interface GiveawaySettings extends ServiceSettings {
  config: Record<string, unknown>;
  prize: string;
  sponsor: string | null;
  channels: Pid[];
  winnersCount: number;
  claimDays: number;
  gates: GateConfig[];
  /** Rechtstexte je Giveaway. null = die des Profils gelten (NEW_DESIGN.md 9.4). */
  legal: LegalTexts | null;
  /** Kontaktweg des Streamers für Gewinner (NEW_DESIGN.md 7.3), freier Text, höchstens 200 Zeichen. */
  contact: string | null;
  /** Chat-Ansagen (NEW_DESIGN.md 10.3): stumm, Link, eigene Vorlagen. */
  announcements: AnnouncementSettings;
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
  // eventId = Ereignis der aktuellen Anmeldung, legalEventId = Fassung der Rechtstexte zu diesem Zeitpunkt (6.4)
  registered: Record<Pid, { since: string; eventId: string; legalEventId: string | null }>;
  draws: DrawRecord[];
  winners: Record<Pid, WinnerStatus>; // Gewinner der gültigen Ziehung(en)
  /** Beim Öffnen eingefrorene Rechtstexte und das Ereignis dazu. */
  legal: FrozenLegal | null;
  legalEventId: string | null;
  /** Wer je eine Gutschrift bekam, mit erstem Zeitpunkt und Kanälen (Anwesenheitsbedingung, Löschfrist). */
  seen: Record<Pid, { since: string; channels: Pid[] }>;
  /** Kanal → letzte Minute mit gebuchter Zuschauzeit (gegen doppelte Bündel). */
  watchMinutes: Record<Pid, string>;
  /** pid → Zeitpunkt der letzten belohnten Chatnachricht (Cooldown). */
  chatLast: Record<Pid, string>;
  boost: BoostState | null;
  /** Zeitpunkt des letzten Übergangs nach Geschlossen oder Abgebrochen, null nach Öffnen. */
  closedAt: string | null;
  purgedAt: string | null;
  kernelState: unknown;
}

export const GIVEAWAY_EVENTS = {
  created: 'giveaway_created',
  statusChanged: 'giveaway_status_changed',
  settingsChanged: 'giveaway_settings_changed',
  legalFrozen: 'giveaway_legal_frozen',
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

/**
 * Ereignisse aus kernel.decide oder kernel.onCancel für das Journal. Ein Kern schreibt nur Typen mit seinem Präfix (§4).
 * Hebt ein Ereignis ein früheres auf (reversesEventId), trägt es den Grund des Rahmen-Befehls (§5.1: Grund bei Umkehrungen).
 */
export function fromKernelEvents(kernel: AnyKernel, out: NewKernelEvent[], reason?: string): NewEvent[] {
  return out.map((e): NewEvent => {
    if (!e.type.startsWith(`${kernel.id}_`)) {
      throw new Error(`Der Kern ${kernel.id} hat ein fremdes Ereignis erzeugt: ${e.type}`);
    }
    if (e.reversesEventId === undefined) return { type: e.type, payload: e.payload };
    return { type: e.type, payload: e.payload, reversesEventId: e.reversesEventId, ...(reason === undefined ? {} : { reason }) };
  });
}

interface CreatedPayload {
  teamId: string;
  kernelId: string;
  kernelVersion: number;
  settings: GiveawaySettings;
}

/** Liefert dasselbe Objekt zurück, wenn kein neuer pid und kein neuer Kanal dazukommt (häufigster Fall, spart Kopien). */
function markSeen(s: GiveawayState, channel: Pid, pids: Pid[], at: string): GiveawayState['seen'] {
  let seen = s.seen;
  for (const pid of pids) {
    const old = seen[pid];
    if (old && old.channels.includes(channel)) continue;
    if (seen === s.seen) seen = { ...s.seen };
    seen[pid] = old ? { ...old, channels: [...old.channels, channel] } : { since: at, channels: [channel] };
  }
  return seen;
}

const later = (a: string | undefined, b: string): string => (a !== undefined && Date.parse(a) > Date.parse(b) ? a : b);

function applyFramework(kernels: KernelRegistry, s: GiveawayState, e: EventRecord): GiveawayState {
  const at = e.createdAt.toISOString();
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
    case GIVEAWAY_EVENTS.statusChanged: {
      const to = (e.payload as { to: GiveawayStatus }).to;
      const closedAt = to === 'closed' || to === 'cancelled' ? at : to === 'open' ? null : s.closedAt;
      // Wieder geöffnet: neue Unangemeldete sammeln sich, die Löschfrist läuft nach dem nächsten Schließen erneut.
      return { ...s, status: to, closedAt, purgedAt: to === 'open' ? null : s.purgedAt };
    }
    case GIVEAWAY_EVENTS.settingsChanged:
      return { ...s, settings: (e.payload as { after: GiveawaySettings }).after };
    case GIVEAWAY_EVENTS.legalFrozen:
      return { ...s, legal: e.payload as FrozenLegal, legalEventId: e.id };
    case GIVEAWAY_EVENTS.registered: {
      const { pid } = e.payload as { pid: Pid };
      return { ...s, registered: { ...s.registered, [pid]: { since: at, eventId: e.id, legalEventId: s.legalEventId } } };
    }
    case GIVEAWAY_EVENTS.withdrawn: {
      const { pid } = e.payload as { pid: Pid };
      return { ...s, registered: Object.fromEntries(Object.entries(s.registered).filter(([k]) => k !== pid)) };
    }
    case FRAMEWORK_EVENTS.watchCredited: {
      const p = e.payload as CreditedPayload;
      return {
        ...s,
        seen: markSeen(s, p.channel, p.entries.map((x) => x.pid), at),
        watchMinutes: { ...s.watchMinutes, [p.channel]: later(s.watchMinutes[p.channel], p.minute) },
      };
    }
    case FRAMEWORK_EVENTS.chatCredited: {
      const p = e.payload as CreditedPayload & { entries: { pid: Pid; lastAt: string }[] };
      const chatLast = { ...s.chatLast };
      for (const x of p.entries) chatLast[x.pid] = later(chatLast[x.pid], x.lastAt);
      return { ...s, seen: markSeen(s, p.channel, p.entries.map((x) => x.pid), at), chatLast };
    }
    case FRAMEWORK_EVENTS.legacyImported: {
      // Übernahme (NEW_DESIGN.md 15.3): Zustand, Anmeldungen mit der Zustimmungsfassung aus diesem Ereignis, seen je Kanal mit Sekunden.
      const p = e.payload as LegacyImportedPayload;
      const legalEventId = p.terms === null ? s.legalEventId : e.id;
      const registered = { ...s.registered };
      for (const pid of p.registered) registered[pid] = { since: at, eventId: e.id, legalEventId };
      const byChannel = new Map<Pid, Pid[]>();
      for (const x of p.entries) byChannel.set(x.channel, [...(byChannel.get(x.channel) ?? []), x.pid]);
      let seen = s.seen;
      for (const [channel, pids] of byChannel) seen = markSeen({ ...s, seen }, channel, pids, at);
      return { ...s, status: p.status, closedAt: p.status === 'closed' ? at : null, registered, legalEventId, seen };
    }
    case SERVICE_EVENT_TYPES.boostStarted: {
      const { factor, until } = e.payload as { factor: number; until: string };
      return { ...s, boost: { factor, since: at, until, eventId: e.id } };
    }
    case SERVICE_EVENT_TYPES.boostEnded:
      return { ...s, boost: null };
    case SERVICE_EVENT_TYPES.unregisteredPurged:
      return { ...s, purgedAt: at };
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

/** Anmeldung bekommt jeder Kern, Dienst-Ereignisse nur Kerne mit dem Dienst, eigene Typen nur der Kern selbst (§4, §6.1). */
function kernelSees(kernel: ReturnType<KernelRegistry['get']>, type: string): boolean {
  if (type === FRAMEWORK_EVENTS.registered || type === FRAMEWORK_EVENTS.withdrawn) return true;
  if (kernel.usesServices.some((service) => SERVICE_EVENTS[service].includes(type))) return true;
  return kernel.events.some((d) => d.type === type);
}

function applyKernel(kernels: KernelRegistry, s: GiveawayState, e: EventRecord): GiveawayState {
  if (!s.exists) return s;
  const kernel = kernels.get(s.kernelId);
  if (!kernelSees(kernel, e.type)) return s;
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
      settings: { config: {}, prize: '', sponsor: null, channels: [], winnersCount: 1, claimDays: 14, gates: [], legal: null, contact: null, announcements: ANNOUNCEMENT_DEFAULTS, ...SERVICE_DEFAULTS },
      status: 'draft',
      registered: {},
      draws: [],
      winners: {},
      legal: null,
      legalEventId: null,
      seen: {},
      watchMinutes: {},
      chatLast: {},
      boost: null,
      closedAt: null,
      purgedAt: null,
      kernelState: null,
    }),
    apply: (state, e) => applyKernel(kernels, applyFramework(kernels, state, e), e),
  };
}
