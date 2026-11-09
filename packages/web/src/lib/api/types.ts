// Antwortformen der API, wie packages/server sie liefert. Eigene Typen: web importiert nichts aus server (NEW_DESIGN.md 3.4).

export type GiveawayStatus = 'draft' | 'open' | 'paused' | 'closed' | 'drawn' | 'completed' | 'cancelled';
export type WinnerStatus = 'pending' | 'reported' | 'shipped' | 'done' | 'forfeited';
export type GateId = 'follow' | 'account_age' | 'follow_age' | 'presence';
export type ServiceId = 'watchtime' | 'chatBonus' | 'boost' | 'registration';
export type Counting = 'registered' | 'first_seen';

export interface EventRef {
  id: string;
  seq: number;
  type: string;
}
export interface CommandResult {
  events: EventRef[];
}

export interface LegalTexts {
  impressumUrl: string | null;
  terms: { text: string } | { url: string } | null;
  privacyUrl: string | null;
}
/** Beim Öffnen eingefroren: URLs mit Hash des Inhalts, Text als Kopie. */
export interface FrozenLegal {
  impressum: { url: string; hash: string } | null;
  terms: { text: string } | { url: string; hash: string } | null;
  privacy: { url: string; hash: string } | null;
}

export interface Me {
  pid: string;
  login: string;
  displayName: string;
  soloTeamId: string;
  termsVersion: number;
  currentTermsVersion: number;
  channelConnected: boolean;
  legal: LegalTexts;
}

export type ConfigField =
  | { kind: 'int'; label: string; help: string; default: number; min: number; max: number; unit?: 'sec' | 'coins' }
  | { kind: 'bool'; label: string; help: string; default: boolean }
  | { kind: 'text'; label: string; help: string; default: string; maxLength: number };

export interface KernelCommandSpec {
  type: string;
  label: string;
  issuer: 'participant' | 'streamer' | 'scheduler';
  chat?: { word: string };
}

export interface DisplaySpec {
  icon: string;
  unit: string | null;
  beta: boolean;
  emptyPool: string;
  columns: { key: string; label: string }[];
}

export interface KernelInfo {
  id: string;
  label: string;
  version: number;
  display: DisplaySpec;
  configSchema: Record<string, ConfigField>;
  supportedGates: GateId[];
  usesServices: ServiceId[];
  drawMode: 'weighted' | 'equal' | 'highest';
  commands: KernelCommandSpec[];
}

export type GateConfig =
  | { id: 'follow'; mode: 'all' | 'min' | 'channel'; min?: number; channel?: string }
  | { id: 'account_age'; days: number }
  | { id: 'follow_age'; days: number }
  | { id: 'presence'; minChannels: number };

export interface ChatBonusSettings {
  enabled: boolean;
  sec: number;
  minWords: number;
  cooldownSec: number;
}

export interface GiveawaySettings {
  config: Record<string, unknown>;
  prize: string;
  sponsor: string | null;
  channels: string[];
  winnersCount: number;
  claimDays: number;
  gates: GateConfig[];
  legal: LegalTexts | null;
  contact: string | null;
  counting: Counting;
  purgeDays: number;
  keyword: string | null;
  chatBonus: ChatBonusSettings;
}

/** Beim Anlegen: alles optional außer Gewinn und Kanälen, der Server füllt Defaults. */
export type CreateSettings = Partial<Omit<GiveawaySettings, 'prize' | 'channels'>> & { prize: string; channels: string[] };

export interface ChannelWarning {
  level: 'rot' | 'gelb' | 'hinweis';
  text: string;
}

export interface ChannelStatus {
  pid: string;
  connected: boolean;
  tokenStatus: 'ok' | 'invalid' | 'none';
  live: boolean;
  liveSince: string | null;
  viewers: number | null;
  chatters: number | null;
  coverage: number | null;
  lastSignalAt: string | null;
  problem: string | null;
  warning: ChannelWarning | null;
}
export interface NamedChannelStatus extends ChannelStatus {
  displayName: string;
}

export interface Tile {
  id: string;
  teamId: string;
  kernel: string;
  kernelLabel: string;
  status: GiveawayStatus;
  prize: string;
  registeredCount: number;
  poolSize: number;
  poolWeight: number;
  claimDays: number;
  drawnAt: string | null;
  winnerStatuses: Record<WinnerStatus, number>;
  updatedAt: string;
  warnings: { pid: string; level: ChannelWarning['level']; text: string }[];
}

export interface BoostState {
  factor: number;
  until: string;
  eventId: string;
}

export interface DrawRecord {
  eventId: string;
  winners: string[];
  excluded: string[];
  voided: boolean;
}

export interface GiveawayDetail {
  id: string;
  teamId: string;
  kernel: KernelInfo;
  status: GiveawayStatus;
  settings: GiveawaySettings;
  legal: FrozenLegal | null;
  legalEventId: string | null;
  boost: BoostState | null;
  pool: { size: number; weight: number };
  registeredCount: number;
  winners: { pid: string; displayName: string; status: WinnerStatus }[];
  draws: DrawRecord[];
  channels: NamedChannelStatus[];
  drawnAt: string | null;
  closedAt: string | null;
  purgedAt: string | null;
}

export interface ParticipantView {
  pid: string;
  displayName: string;
  registered: boolean;
  inPool: boolean;
  seen: boolean;
  weight: number;
  chance: number | null;
  winnerStatus: WinnerStatus | null;
  lines: { label: string; value: string }[];
}

export type HistoryActor = { kind: 'user'; pid: string; displayName: string } | { kind: 'system'; name: string };

export interface HistoryEntry {
  id: string;
  seq: number;
  type: string;
  at: string;
  actor: HistoryActor;
  reason: string | null;
  reversesEventId: string | null;
  reverted: boolean;
  reversal: { kind: 'compensate' | 'void' } | { kind: 'none'; why: string };
  payload: unknown;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  nextBeforeSeq: number | null;
  names: Record<string, string>;
}

export interface TeamList {
  solo: { teamId: string } | null;
  teams: { teamId: string; name: string; active: boolean; memberCount: number }[];
}

export interface TeamDetail {
  teamId: string;
  name: string;
  active: boolean;
  members: { pid: string; displayName: string }[];
  invites: { inviteId: string; expiresAt: string }[];
  banned: string[];
}

export interface Invite {
  inviteId: string;
  url: string;
  expiresAt: string;
}

export interface InviteInfo {
  teamId: string;
  name: string;
  valid: boolean;
}

export interface ViewerView {
  registered: boolean;
  inPool: boolean;
  weight: number;
  lines: { label: string; value: string }[];
}

export interface PublicGiveaway {
  id: string;
  prize: string;
  sponsor: string | null;
  kernel: { id: string; label: string; display: DisplaySpec };
  status: GiveawayStatus;
  channels: { pid: string; displayName: string }[];
  keyword: string | null;
  legal: FrozenLegal | LegalTexts | null;
  claimDays: number;
  counting: Counting;
  winnersCount: number;
}

export interface PortalTile {
  id: string;
  prize: string;
  kernelLabel: string;
  status: GiveawayStatus;
  registered: boolean;
  inPool: boolean;
  weight: number;
  chance: number | null;
  winnerStatus: WinnerStatus | null;
  updatedAt: string;
}

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

export interface PortalDetail extends PublicGiveaway {
  registered: boolean;
  view: ViewerView;
  chance: number | null;
  gates: GateConfig[];
  lastGateResult: GateResult | null;
  winner: { status: WinnerStatus; claimDeadline: string; contact: string | null } | null;
  legalEventId: string | null;
}
