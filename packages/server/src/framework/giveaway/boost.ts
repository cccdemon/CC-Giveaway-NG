// Boost (NEW_DESIGN.md 6.3) und Zeit-Korrektur (5.3, 15.6) als Befehle des Stroms giveaway:<id>.
import type pg from 'pg';
import { FRAMEWORK_EVENTS, type Pid } from '../../kernel-api/index.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import type { CommandContext, CommandHandler } from '../command-bus.js';
import { GIVEAWAY_NOT_FOUND, UUID_RE, authorizeControl } from './authorize.js';
import type { GiveawayCmd, GiveawayDeps } from './lifecycle.js';
import { BOOST_FACTOR_MAX, BOOST_FACTOR_MIN, SERVICE_EVENT_TYPES } from './services.js';
import type { ChannelActivity } from './signals.js';
import { giveawayStream, type GiveawayState, type GiveawayStatus } from './state.js';

export interface StartBoostCmd {
  giveawayId: string;
  factor: number;
  durationSec: number;
}

export interface CorrectWatchCmd {
  giveawayId: string;
  channel: Pid;
  pid: Pid;
  sec: number;
  reason: string;
}

export const BOOST_DURATION_MIN_SEC = 60;
export const BOOST_DURATION_MAX_SEC = 86_400;
export const CORRECTION_MAX_SEC = 360_000;

/** Zustände, in denen Zuschauzeit noch korrigiert wird. Nach Ziehung oder Abbruch steht der Nachweis fest. */
const CORRECTABLE: readonly GiveawayStatus[] = ['draft', 'open', 'paused', 'closed'];

const INVALID_BOOST = (): Rejection => reject('invalid_boost', 'Der Faktor liegt zwischen 2 und 10, die Dauer zwischen 1 Minute und 24 Stunden.');

const inRange = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

export function startBoostHandler(d: GiveawayDeps & { activity: ChannelActivity }): CommandHandler<StartBoostCmd, GiveawayState, Set<Pid>> {
  return {
    type: 'start_boost',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    prepare: (c, _cmd, ctx, _pre, state) => d.activity.active(c, state.settings.channels, ctx.now),
    decide(state, cmd, ctx, active) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'open') return reject('not_open', 'Ein Boost startet nur, solange das Giveaway offen ist.');
      if (!inRange(cmd.factor, BOOST_FACTOR_MIN, BOOST_FACTOR_MAX) || !inRange(cmd.durationSec, BOOST_DURATION_MIN_SEC, BOOST_DURATION_MAX_SEC)) return INVALID_BOOST();
      if (state.boost !== null) return reject('boost_active', 'Ein Boost läuft schon. Stoppe ihn zuerst.');
      if (active.size === 0) return reject('no_signal', 'Kein Kanal des Giveaways ist live und liefert Signale. Ein Boost startet nur mit Signalen.');
      const until = new Date(ctx.now.getTime() + cmd.durationSec * 1000).toISOString();
      return [{ type: SERVICE_EVENT_TYPES.boostStarted, payload: { factor: cmd.factor, until } }];
    },
  };
}

export function stopBoostHandler(d: GiveawayDeps): CommandHandler<GiveawayCmd, GiveawayState> {
  const control = authorizeControl(d.auth);
  return {
    type: 'stop_boost',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    // Das Ende setzt der Scheduler per Befehl (6.3), stoppen darf auch der Streamer jederzeit.
    authorize: (cmd: GiveawayCmd, ctx: CommandContext, c: pg.PoolClient) => (ctx.actor === 'system:scheduler' ? null : control(cmd, ctx, c)),
    decide(state) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.boost === null) return reject('no_boost', 'Es läuft kein Boost.');
      return [{ type: SERVICE_EVENT_TYPES.boostEnded, payload: {} }];
    },
  };
}

export function correctWatchHandler(d: GiveawayDeps): CommandHandler<CorrectWatchCmd, GiveawayState> {
  return {
    type: 'correct_watch',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeControl(d.auth),
    decide(state, cmd) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (!CORRECTABLE.includes(state.status)) return reject('correction_locked', 'Nach Ziehung oder Abbruch korrigierst du keine Zuschauzeit mehr.');
      if (typeof cmd.pid !== 'string' || !UUID_RE.test(cmd.pid) || typeof cmd.channel !== 'string' || !UUID_RE.test(cmd.channel)) {
        return reject('invalid_id', 'Die ID ist keine gültige UUID.');
      }
      if (!state.settings.channels.includes(cmd.channel)) return reject('channel_not_in_giveaway', 'Dieser Kanal gehört nicht zum Giveaway.');
      if (typeof cmd.sec !== 'number' || !Number.isInteger(cmd.sec) || cmd.sec === 0 || Math.abs(cmd.sec) > CORRECTION_MAX_SEC) {
        return reject('invalid_correction', 'Die Korrektur ist eine ganze Zahl von Sekunden ungleich 0, höchstens 100 Stunden.');
      }
      if (typeof cmd.reason !== 'string' || !cmd.reason.trim()) return reject('reason_required', 'Gib einen Grund für die Korrektur an.');
      return [{ type: FRAMEWORK_EVENTS.watchCorrected, payload: { channel: cmd.channel, entries: [{ pid: cmd.pid, sec: cmd.sec }] }, reason: cmd.reason }];
    },
  };
}
