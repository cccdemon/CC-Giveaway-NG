// Kern-Vertrag (NEW_DESIGN.md 3.4): nur Typen und kleine reine Helfer, keine Imports.

export type Pid = string; // UUID (F1)
export type GateId = 'follow' | 'account_age' | 'follow_age' | 'presence';
export type ServiceId = 'watchtime' | 'chatBonus' | 'boost' | 'registration';
export type DrawMode = 'weighted' | 'equal' | 'highest';

export interface Rejection {
  rejected: true;
  code: string;
  message: string;
}

export function reject(code: string, message: string): Rejection {
  return { rejected: true, code, message };
}

export function isRejection(x: unknown): x is Rejection {
  return typeof x === 'object' && x !== null && (x as { rejected?: unknown }).rejected === true;
}

export type ConfigField =
  | { kind: 'int'; label: string; help: string; default: number; min: number; max: number; unit?: 'sec' | 'coins' }
  | { kind: 'bool'; label: string; help: string; default: boolean }
  | { kind: 'text'; label: string; help: string; default: string; maxLength: number };

export type ConfigSchema<C> = { readonly [K in keyof C]: ConfigField };

/** Rahmen-Ereignisse, die ein Kern per reduce bekommt. Anmeldung bekommt jeder Kern, die anderen nur mit dem Dienst. */
export const FRAMEWORK_EVENTS = {
  registered: 'participant_registered',
  withdrawn: 'participant_withdrawn',
  watchCredited: 'watch_credited',
  chatCredited: 'chat_credited',
  watchCorrected: 'watch_corrected',
} as const;

/** Welche Rahmen-Ereignisse ein Dienst erzeugt (NEW_DESIGN.md 6). Der Rahmen reicht sie an Kerne mit diesem Dienst weiter. */
export const SERVICE_EVENTS: Record<ServiceId, readonly string[]> = {
  watchtime: [FRAMEWORK_EVENTS.watchCredited, FRAMEWORK_EVENTS.watchCorrected],
  chatBonus: [FRAMEWORK_EVENTS.chatCredited],
  boost: [],
  registration: [FRAMEWORK_EVENTS.registered, FRAMEWORK_EVENTS.withdrawn],
};

/** Payload von watch_credited und chat_credited (chat_credited trägt je Eintrag zusätzlich lastAt). sec ist Rohzeit, der Kern multipliziert mit factor. */
export interface CreditedPayload {
  minute: string;
  channel: Pid;
  factor: number;
  entries: { pid: Pid; sec: number }[];
}

/** Payload von watch_corrected: wirksame Sekunden, positiv oder negativ. */
export interface CorrectedPayload {
  channel: Pid;
  entries: { pid: Pid; sec: number }[];
}

/** Ganze Minuten als Text: „0 min“, „37 min“, „1 h 23 min“, „100 h“. Negatives zählt als 0. */
export function formatDuration(sec: number): string {
  const minutes = Math.floor(Math.max(0, sec) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export interface KernelEvent {
  /** Journal-ID. Leer (''), solange der Rahmen ein Bündel nur plant (apply_signals), erst beim Schreiben vergeben. */
  id: string;
  type: string;
  payload: unknown;
  at: string; // ISO
  reversesEventId: string | null;
}

export interface NewKernelEvent {
  type: string;
  payload: unknown;
  /** Gesetzt, wenn das Ereignis ein früheres aufhebt (z. B. Erstattung beim Abbruch). Der Rahmen ergänzt den Grund. */
  reversesEventId?: string;
}

export interface PoolEntry {
  pid: Pid;
  weight: number;
}

export interface KernelCommand {
  type: string;
  pid?: Pid;
  args: Record<string, unknown>;
}

export interface KernelCommandSpec {
  type: string;
  label: string;
  issuer: 'participant' | 'streamer' | 'scheduler';
  /**
   * Auslöser im Chat: erstes Wort der Nachricht, Groß-/Kleinschreibung egal. Nur für issuer 'participant'.
   * Das zweite Wort wird als args.count übergeben (ganze Zahl ≥ 1), fehlt es, gilt 1 (NEW_DESIGN.md 8.3 „!ticket <n>“).
   */
  chat?: { word: string };
}

export type KernelReversal =
  /** state = der eigene Kern-Zustand vor der Umkehrung. */
  | { kind: 'compensate'; inverse: (payload: unknown, state: unknown) => NewKernelEvent | Rejection }
  | { kind: 'void' }
  | { kind: 'none'; why: string };

export interface KernelEventDef {
  type: string;
  version: number;
  check(payload: unknown): string | null;
  reversal: KernelReversal;
}

export interface TimerSpec {
  key: string;
  dueAt: string; // ISO
  command: KernelCommand;
}

export interface ViewerView {
  registered: boolean;
  inPool: boolean;
  weight: number;
  lines: { label: string; value: string }[];
}

export interface DisplaySpec {
  icon: string;
  unit: string | null;
  beta: boolean;
  emptyPool: string;
  columns: { key: string; label: string }[];
  /** Default-Texte der Chat-Ansagen je Kern-Ereignistyp (NEW_DESIGN.md 10.3). Platzhalter {preis}, {keyword}, {bis}. */
  announcements?: Record<string, string>;
}

export interface Kernel<Config, State> {
  id: string;
  version: number;
  label: string;
  configSchema: ConfigSchema<Config>;
  supportedGates: readonly GateId[];
  usesServices: readonly ServiceId[];
  drawMode: DrawMode;
  events: readonly KernelEventDef[];
  commands: readonly KernelCommandSpec[];
  initialState(config: Config): State;
  reduce(state: State, event: KernelEvent, config: Config): State;
  pool(state: State, config: Config): PoolEntry[];
  decide?(state: State, cmd: KernelCommand, config: Config, now: string): NewKernelEvent[] | Rejection;
  gateRegistration?(state: State, config: Config, now: string): Rejection | null;
  timers?(state: State, config: Config): TimerSpec[];
  /** Ereignisse, die der Rahmen beim Abbruch nach giveaway_status_changed schreibt (NEW_DESIGN.md 7.1: Kern C erstattet Tickets). */
  onCancel?(state: State, config: Config): NewKernelEvent[];
  viewerView(state: State, pid: Pid, config: Config): ViewerView;
  display: DisplaySpec;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyKernel = Kernel<any, any>; // Registry-Typ
