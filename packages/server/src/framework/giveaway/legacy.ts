// Übernahme eines Giveaways aus dem Altsystem (NEW_DESIGN.md 15.3, 15.6): ein Befehl je Alt-Instanz, nur für system:migration.
// Twitch-Daten stehen nur im Befehl. prepare legt Identitäten an, decide schreibt giveaway_created und legacy_imported mit pids.
import { FRAMEWORK_EVENTS, type LegacyImportedPayload, type Pid } from '../../kernel-api/index.js';
import type { TwitchUser } from '../../identity/identities.js';
import { isRejection, reject, type Rejection } from '../../shared/rejection.js';
import { UUID_RE, INVALID_ID } from '../authorize.js';
import type { CommandHandler } from '../command-bus.js';
import { TERMS_TEXT_MAX } from '../legal.js';
import { ANNOUNCEMENT_DEFAULTS } from './announcements.js';
import { checkSettings, type GiveawayDeps } from './lifecycle.js';
import type { ChatBonusSettings } from './services.js';
import type { IdentityResolver } from './signals.js';
import { GIVEAWAY_EVENTS, giveawayStream, type GiveawayState } from './state.js';

export const LEGACY_KERNEL = 'watchtime';
export const MIGRATION_ACTOR = 'system:migration';

export interface LegacyParticipantCmd {
  user: TwitchUser;
  registered: boolean;
  /** Twitch-ID des Kanals → Sekunden (Rohwert, wird gerundet). */
  perChannel: Record<string, number>;
}

export interface ImportLegacyGiveawayCmd {
  giveawayId: string;
  teamId: string;
  legacySessionId: string;
  prize: string;
  sponsor: string | null;
  keyword: string | null;
  coinBaseSec: number;
  /** 0 = keine Follow-Bedingung, sonst „mindestens N Kanälen“. */
  followMin: number;
  chatBonus: ChatBonusSettings;
  channels: TwitchUser[];
  status: 'paused' | 'closed';
  terms: { version: number; text: string } | null;
  participants: LegacyParticipantCmd[];
}

export const MIGRATION_ONLY = (): Rejection => reject('migration_only', 'Diesen Befehl führt nur die Übernahme aus.');
const ALREADY_IMPORTED = (): Rejection => reject('already_imported', 'Dieses Giveaway ist schon übernommen.');

/** Reine Planung aus dem Befehl: welche Nutzer eine Identität brauchen, welche Einträge und Anmeldungen entstehen (nach Twitch-ID). */
export function planLegacyGiveaway(cmd: ImportLegacyGiveawayCmd): {
  users: TwitchUser[];
  entries: { twitchId: string; channelTwitchId: string; sec: number }[];
  registered: string[];
} {
  const users = new Map<string, TwitchUser>();
  for (const ch of cmd.channels) users.set(ch.id, ch);
  const entries: { twitchId: string; channelTwitchId: string; sec: number }[] = [];
  const registered = new Set<string>();
  for (const p of cmd.participants) {
    let used = p.registered;
    for (const [channelTwitchId, raw] of Object.entries(p.perChannel)) {
      const sec = Math.round(raw);
      if (sec < 1) continue;
      entries.push({ twitchId: p.user.id, channelTwitchId, sec });
      used = true;
    }
    if (p.registered) registered.add(p.user.id);
    if (used) users.set(p.user.id, p.user);
  }
  return { users: [...users.values()], entries, registered: [...registered] };
}

export function importLegacyGiveawayHandler(d: GiveawayDeps & { identities: IdentityResolver }): CommandHandler<ImportLegacyGiveawayCmd, GiveawayState, Map<string, Pid>> {
  return {
    type: 'import_legacy_giveaway',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize(cmd, ctx) {
      if (ctx.actor !== MIGRATION_ACTOR) return MIGRATION_ONLY();
      if (typeof cmd.giveawayId !== 'string' || !UUID_RE.test(cmd.giveawayId) || typeof cmd.teamId !== 'string' || !UUID_RE.test(cmd.teamId)) return INVALID_ID();
      return null;
    },
    prepare: async (c, cmd, ctx, _pre, state) => (state.exists ? new Map() : d.identities.create(c, planLegacyGiveaway(cmd).users, ctx.now)),
    decide(state, cmd, _ctx, pids) {
      if (state.exists) return ALREADY_IMPORTED();
      if (!d.kernels.has(LEGACY_KERNEL)) return reject('unknown_kernel', `Den Kern ${LEGACY_KERNEL} gibt es nicht.`);
      const kernel = d.kernels.get(LEGACY_KERNEL);
      if (cmd.status !== 'paused' && cmd.status !== 'closed') return reject('invalid_status', 'Ein übernommenes Giveaway ist Pausiert oder Geschlossen.');
      if (typeof cmd.legacySessionId !== 'string' || !cmd.legacySessionId.trim()) return reject('invalid_session', 'Die Alt-ID des Giveaways fehlt.');
      if (cmd.terms !== null) {
        if (!Number.isInteger(cmd.terms.version) || cmd.terms.version < 1 || typeof cmd.terms.text !== 'string' || !cmd.terms.text.trim() || cmd.terms.text.length > TERMS_TEXT_MAX) {
          return reject('invalid_terms', 'Die Fassung der Teilnahmebedingungen braucht eine Nummer ab 1 und einen Text.');
        }
      }
      if (!Array.isArray(cmd.channels) || cmd.channels.length === 0) return reject('channels_required', 'Wähle mindestens einen Kanal.');
      if (!Number.isInteger(cmd.followMin) || cmd.followMin < 0) return reject('invalid_gate', 'Die Follow-Bedingung braucht eine Zahl ab 0.');
      const pidOf = (twitchId: string): Pid | null => pids.get(twitchId) ?? null;
      const channelPids: Pid[] = [];
      for (const ch of cmd.channels) {
        const pid = pidOf(ch.id);
        if (pid === null) return reject('unknown_channel', `Der Kanal ${ch.login} hat keine Identität.`);
        if (!channelPids.includes(pid)) channelPids.push(pid);
      }
      const channelOf = new Map(cmd.channels.map((ch) => [ch.id, pidOf(ch.id)!]));
      const plan = planLegacyGiveaway(cmd);
      const entries: LegacyImportedPayload['entries'] = [];
      for (const e of plan.entries) {
        const channel = channelOf.get(e.channelTwitchId);
        const pid = pidOf(e.twitchId);
        if (channel === undefined) return reject('unknown_channel', `Ein Teilnehmer hat Zeit auf einem Kanal, der nicht zum Giveaway gehört (${e.channelTwitchId}).`);
        if (pid === null) return reject('unknown_participant', 'Ein Teilnehmer hat keine Identität.');
        entries.push({ pid, channel, sec: e.sec });
      }
      const registered: Pid[] = [];
      for (const twitchId of plan.registered) {
        const pid = pidOf(twitchId);
        if (pid === null) return reject('unknown_participant', 'Ein Teilnehmer hat keine Identität.');
        registered.push(pid);
      }
      registered.sort();
      const settings = checkSettings(kernel, {
        config: { coinBaseSec: cmd.coinBaseSec },
        prize: cmd.prize,
        sponsor: cmd.sponsor,
        channels: channelPids,
        winnersCount: 1,
        claimDays: 14,
        gates: cmd.followMin >= 1 ? [{ id: 'follow', mode: 'min', min: cmd.followMin }] : [],
        legal: cmd.terms === null ? null : { impressumUrl: null, terms: { text: cmd.terms.text }, privacyUrl: null },
        contact: null,
        counting: 'first_seen',
        purgeDays: 7,
        keyword: cmd.keyword,
        chatBonus: cmd.chatBonus,
        announcements: ANNOUNCEMENT_DEFAULTS,
      });
      if (isRejection(settings)) return settings;
      const imported: LegacyImportedPayload = { legacySessionId: cmd.legacySessionId, status: cmd.status, terms: cmd.terms, registered, entries };
      return [
        { type: GIVEAWAY_EVENTS.created, payload: { teamId: cmd.teamId, kernelId: LEGACY_KERNEL, kernelVersion: kernel.version, settings } },
        { type: FRAMEWORK_EVENTS.legacyImported, payload: imported },
      ];
    },
  };
}
