// Befehle des Stroms platform (NEW_DESIGN.md 11.4): sperren, entsperren, verwarnen, Verwarnung zurücknehmen, Fassung veröffentlichen.
import { UUID_RE } from '../framework/authorize.js';
import type { CommandHandler } from '../framework/command-bus.js';
import { makeRevertHandler, type RevertCommand, type RevertPrepared } from '../framework/revert.js';
import type { EventTypeRegistry } from '../journal/event-types.js';
import { reject, type Rejection } from '../shared/rejection.js';
import { authorizeAdmin, type AdminCheck } from './admin.js';
import { TERMS_TEXT_MAX } from './events.js';
import { PLATFORM_EVENTS, PLATFORM_STREAM, platformReducer, type PlatformState } from './state.js';
import { TERMS_FALLBACK_VERSION } from './terms.js';

export interface StreamerCmd {
  pid: string;
  reason: string;
}

export interface WithdrawWarningCmd extends StreamerCmd {
  warningEventId: string;
}

export interface PublishTermsCmd {
  text: string;
}

type Handler<C, P = undefined> = CommandHandler<C, PlatformState, P>;

const INVALID_ID = (): Rejection => reject('invalid_id', 'Die ID ist keine gültige UUID.');
const REASON_REQUIRED = (): Rejection => reject('reason_required', 'Gib einen Grund an.');

function checkStreamerCmd(cmd: StreamerCmd): Rejection | null {
  if (typeof cmd.pid !== 'string' || !UUID_RE.test(cmd.pid)) return INVALID_ID();
  if (typeof cmd.reason !== 'string' || cmd.reason.trim() === '') return REASON_REQUIRED();
  return null;
}

export function banStreamerHandler(check: AdminCheck): Handler<StreamerCmd> {
  return {
    type: 'ban_streamer',
    streamOf: () => PLATFORM_STREAM,
    reducer: platformReducer,
    authorize: authorizeAdmin(check),
    decide(state, cmd) {
      const bad = checkStreamerCmd(cmd);
      if (bad) return bad;
      if (state.bans[cmd.pid]) return reject('already_banned', 'Diese Person ist schon gesperrt.');
      return [{ type: PLATFORM_EVENTS.banned, payload: { pid: cmd.pid }, reason: cmd.reason.trim() }];
    },
  };
}

export function unbanStreamerHandler(check: AdminCheck): Handler<StreamerCmd> {
  return {
    type: 'unban_streamer',
    streamOf: () => PLATFORM_STREAM,
    reducer: platformReducer,
    authorize: authorizeAdmin(check),
    decide(state, cmd) {
      const bad = checkStreamerCmd(cmd);
      if (bad) return bad;
      const ban = state.bans[cmd.pid];
      if (!ban) return reject('not_banned', 'Diese Person ist nicht gesperrt.');
      return [{ type: PLATFORM_EVENTS.unbanned, payload: { pid: cmd.pid }, reason: cmd.reason.trim(), reversesEventId: ban.eventId }];
    },
  };
}

export function warnStreamerHandler(check: AdminCheck): Handler<StreamerCmd> {
  return {
    type: 'warn_streamer',
    streamOf: () => PLATFORM_STREAM,
    reducer: platformReducer,
    authorize: authorizeAdmin(check),
    decide(_state, cmd) {
      const bad = checkStreamerCmd(cmd);
      if (bad) return bad;
      return [{ type: PLATFORM_EVENTS.warned, payload: { pid: cmd.pid }, reason: cmd.reason.trim() }];
    },
  };
}

export function withdrawWarningHandler(check: AdminCheck): Handler<WithdrawWarningCmd> {
  return {
    type: 'withdraw_warning',
    streamOf: () => PLATFORM_STREAM,
    reducer: platformReducer,
    authorize: authorizeAdmin(check),
    decide(state, cmd) {
      const bad = checkStreamerCmd(cmd);
      if (bad) return bad;
      const id = String(cmd.warningEventId ?? '');
      if (!state.warnings[cmd.pid]?.some((w) => w.eventId === id)) return reject('warning_not_found', 'Diese Verwarnung gibt es nicht mehr.');
      return [{ type: PLATFORM_EVENTS.warningWithdrawn, payload: { pid: cmd.pid, warningEventId: id }, reason: cmd.reason.trim(), reversesEventId: id }];
    },
  };
}

export function publishTermsHandler(check: AdminCheck): Handler<PublishTermsCmd> {
  return {
    type: 'publish_terms',
    streamOf: () => PLATFORM_STREAM,
    reducer: platformReducer,
    authorize: authorizeAdmin(check),
    decide(state, cmd) {
      const text = typeof cmd.text === 'string' ? cmd.text.trim() : '';
      if (text === '' || text.length > TERMS_TEXT_MAX) return reject('invalid_terms', `Der Text braucht 1 bis ${TERMS_TEXT_MAX} Zeichen.`);
      const version = (state.terms?.version ?? TERMS_FALLBACK_VERSION) + 1;
      return [{ type: PLATFORM_EVENTS.termsPublished, payload: { version, text } }];
    },
  };
}

export function platformRevertHandler(registry: EventTypeRegistry, check: AdminCheck): CommandHandler<RevertCommand, PlatformState, RevertPrepared> {
  return makeRevertHandler(platformReducer, registry, authorizeAdmin(check));
}
