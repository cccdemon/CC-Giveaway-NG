// Befehl apply_signals (NEW_DESIGN.md 3.1, 6.1, 6.2, 6.4): Der Ingest liefert je Kanal und Minute ein Bündel. Der Rahmen prüft
// Rechte, Zustand und Kanalzugehörigkeit, löst Twitch-IDs zu pids auf und erzeugt daraus Anmeldung per Keyword,
// Zuschauzeit (watch_credited) und Chat-Bonus (chat_credited). decide ist rein, prepare schreibt nur identities.
import type pg from 'pg';
import type { Queryable } from '../../db/pool.js';
import type { SignalUser } from '../../ingest/signals.js';
import type { NewEvent } from '../../journal/types.js';
import { FRAMEWORK_EVENTS, type AnyKernel, type KernelCommandSpec, type KernelEvent, type Pid } from '../../kernel-api/index.js';
import { isRejection, reject, type Rejection } from '../../shared/rejection.js';
import type { CommandContext, CommandHandler } from '../command-bus.js';
import { GIVEAWAY_NOT_FOUND, INVALID_ID, UUID_RE, loadGiveawayRow } from './authorize.js';
import type { GiveawayDeps } from './lifecycle.js';
import { MINUTE_RE, boostFactor } from './services.js';
import { GIVEAWAY_EVENTS, fromKernelEvents, giveawayStream, type GiveawayState } from './state.js';

export { MINUTE_RE } from './services.js';

/** Zuordnung Twitch-ID → pid über identities. Die Umsetzung liegt in identity/resolver.ts. */
export interface IdentityResolver {
  resolve(c: Queryable, twitchIds: string[]): Promise<Map<string, Pid>>;
  /** Legt fehlende Identitäten an (Zählweise „ab erstem Erscheinen“, Keyword). Liefert alle übergebenen Nutzer. */
  create(c: pg.PoolClient, users: SignalUser[], now: Date): Promise<Map<string, Pid>>;
  touch(c: Queryable, pids: Pid[], now: Date): Promise<void>;
}

export const noIdentities: IdentityResolver = {
  resolve: async () => new Map(),
  create: async () => new Map(),
  touch: async () => {},
};

/** Kanäle, die live sind und Signale liefern (channel_status). Die Umsetzung liegt in ingest/channel-status.ts. */
export interface ChannelActivity {
  active(db: Queryable, channels: Pid[], now: Date): Promise<Set<Pid>>;
}

export const noActivity: ChannelActivity = { active: async () => new Set() };
/** Für Tests: jeder Kanal gilt als aktiv. */
export const allActive: ChannelActivity = { active: async (_db, channels) => new Set(channels) };

export interface ApplySignalsCmd {
  giveawayId: string;
  channel: Pid;
  /** ISO auf volle Minute. */
  minute: string;
  presence: SignalUser[] | null;
  chat: { user: SignalUser; at: string; text: string; messageId: string }[];
  follows: { user: SignalUser; at: string }[];
}

export interface ResolvedSignals {
  presence: Pid[] | null;
  chat: { pid: Pid; at: string; text: string; messageId: string }[];
  follows: { pid: Pid; at: string }[];
  /** Nutzer ohne Identität, weggefallen. */
  unknown: number;
  /** In diesem Befehl angelegte Identitäten. */
  created: number;
  /** Der Kanal ist live und liefert Signale. */
  live: boolean;
  /** Im Team gesperrte pids, aus allen Signalen entfernt (NEW_DESIGN.md 15.3). */
  banned: Pid[];
  /** Der Kanal gehört noch zum Team (Mitglied). Ohne Verzeichnis immer true. */
  inTeam: boolean;
}

export type ApplySignalsDeps = GiveawayDeps & { identities: IdentityResolver; activity: ChannelActivity };

export const WATCH_SEC_PER_MINUTE = 60;

/** Platzhalter-pid für einen Nutzer ohne Identität, solange die Planung läuft. Nie im Journal. */
const UNKNOWN_PREFIX = 'unknown:';

interface Resolved {
  presence: Pid[] | null;
  chat: { pid: Pid; at: string; text: string; messageId: string }[];
  follows: { pid: Pid; at: string }[];
}

/** Löst Nutzer zu pids auf und lässt Gesperrte weg: Sie bekommen weder Anmeldung noch Gutschrift noch Identität. */
function resolveWith(cmd: ApplySignalsCmd, map: Map<string, Pid>, banned: ReadonlySet<Pid>): Resolved {
  const pidOf = (u: SignalUser): Pid | undefined => {
    const pid = map.get(u.id);
    return pid !== undefined && !banned.has(pid) ? pid : undefined;
  };
  return {
    presence: cmd.presence === null ? null : [...new Set(cmd.presence.map(pidOf).filter((p): p is Pid => p !== undefined))],
    chat: cmd.chat.flatMap((x) => {
      const pid = pidOf(x.user);
      return pid === undefined ? [] : [{ pid, at: x.at, text: x.text, messageId: x.messageId }];
    }),
    follows: cmd.follows.flatMap((x) => {
      const pid = pidOf(x.user);
      return pid === undefined ? [] : [{ pid, at: x.at }];
    }),
  };
}

/**
 * Rein: welche Ereignisse ein Bündel im gegebenen Zustand erzeugt (6.1, 6.2, 6.4). prepare plant damit, welche Nutzer eine
 * Identität brauchen (nur wer eine Anmeldung oder Gutschrift bekommt), decide schreibt genau dieses Ergebnis.
 */
export function planSignals(state: GiveawayState, kernel: AnyKernel, channel: Pid, minute: string, p: Resolved, live: boolean): NewEvent[] {
  const s = state.settings;
  const events: NewEvent[] = [];
  const registered = new Set(Object.keys(state.registered));
  const chat = [...p.chat].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // 1. Chat in Zeitfolge: Anmeldung per Keyword (6.4, dieselben Regeln wie register) und Kern-Befehle (8.3, „!ticket <n>“).
  // Der Kern-Zustand läuft mit jedem geplanten Ereignis mit, damit die zweite Nachricht die erste sieht.
  const chatSpecs = kernel.commands.filter((c) => c.chat !== undefined && c.issuer === 'participant');
  let kernelState = state.kernelState;
  const pending = (e: NewEvent, at: string): KernelEvent => ({ id: '', type: e.type, payload: e.payload, at, reversesEventId: null });
  const push = (e: NewEvent, at: string): void => {
    events.push(e);
    kernelState = kernel.reduce(kernelState, pending(e, at), s.config);
  };
  for (const m of chat) {
    if (s.keyword !== null && keywordMatches(m.text, s.keyword)) {
      if (registered.has(m.pid) || kernel.gateRegistration?.(kernelState, s.config, m.at)) continue;
      registered.add(m.pid);
      push({ type: GIVEAWAY_EVENTS.registered, payload: { pid: m.pid } }, m.at);
      continue;
    }
    if (chatSpecs.length === 0 || !kernel.decide) continue;
    const c = chatCommandOf(m.text, chatSpecs);
    if (c === null) continue;
    // Eine Ablehnung verwirft die Nachricht still. Antworten im Chat kommen mit den Ansagen (Teilprojekt 8).
    const out = kernel.decide(kernelState, { type: c.type, pid: m.pid, args: { count: c.count } }, s.config, m.at);
    if (isRejection(out)) continue;
    for (const e of fromKernelEvents(kernel, out)) push(e, m.at);
  }

  const eligible = (pid: Pid): boolean => s.counting === 'first_seen' || registered.has(pid);
  const factor = boostFactor(state.boost, minute);

  // 2. Zuschauzeit (6.1): eine Buchung je Kanal und Minute, nie eine Minute doppelt oder rückwärts. Nur Kerne mit dem Dienst.
  const lastMinute = state.watchMinutes[channel];
  if (kernel.usesServices.includes('watchtime') && p.presence !== null && (lastMinute === undefined || Date.parse(minute) > Date.parse(lastMinute))) {
    const entries = p.presence.filter(eligible).map((pid) => ({ pid, sec: WATCH_SEC_PER_MINUTE }));
    if (entries.length > 0) events.push({ type: FRAMEWORK_EVENTS.watchCredited, payload: { minute, channel, factor, entries } });
  }

  // 3. Chat-Bonus (6.2): ab minWords Wörtern, Cooldown über den Zustand, nur für aktive Kanäle und Kerne mit dem Dienst.
  if (kernel.usesServices.includes('chatBonus') && s.chatBonus.enabled && live) {
    const last: Record<Pid, string> = { ...state.chatLast };
    const sum = new Map<Pid, { sec: number; lastAt: string }>();
    for (const m of chat) {
      if (!eligible(m.pid) || wordCount(m.text) < s.chatBonus.minWords) continue;
      const prev = last[m.pid];
      if (prev !== undefined && Date.parse(m.at) - Date.parse(prev) < s.chatBonus.cooldownSec * 1000) continue;
      last[m.pid] = m.at;
      sum.set(m.pid, { sec: (sum.get(m.pid)?.sec ?? 0) + s.chatBonus.sec, lastAt: m.at });
    }
    if (sum.size > 0) {
      const entries = [...sum].map(([pid, v]) => ({ pid, sec: v.sec, lastAt: v.lastAt }));
      events.push({ type: FRAMEWORK_EVENTS.chatCredited, payload: { minute, channel, factor, entries } });
    }
  }
  return events;
}

/** Alle pids, die in geplanten Ereignissen vorkommen. */
function pidsIn(events: NewEvent[]): Set<Pid> {
  const out = new Set<Pid>();
  for (const e of events) {
    const p = e.payload as { pid?: Pid; entries?: { pid: Pid }[] };
    if (typeof p.pid === 'string') out.add(p.pid);
    for (const x of p.entries ?? []) out.add(x.pid);
  }
  return out;
}

const NOT_INGEST = (): Rejection => reject('not_ingest', 'Signale nimmt nur der Ingest an.');
const NOT_OPEN = (): Rejection => reject('not_open', 'Das Giveaway sammelt gerade nicht. Signale gehen nur im Zustand Offen.');
const INVALID_MINUTE = (): Rejection => reject('invalid_minute', 'Die Minute muss ein ISO-Zeitpunkt auf volle Minute sein.');
const INVALID_SIGNALS = (): Rejection => reject('invalid_signals', 'Die Signale sind ungültig.');

const COUNT_WORD_RE = /^\d{1,5}$/;

/**
 * Erstes Wort gleich dem Chat-Wort eines Kern-Befehls (Groß-/Kleinschreibung egal). Das zweite Wort ist count (ganze Zahl ≥ 1),
 * fehlt es, gilt 1. Ein anderes zweites Wort macht die Nachricht zu keinem Befehl.
 */
export function chatCommandOf(text: string, specs: readonly KernelCommandSpec[]): { type: string; count: number } | null {
  const [first = '', second] = text.trim().split(/\s+/);
  if (first.length === 0) return null;
  const spec = specs.find((c) => c.chat !== undefined && c.chat.word.toLowerCase() === first.toLowerCase());
  if (!spec) return null;
  if (second === undefined) return { type: spec.type, count: 1 };
  if (!COUNT_WORD_RE.test(second)) return null;
  const count = Number(second);
  return count >= 1 ? { type: spec.type, count } : null;
}

/** Erstes Wort der Nachricht gleich Keyword, Groß-/Kleinschreibung egal. */
export function keywordMatches(text: string, keyword: string): boolean {
  const first = text.trim().split(/\s+/)[0] ?? '';
  return first.length > 0 && first.toLowerCase() === keyword.toLowerCase();
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

const isUser = (u: unknown): u is SignalUser => typeof u === 'object' && u !== null && typeof (u as SignalUser).id === 'string';
const isTime = (t: unknown): t is string => typeof t === 'string' && !Number.isNaN(Date.parse(t));

function checkShape(cmd: ApplySignalsCmd): Rejection | null {
  if (typeof cmd.giveawayId !== 'string' || !UUID_RE.test(cmd.giveawayId) || typeof cmd.channel !== 'string' || !UUID_RE.test(cmd.channel)) return INVALID_ID();
  if (typeof cmd.minute !== 'string' || !MINUTE_RE.test(cmd.minute)) return INVALID_MINUTE();
  if ((cmd.presence !== null && !Array.isArray(cmd.presence)) || !Array.isArray(cmd.chat) || !Array.isArray(cmd.follows)) return INVALID_SIGNALS();
  if (cmd.presence !== null && !cmd.presence.every(isUser)) return INVALID_SIGNALS();
  if (!cmd.chat.every((m) => isUser(m?.user) && isTime(m.at) && typeof m.text === 'string')) return INVALID_SIGNALS();
  if (!cmd.follows.every((f) => isUser(f?.user) && isTime(f.at))) return INVALID_SIGNALS();
  return null;
}

function uniqueUsers(users: SignalUser[]): SignalUser[] {
  const seen = new Set<string>();
  return users.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
}

export function applySignalsHandler(d: ApplySignalsDeps): CommandHandler<ApplySignalsCmd, GiveawayState, ResolvedSignals> {
  async function authorize(cmd: ApplySignalsCmd, ctx: CommandContext, c: pg.PoolClient): Promise<Rejection | null> {
    if (ctx.actor !== 'system:ingest') return NOT_INGEST();
    const shape = checkShape(cmd);
    if (shape) return shape;
    const row = await loadGiveawayRow(c, cmd.giveawayId);
    if (!row) return GIVEAWAY_NOT_FOUND();
    if (row.status !== 'open') return NOT_OPEN();
    return null;
  }

  return {
    type: 'apply_signals',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize,
    async prepare(c, cmd, ctx, _pre, state) {
      const users = uniqueUsers([...(cmd.presence ?? []), ...cmd.chat.map((x) => x.user), ...cmd.follows.map((x) => x.user)]);
      const ids = users.map((u) => u.id);
      const map = await d.identities.resolve(c, ids);
      const live = (await d.activity.active(c, [cmd.channel], ctx.now)).has(cmd.channel);
      const banned = state.exists ? await d.bans.bannedOf(c, state.teamId) : new Set<Pid>();
      // Der Kanal eines ausgetretenen Mitglieds sammelt nicht weiter für das Team (9.3, Festlegung 5).
      const team = state.exists ? await d.teams.channelsOf(c, state.teamId) : null;
      const inTeam = team === null || team.channels.has(cmd.channel);
      let created = 0;
      // Eine Identität bekommt nur, wer in diesem Befehl eine Anmeldung oder Gutschrift bekäme (6.1: „Für andere entsteht keine pid“).
      if (state.exists && state.status === 'open' && inTeam && state.settings.channels.includes(cmd.channel)) {
        const unknown = users.filter((u) => !map.has(u.id));
        const trial = new Map([...map, ...unknown.map((u): [string, Pid] => [u.id, `${UNKNOWN_PREFIX}${u.id}`])]);
        const planned = pidsIn(planSignals(state, d.kernels.get(state.kernelId), cmd.channel, cmd.minute, resolveWith(cmd, trial, banned), live));
        const toCreate = unknown.filter((u) => planned.has(`${UNKNOWN_PREFIX}${u.id}`));
        if (toCreate.length > 0) {
          const made = await d.identities.create(c, toCreate, ctx.now);
          for (const [id, pid] of made) map.set(id, pid);
          created = made.size;
        }
      }
      const resolved = resolveWith(cmd, map, banned);
      await d.identities.touch(c, resolved.presence ?? [], ctx.now);
      return { ...resolved, unknown: ids.filter((id) => !map.has(id)).length, created, live, banned: [...banned].sort(), inTeam };
    },
    decide(state, cmd, _ctx, p) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'open') return NOT_OPEN();
      if (!state.settings.channels.includes(cmd.channel)) return reject('channel_not_in_giveaway', 'Dieser Kanal gehört nicht zum Giveaway.');
      if (!p.inTeam) return reject('channel_not_in_team', 'Dieser Kanal gehört nicht zum Team.');
      return planSignals(state, d.kernels.get(state.kernelId), cmd.channel, cmd.minute, p, p.live);
    },
  };
}
