// Lebenszyklus-Befehle des Stroms giveaway:<id> (NEW_DESIGN.md 7.1).
import type { AnyKernel, Pid } from '../../kernel-api/index.js';
import type { EventTypeRegistry } from '../../journal/event-types.js';
import { isRejection, reject, type Rejection } from '../../shared/rejection.js';
import type { CommandHandler, StreamReducer } from '../command-bus.js';
import { validateConfig } from '../kernel-config.js';
import type { KernelRegistry } from '../kernel-registry.js';
import { makeRevertHandler, type RevertCommand, type RevertPrepared } from '../revert.js';
import { GIVEAWAY_NOT_FOUND, authorizeControl, type GiveawayAuthorizer } from './authorize.js';
import {
  GIVEAWAY_EVENTS,
  TRANSITIONS,
  giveawayStream,
  type GiveawaySettings,
  type GiveawayState,
  type GiveawayStatus,
} from './state.js';

export interface GiveawayDeps {
  kernels: KernelRegistry;
  auth: GiveawayAuthorizer;
  reducer: StreamReducer<GiveawayState>;
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

const STATUS_LABEL: Record<GiveawayStatus, string> = {
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

/** JSON mit sortierten Schlüsseln. JSONB ordnet Schlüssel beim Speichern um. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

/** Prüft vollständige Einstellungen gegen den Kern. Liefert sie mit geprüfter config zurück. */
function checkSettings(kernel: AnyKernel, s: GiveawaySettings): GiveawaySettings | Rejection {
  const config = validateConfig(kernel.configSchema, s.config);
  if (isRejection(config)) return config;
  if (typeof s.prize !== 'string' || !s.prize.trim()) return reject('prize_required', 'Gib an, was es zu gewinnen gibt.');
  if (!Array.isArray(s.channels) || s.channels.length === 0) return reject('channels_required', 'Wähle mindestens einen Kanal.');
  if (!Number.isInteger(s.winnersCount) || s.winnersCount < 1 || s.winnersCount > 100) {
    return reject('invalid_winners_count', 'Die Gewinnerzahl muss zwischen 1 und 100 liegen.');
  }
  if (!Number.isInteger(s.claimDays) || s.claimDays < 1 || s.claimDays > 90) {
    return reject('invalid_claim_days', 'Die Meldefrist muss zwischen 1 und 90 Tagen liegen.');
  }
  for (const g of s.gates) {
    if (!kernel.supportedGates.includes(g.id)) {
      return reject('gate_unsupported', `Die Bedingung ${String(g.id)} gibt es für diesen Kern nicht.`);
    }
  }
  return { ...s, config: config.value as Record<string, unknown> };
}

export function createGiveawayHandler(d: GiveawayDeps): CommandHandler<CreateGiveawayCmd, GiveawayState> {
  return {
    type: 'create_giveaway',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: (cmd, ctx, c) => d.auth.controls(c, ctx.actor, cmd.teamId),
    decide(state, cmd) {
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
      });
      if (isRejection(settings)) return settings;
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
      return [{ type: GIVEAWAY_EVENTS.statusChanged, payload: { from, to: spec.to } }];
    },
  };
}

export function changeSettingsHandler(d: GiveawayDeps): CommandHandler<ChangeSettingsCmd, GiveawayState> {
  return {
    type: 'change_settings',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    decide(state, cmd) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (!SETTINGS_OPEN.includes(state.status)) {
        return reject('settings_locked', 'Nach dem Schließen änderst du keine Regeln mehr.');
      }
      const before = state.settings;
      const s = cmd.settings;
      const after = checkSettings(d.kernels.get(state.kernelId), {
        config: s.config ?? before.config,
        prize: s.prize ?? before.prize,
        sponsor: s.sponsor === undefined ? before.sponsor : s.sponsor,
        channels: s.channels ?? before.channels,
        winnersCount: s.winnersCount ?? before.winnersCount,
        claimDays: s.claimDays ?? before.claimDays,
        gates: s.gates ?? before.gates,
      });
      if (isRejection(after)) return after;
      if (canonical(after) === canonical(before)) return [];
      return [{ type: GIVEAWAY_EVENTS.settingsChanged, payload: { before, after } }];
    },
  };
}

const STREAM_PREFIX = 'giveaway:';

export function giveawayRevertHandler(
  d: GiveawayDeps,
  registry: EventTypeRegistry,
): CommandHandler<RevertCommand, GiveawayState, RevertPrepared> {
  const control = authorizeControl(d.auth);
  return makeRevertHandler(d.reducer, registry, (cmd: RevertCommand, ctx, c) =>
    cmd.stream.startsWith(STREAM_PREFIX)
      ? control({ giveawayId: cmd.stream.slice(STREAM_PREFIX.length) }, ctx, c)
      : GIVEAWAY_NOT_FOUND(),
  );
}
