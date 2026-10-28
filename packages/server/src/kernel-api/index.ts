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

export const FRAMEWORK_EVENTS = { registered: 'participant_registered', withdrawn: 'participant_withdrawn' } as const;

export interface KernelEvent {
  id: string;
  type: string;
  payload: unknown;
  at: string; // ISO
  reversesEventId: string | null;
}

export interface NewKernelEvent {
  type: string;
  payload: unknown;
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
}

export type KernelReversal =
  | { kind: 'compensate'; inverse: (payload: unknown) => NewKernelEvent | Rejection }
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
  viewerView(state: State, pid: Pid, config: Config): ViewerView;
  display: DisplaySpec;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyKernel = Kernel<any, any>; // Registry-Typ
