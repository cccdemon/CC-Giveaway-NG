// Befehl apply_signals (NEW_DESIGN.md 3.1, 6.1, 6.2, 6.4): Der Ingest liefert je Kanal und Minute ein Bündel. Der Rahmen prüft
// Rechte, Zustand und Kanalzugehörigkeit, löst Twitch-IDs zu pids auf und erzeugt daraus Anmeldung per Keyword,
// Zuschauzeit (watch_credited) und Chat-Bonus (chat_credited). decide ist rein, prepare schreibt nur identities.
import type pg from 'pg';
import type { Queryable } from '../../db/pool.js';
import type { SignalUser } from '../../ingest/signals.js';
import type { NewEvent } from '../../journal/types.js';
import { FRAMEWORK_EVENTS, type Pid } from '../../kernel-api/index.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import type { CommandContext, CommandHandler } from '../command-bus.js';
import { GIVEAWAY_NOT_FOUND, INVALID_ID, UUID_RE, loadGiveawayRow } from './authorize.js';
import type { GiveawayDeps } from './lifecycle.js';
import { MINUTE_RE, boostFactor } from './services.js';
import { GIVEAWAY_EVENTS, giveawayStream, type GiveawayState } from './state.js';

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
}

export type ApplySignalsDeps = GiveawayDeps & { identities: IdentityResolver; activity: ChannelActivity };

export const WATCH_SEC_PER_MINUTE = 60;

const NOT_INGEST = (): Rejection => reject('not_ingest', 'Signale nimmt nur der Ingest an.');
const NOT_OPEN = (): Rejection => reject('not_open', 'Das Giveaway sammelt gerade nicht. Signale gehen nur im Zustand Offen.');
const INVALID_MINUTE = (): Rejection => reject('invalid_minute', 'Die Minute muss ein ISO-Zeitpunkt auf volle Minute sein.');
const INVALID_SIGNALS = (): Rejection => reject('invalid_signals', 'Die Signale sind ungültig.');

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

  /** Wer ohne Identität eine bekommt: „ab erstem Erscheinen“ alle Anwesenden und Schreiber, sonst nur Keyword-Schreiber. */
  function creatable(state: GiveawayState, cmd: ApplySignalsCmd, unknownUsers: SignalUser[]): SignalUser[] {
    const { counting, keyword } = state.settings;
    if (counting === 'first_seen') {
      const active = new Set([...(cmd.presence ?? []), ...cmd.chat.map((m) => m.user)].map((u) => u.id));
      return unknownUsers.filter((u) => active.has(u.id));
    }
    if (keyword === null) return [];
    const keyworded = new Set(cmd.chat.filter((m) => keywordMatches(m.text, keyword)).map((m) => m.user.id));
    return unknownUsers.filter((u) => keyworded.has(u.id));
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
      const toCreate = creatable(state, cmd, users.filter((u) => !map.has(u.id)));
      let created = 0;
      if (toCreate.length > 0) {
        const made = await d.identities.create(c, toCreate, ctx.now);
        for (const [id, pid] of made) map.set(id, pid);
        created = made.size;
      }
      const present = cmd.presence === null ? null : [...new Set(cmd.presence.map((u) => map.get(u.id)).filter((p): p is Pid => p !== undefined))];
      await d.identities.touch(c, present ?? [], ctx.now);
      const chat = cmd.chat.flatMap((x) => (map.has(x.user.id) ? [{ pid: map.get(x.user.id)!, at: x.at, text: x.text, messageId: x.messageId }] : []));
      const follows = cmd.follows.flatMap((x) => (map.has(x.user.id) ? [{ pid: map.get(x.user.id)!, at: x.at }] : []));
      const live = (await d.activity.active(c, [cmd.channel], ctx.now)).has(cmd.channel);
      return { presence: present, chat, follows, unknown: ids.filter((id) => !map.has(id)).length, created, live };
    },
    decide(state, cmd, _ctx, p) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'open') return NOT_OPEN();
      const s = state.settings;
      if (!s.channels.includes(cmd.channel)) return reject('channel_not_in_giveaway', 'Dieser Kanal gehört nicht zum Giveaway.');

      const events: NewEvent[] = [];
      const registered = new Set(Object.keys(state.registered));
      const chat = [...p.chat].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

      // 1. Anmeldung per Keyword (6.4), mit denselben Regeln wie der Befehl register.
      if (s.keyword !== null) {
        const kernel = d.kernels.get(state.kernelId);
        for (const m of chat) {
          if (registered.has(m.pid) || !keywordMatches(m.text, s.keyword)) continue;
          if (kernel.gateRegistration?.(state.kernelState, s.config, m.at)) continue;
          registered.add(m.pid);
          events.push({ type: GIVEAWAY_EVENTS.registered, payload: { pid: m.pid } });
        }
      }

      const eligible = (pid: Pid): boolean => s.counting === 'first_seen' || registered.has(pid);
      const factor = boostFactor(state.boost, cmd.minute);

      // 2. Zuschauzeit (6.1): eine Buchung je Kanal und Minute, nie eine Minute doppelt oder rückwärts.
      const lastMinute = state.watchMinutes[cmd.channel];
      if (p.presence !== null && (lastMinute === undefined || Date.parse(cmd.minute) > Date.parse(lastMinute))) {
        const entries = p.presence.filter(eligible).map((pid) => ({ pid, sec: WATCH_SEC_PER_MINUTE }));
        if (entries.length > 0) events.push({ type: FRAMEWORK_EVENTS.watchCredited, payload: { minute: cmd.minute, channel: cmd.channel, factor, entries } });
      }

      // 3. Chat-Bonus (6.2): ab minWords Wörtern, Cooldown über den Zustand, nur für aktive Kanäle.
      if (s.chatBonus.enabled && p.live) {
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
          events.push({ type: FRAMEWORK_EVENTS.chatCredited, payload: { minute: cmd.minute, channel: cmd.channel, factor, entries } });
        }
      }
      return events;
    },
  };
}
