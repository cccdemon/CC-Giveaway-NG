// Lebenszyklus-Befehle des Stroms giveaway:<id> (NEW_DESIGN.md 7.1).
import type { AnyKernel, Pid } from '../../kernel-api/index.js';
import type { EventTypeRegistry } from '../../journal/event-types.js';
import { canonicalJson } from '../../shared/canonical.js';
import { isRejection, reject, type Rejection } from '../../shared/rejection.js';
import type { CommandHandler, StreamReducer } from '../command-bus.js';
import { validateConfig } from '../kernel-config.js';
import type { KernelRegistry } from '../kernel-registry.js';
import { checkLegal } from '../legal.js';
import { makeRevertHandler, type RevertCommand, type RevertPrepared } from '../revert.js';
import { TEAM_INACTIVE } from '../team/commands.js';
import type { BanDirectory, TeamChannels, TeamDirectory } from '../team/directory.js';
import { GIVEAWAY_NOT_FOUND, INVALID_ID, UUID_RE, authorizeControl, type GiveawayAuthorizer } from './authorize.js';
import { checkGateConfig, type GateConfig } from './gates.js';
import { KEYWORD_RE, PURGE_DAYS_MAX, PURGE_DAYS_MIN, SERVICE_DEFAULTS, chatBonusSchema, countingSchema, type ChatBonusSettings } from './services.js';
import {
  GIVEAWAY_EVENTS,
  TRANSITIONS,
  fromKernelEvents,
  giveawayStream,
  type GiveawaySettings,
  type GiveawayState,
  type GiveawayStatus,
} from './state.js';

export interface GiveawayDeps {
  kernels: KernelRegistry;
  auth: GiveawayAuthorizer;
  reducer: StreamReducer<GiveawayState>;
  /** Kanäle und Aktivität des Teams (NEW_DESIGN.md 9.3). Default anyChannels prüft nichts. */
  teams: TeamDirectory;
  /** Team-weite Sperren (NEW_DESIGN.md 15.3). Default noBans. */
  bans: BanDirectory;
}

const CHANNEL_NOT_IN_TEAM = (): Rejection => reject('channel_not_in_team', 'Dieser Kanal gehört nicht zum Team.');

/** Ein Kanal außerhalb der Team-Kanäle? Ohne Verzeichnis (null) keine Prüfung. */
function outsideTeam(channels: Pid[], team: TeamChannels): boolean {
  return team !== null && channels.some((ch) => !team.channels.has(ch));
}

export interface CreateGiveawayCmd {
  giveawayId: string;
  teamId: string;
  kernelId: string;
  settings: Partial<GiveawaySettings> & { prize: string; channels: Pid[] };
}

export interface GiveawayCmd {
  giveawayId: string;
}

export interface ChangeSettingsCmd {
  giveawayId: string;
  settings: Partial<GiveawaySettings>;
}

export type TransitionType =
  | 'open_giveaway'
  | 'pause_giveaway'
  | 'resume_giveaway'
  | 'close_giveaway'
  | 'reopen_giveaway'
  | 'cancel_giveaway'
  | 'complete_giveaway';

export const STATUS_LABEL: Record<GiveawayStatus, string> = {
  draft: 'Entwurf',
  open: 'Offen',
  paused: 'Pausiert',
  closed: 'Geschlossen',
  drawn: 'Gezogen',
  completed: 'Abgeschlossen',
  cancelled: 'Abgebrochen',
};

/** Ziel je Befehl. `from` grenzt über TRANSITIONS hinaus ein (null = nur die Tabelle). */
const TRANSITION_SPEC: Record<TransitionType, { to: GiveawayStatus; from: readonly GiveawayStatus[] | null; label: string }> = {
  open_giveaway: { to: 'open', from: ['draft'], label: 'Öffnen' },
  pause_giveaway: { to: 'paused', from: null, label: 'Pausieren' },
  resume_giveaway: { to: 'open', from: ['paused'], label: 'Fortsetzen' },
  close_giveaway: { to: 'closed', from: null, label: 'Schließen' },
  reopen_giveaway: { to: 'open', from: ['closed'], label: 'Wieder öffnen' },
  cancel_giveaway: { to: 'cancelled', from: null, label: 'Abbrechen' },
  complete_giveaway: { to: 'completed', from: ['drawn'], label: 'Abschließen' },
};

const SETTINGS_OPEN: readonly GiveawayStatus[] = ['draft', 'open', 'paused'];
/** Grund der Umkehrungen, die ein Kern beim Abbruch schreibt. */
const CANCEL_REASON = 'Abbruch des Giveaways.';
const SETTINGS_LOCKED = (): Rejection => reject('settings_locked', 'Nach dem Schließen änderst du keine Regeln mehr.');

const TEXT_MAX = 200;
const INVALID_GATE = (): Rejection => reject('invalid_gate', 'Eine Bedingung ist ungültig.');

/** Prüft vollständige Einstellungen gegen den Kern. Liefert sie mit geprüfter config zurück. */
function checkSettings(kernel: AnyKernel, s: GiveawaySettings): GiveawaySettings | Rejection {
  const config = validateConfig(kernel.configSchema, s.config);
  if (isRejection(config)) return config;
  if (typeof s.prize !== 'string' || !s.prize.trim()) return reject('prize_required', 'Gib an, was es zu gewinnen gibt.');
  if (s.prize.length > TEXT_MAX) return reject('prize_too_long', 'Der Gewinn darf höchstens 200 Zeichen haben.');
  if (s.sponsor !== null && (typeof s.sponsor !== 'string' || s.sponsor.length > TEXT_MAX)) {
    return reject('sponsor_too_long', 'Der Sponsor darf höchstens 200 Zeichen haben.');
  }
  if (!Array.isArray(s.channels) || s.channels.length === 0) return reject('channels_required', 'Wähle mindestens einen Kanal.');
  if (!s.channels.every((ch: unknown) => typeof ch === 'string' && UUID_RE.test(ch))) {
    return reject('invalid_channel', 'Ein Kanal ist keine gültige ID.');
  }
  if (!Number.isInteger(s.winnersCount) || s.winnersCount < 1 || s.winnersCount > 100) {
    return reject('invalid_winners_count', 'Die Gewinnerzahl muss zwischen 1 und 100 liegen.');
  }
  if (!Number.isInteger(s.claimDays) || s.claimDays < 1 || s.claimDays > 90) {
    return reject('invalid_claim_days', 'Die Meldefrist muss zwischen 1 und 90 Tagen liegen.');
  }
  if (s.legal !== null) {
    const legal = checkLegal(s.legal);
    if (isRejection(legal)) return legal;
    s = { ...s, legal };
  }
  if (!countingSchema.safeParse(s.counting).success) return reject('invalid_counting', 'Wähle die Zählweise ab Anmeldung oder ab erstem Erscheinen.');
  if (s.counting === 'first_seen' && !kernel.usesServices.includes('watchtime')) {
    return reject('invalid_counting', 'Die Zählweise ab erstem Erscheinen gibt es nur mit Zuschauzeit.');
  }
  if (!Number.isInteger(s.purgeDays) || s.purgeDays < PURGE_DAYS_MIN || s.purgeDays > PURGE_DAYS_MAX) {
    return reject('invalid_purge_days', 'Die Löschfrist muss zwischen 1 und 90 Tagen liegen.');
  }
  if (s.keyword !== null && (typeof s.keyword !== 'string' || !KEYWORD_RE.test(s.keyword))) {
    return reject('invalid_keyword', 'Das Keyword ist ein Wort mit 2 bis 32 Zeichen ohne Leerzeichen.');
  }
  // Sonst hieße dasselbe Wort zugleich Anmeldung und Kern-Befehl (Teilprojekt 6, Festlegung 6).
  if (s.keyword !== null && kernel.commands.some((c) => c.chat?.word.toLowerCase() === s.keyword!.toLowerCase())) {
    return reject('keyword_reserved', 'Dieses Wort ist ein Chat-Befehl des Kerns. Wähle ein anderes Keyword.');
  }
  if (!chatBonusSchema.safeParse(s.chatBonus).success) return reject('invalid_chat_bonus', 'Die Chat-Bonus-Regeln sind ungültig.');
  if (!Array.isArray(s.gates)) return INVALID_GATE();
  const gates: GateConfig[] = [];
  for (const g of s.gates as unknown[]) {
    if (typeof g !== 'object' || g === null || Array.isArray(g)) return INVALID_GATE();
    const id = (g as { id?: unknown }).id;
    if (typeof id !== 'string' || !(kernel.supportedGates as readonly string[]).includes(id)) {
      return reject('gate_unsupported', `Die Bedingung ${String(id)} gibt es für diesen Kern nicht.`);
    }
    const checked = checkGateConfig(g, s.channels);
    if (isRejection(checked)) return checked;
    gates.push(checked);
  }
  return { ...s, config: config.value as Record<string, unknown>, gates };
}

function validIds(cmd: { giveawayId: unknown; teamId: unknown }): boolean {
  return typeof cmd.giveawayId === 'string' && UUID_RE.test(cmd.giveawayId) && typeof cmd.teamId === 'string' && UUID_RE.test(cmd.teamId);
}

export function createGiveawayHandler(d: GiveawayDeps): CommandHandler<CreateGiveawayCmd, GiveawayState, TeamChannels> {
  return {
    type: 'create_giveaway',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    // Ohne gültige IDs scheitert schon die Stromsperre (assertStreamId). Darum hier, vor der Sperre.
    authorize: (cmd, ctx, c) => (validIds(cmd) ? d.auth.controls(c, ctx.actor, cmd.teamId) : INVALID_ID()),
    prepare: async (c, cmd) => (validIds(cmd) ? d.teams.channelsOf(c, cmd.teamId) : null),
    decide(state, cmd, _ctx, team) {
      if (!validIds(cmd)) return INVALID_ID();
      if (state.exists) return reject('already_exists', 'Dieses Giveaway gibt es schon.');
      if (!d.kernels.has(cmd.kernelId)) {
        return reject('unknown_kernel', `Den Kern ${cmd.kernelId} gibt es nicht. Wähle einen anderen Kern.`);
      }
      const kernel = d.kernels.get(cmd.kernelId);
      const s = cmd.settings;
      const settings = checkSettings(kernel, {
        config: s.config ?? {},
        prize: s.prize,
        sponsor: s.sponsor ?? null,
        channels: s.channels,
        winnersCount: s.winnersCount ?? 1,
        claimDays: s.claimDays ?? 14,
        gates: s.gates ?? [],
        legal: s.legal ?? null,
        counting: s.counting ?? SERVICE_DEFAULTS.counting,
        purgeDays: s.purgeDays ?? SERVICE_DEFAULTS.purgeDays,
        keyword: s.keyword ?? SERVICE_DEFAULTS.keyword,
        chatBonus: s.chatBonus ?? SERVICE_DEFAULTS.chatBonus,
      });
      if (isRejection(settings)) return settings;
      if (team !== null && !team.active) return TEAM_INACTIVE();
      if (outsideTeam(settings.channels, team)) return CHANNEL_NOT_IN_TEAM();
      return [
        {
          type: GIVEAWAY_EVENTS.created,
          payload: { teamId: cmd.teamId, kernelId: cmd.kernelId, kernelVersion: kernel.version, settings },
        },
      ];
    },
  };
}

export function transitionHandler(d: GiveawayDeps, type: TransitionType): CommandHandler<GiveawayCmd, GiveawayState> {
  const spec = TRANSITION_SPEC[type];
  return {
    type,
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    decide(state) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      const from = state.status;
      const allowed = TRANSITIONS[from].includes(spec.to) && (spec.from === null || spec.from.includes(from));
      if (!allowed) {
        return reject('invalid_transition', `Aus dem Zustand ${STATUS_LABEL[from]} geht ${spec.label} nicht.`);
      }
      if (type === 'complete_giveaway' && !Object.values(state.winners).every((w) => w === 'done' || w === 'forfeited')) {
        return reject('winners_open', 'Setze jeden Gewinn auf erledigt oder verfallen, bevor du abschließt.');
      }
      const changed = { type: GIVEAWAY_EVENTS.statusChanged, payload: { from, to: spec.to } };
      if (type !== 'cancel_giveaway') return [changed];
      // Abbruch: der Kern darf nachbuchen, Kern C erstattet alle Tickets als Umkehrung je Kauf (§7.1, §5.3).
      const kernel = d.kernels.get(state.kernelId);
      return [changed, ...fromKernelEvents(kernel, kernel.onCancel?.(state.kernelState, state.settings.config) ?? [], CANCEL_REASON)];
    },
  };
}

export function changeSettingsHandler(d: GiveawayDeps): CommandHandler<ChangeSettingsCmd, GiveawayState, TeamChannels> {
  return {
    type: 'change_settings',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    prepare: async (c, _cmd, _ctx, _pre, state) => (state.exists ? d.teams.channelsOf(c, state.teamId) : null),
    decide(state, cmd, _ctx, team) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (!SETTINGS_OPEN.includes(state.status)) {
        return SETTINGS_LOCKED();
      }
      const before = state.settings;
      const s = cmd.settings;
      const after = checkSettings(d.kernels.get(state.kernelId), {
        // Teilangaben behalten die übrigen Regeln, statt auf die Vorgaben des Schemas zu fallen.
        config: { ...before.config, ...s.config },
        prize: s.prize ?? before.prize,
        sponsor: s.sponsor === undefined ? before.sponsor : s.sponsor,
        channels: s.channels ?? before.channels,
        winnersCount: s.winnersCount ?? before.winnersCount,
        claimDays: s.claimDays ?? before.claimDays,
        gates: s.gates ?? before.gates,
        legal: s.legal === undefined ? before.legal : s.legal,
        counting: s.counting ?? before.counting,
        purgeDays: s.purgeDays ?? before.purgeDays,
        keyword: s.keyword === undefined ? before.keyword : s.keyword,
        // Teilangaben des Chat-Bonus behalten die übrigen Werte (Spec 6.2: Werte bleiben beim Abschalten).
        chatBonus: s.chatBonus === undefined ? before.chatBonus : ({ ...before.chatBonus, ...(s.chatBonus as Partial<ChatBonusSettings>) } as ChatBonusSettings),
      });
      if (isRejection(after)) return after;
      // Nur neu gesetzte Kanäle müssen zum Team gehören. Kanäle ausgetretener Mitglieder bleiben als Nachweis (Teilprojekt 7, Festlegung 5).
      if (s.channels !== undefined && outsideTeam(after.channels, team)) return CHANNEL_NOT_IN_TEAM();
      if (canonicalJson(after) === canonicalJson(before)) return [];
      // Der eingefrorene Nachweis (9.4) darf nicht still von den sichtbaren Texten abweichen.
      if (state.status !== 'draft' && canonicalJson(after.legal) !== canonicalJson(before.legal)) {
        return reject('legal_locked', 'Die Rechtstexte sind seit dem Öffnen eingefroren. Für neue Texte lege ein neues Giveaway an.');
      }
      return [{ type: GIVEAWAY_EVENTS.settingsChanged, payload: { before, after } }];
    },
  };
}

const STREAM_PREFIX = 'giveaway:';

/**
 * Rückgängig hält dieselben Zustandsregeln ein wie der Vorwärts-Befehl.
 * giveaway_drawn: sonst holte der Reducer ein abgeschlossenes oder abgebrochenes Giveaway nach Geschlossen zurück.
 * giveaway_settings_changed: auch in Geschlossen erlaubt, erst ab Gezogen gesperrt.
 */
const REVERT_GATES: Record<string, { allowed: readonly GiveawayStatus[]; rejection: () => Rejection }> = {
  [GIVEAWAY_EVENTS.drawn]: {
    allowed: ['drawn'],
    rejection: () => reject('not_drawn', 'Nur im Zustand Gezogen lässt sich eine Ziehung aufheben.'),
  },
  [GIVEAWAY_EVENTS.winnerStatusSet]: {
    allowed: ['drawn'],
    rejection: () => reject('not_drawn', 'Nur im Zustand Gezogen lässt sich ein Gewinnstatus ändern.'),
  },
  [GIVEAWAY_EVENTS.settingsChanged]: {
    allowed: ['draft', 'open', 'paused', 'closed'],
    rejection: () => SETTINGS_LOCKED(),
  },
};

const KERNEL_REVERT_OPEN: readonly GiveawayStatus[] = ['draft', 'open', 'paused', 'closed'];

export function giveawayRevertHandler(
  d: GiveawayDeps,
  registry: EventTypeRegistry,
): CommandHandler<RevertCommand, GiveawayState, RevertPrepared> {
  const control = authorizeControl(d.auth);
  const base = makeRevertHandler(d.reducer, registry, (cmd: RevertCommand, ctx, c) =>
    cmd.stream.startsWith(STREAM_PREFIX)
      ? control({ giveawayId: cmd.stream.slice(STREAM_PREFIX.length) }, ctx, c)
      : GIVEAWAY_NOT_FOUND(),
  );
  return {
    ...base,
    decide(state, cmd, ctx, prepared) {
      const out = base.decide(state, cmd, ctx, prepared);
      if (isRejection(out) || !prepared.target) return out;
      const gate = REVERT_GATES[prepared.target.type];
      if (gate && !gate.allowed.includes(state.status)) return gate.rejection();
      // Kern-Einträge nur bis Geschlossen: sonst veränderte eine Umkehrung den Topf einer Ersatzziehung (Teilprojekt 6, Festlegung 8).
      if (!KERNEL_REVERT_OPEN.includes(state.status) && d.kernels.get(state.kernelId).events.some((e) => e.type === prepared.target!.type)) {
        return reject('kernel_locked', 'Nach Ziehung oder Abbruch änderst du keine Kern-Einträge mehr.');
      }
      return out;
    },
  };
}
