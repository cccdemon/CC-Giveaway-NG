// Befehl apply_signals (NEW_DESIGN.md 3.1, 6.1): Der Ingest liefert je Kanal und Minute ein Bündel. Der Rahmen prüft
// Rechte, Zustand und Kanalzugehörigkeit und löst Twitch-IDs zu pids auf. Ereignisse daraus erzeugt Teilprojekt 5.
import type pg from 'pg';
import type { Queryable } from '../../db/pool.js';
import type { SignalUser } from '../../ingest/signals.js';
import type { Pid } from '../../kernel-api/index.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import type { CommandContext, CommandHandler } from '../command-bus.js';
import { GIVEAWAY_NOT_FOUND, INVALID_ID, UUID_RE, loadGiveawayRow } from './authorize.js';
import type { GiveawayDeps } from './lifecycle.js';
import { giveawayStream, type GiveawayState } from './state.js';

/** Zuordnung Twitch-ID → pid über identities. Die Umsetzung liegt in identity/resolver.ts. */
export interface IdentityResolver {
  resolve(c: Queryable, twitchIds: string[]): Promise<Map<string, Pid>>;
  touch(c: Queryable, pids: Pid[], now: Date): Promise<void>;
}

export const noIdentities: IdentityResolver = {
  resolve: async () => new Map(),
  touch: async () => {},
};

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
}

export const MINUTE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;

const NOT_INGEST = (): Rejection => reject('not_ingest', 'Signale nimmt nur der Ingest an.');
const NOT_OPEN = (): Rejection => reject('not_open', 'Das Giveaway sammelt gerade nicht. Signale gehen nur im Zustand Offen.');
const INVALID_MINUTE = (): Rejection => reject('invalid_minute', 'Die Minute muss ein ISO-Zeitpunkt auf volle Minute sein.');
const INVALID_SIGNALS = (): Rejection => reject('invalid_signals', 'Die Signale sind ungültig.');

function checkShape(cmd: ApplySignalsCmd): Rejection | null {
  if (typeof cmd.giveawayId !== 'string' || !UUID_RE.test(cmd.giveawayId) || typeof cmd.channel !== 'string' || !UUID_RE.test(cmd.channel)) return INVALID_ID();
  if (typeof cmd.minute !== 'string' || !MINUTE_RE.test(cmd.minute)) return INVALID_MINUTE();
  if ((cmd.presence !== null && !Array.isArray(cmd.presence)) || !Array.isArray(cmd.chat) || !Array.isArray(cmd.follows)) return INVALID_SIGNALS();
  return null;
}

export function applySignalsHandler(d: GiveawayDeps & { identities: IdentityResolver }): CommandHandler<ApplySignalsCmd, GiveawayState, ResolvedSignals> {
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
    async prepare(c, cmd, ctx) {
      const users = [...(cmd.presence ?? []), ...cmd.chat.map((x) => x.user), ...cmd.follows.map((x) => x.user)];
      const ids = [...new Set(users.map((u) => u.id))];
      const map = await d.identities.resolve(c, ids);
      const present = cmd.presence === null ? null : cmd.presence.map((u) => map.get(u.id)).filter((p): p is Pid => p !== undefined);
      await d.identities.touch(c, present ?? [], ctx.now);
      const chat = cmd.chat.flatMap((x) => (map.has(x.user.id) ? [{ pid: map.get(x.user.id)!, at: x.at, text: x.text, messageId: x.messageId }] : []));
      const follows = cmd.follows.flatMap((x) => (map.has(x.user.id) ? [{ pid: map.get(x.user.id)!, at: x.at }] : []));
      return { presence: present, chat, follows, unknown: ids.filter((id) => !map.has(id)).length };
    },
    decide(state, cmd) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'open') return NOT_OPEN();
      if (!state.settings.channels.includes(cmd.channel)) return reject('channel_not_in_giveaway', 'Dieser Kanal gehört nicht zum Giveaway.');
      // Teilprojekt 5: Zuschauzeit und Chat-Bonus erzeugen hier Ereignisse aus prepared.
      return [];
    },
  };
}
