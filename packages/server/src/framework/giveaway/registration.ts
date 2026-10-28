// Anmeldung und Rückzug eines Teilnehmers (NEW_DESIGN.md 6.4). Nur der Teilnehmer selbst oder ein System-Akteur.
import type pg from 'pg';
import type { Pid } from '../../kernel-api/index.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import type { CommandContext, CommandHandler } from '../command-bus.js';
import { GIVEAWAY_NOT_FOUND, UUID_RE, authorizeSelf, loadGiveawayRow } from './authorize.js';
import type { GiveawayDeps } from './lifecycle.js';
import { GIVEAWAY_EVENTS, giveawayStream, type GiveawayState, type GiveawayStatus } from './state.js';

export interface RegisterCmd {
  giveawayId: string;
  pid: Pid;
}

export const TOO_LATE: readonly GiveawayStatus[] = ['drawn', 'completed', 'cancelled'];
export const TOO_LATE_TEXT = 'Nach der Ziehung ist kein Rückzug mehr möglich.';
export const NOT_REGISTERED_TEXT = 'Du bist nicht angemeldet.';

async function authorizeRegistration(cmd: RegisterCmd, ctx: CommandContext, c: pg.PoolClient): Promise<Rejection | null> {
  const row = await loadGiveawayRow(c, cmd.giveawayId);
  if (!row) return GIVEAWAY_NOT_FOUND();
  // System-Akteure (Simulator, Ingest) melden für andere an.
  if (ctx.actor.startsWith('system:') && typeof cmd.pid === 'string' && UUID_RE.test(cmd.pid)) return null;
  return authorizeSelf(cmd.pid, ctx.actor);
}

export function registerHandler(d: GiveawayDeps): CommandHandler<RegisterCmd, GiveawayState> {
  return {
    type: 'register',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeRegistration,
    decide(state, cmd, ctx) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status !== 'open') return reject('not_open', 'Das Giveaway nimmt gerade keine Anmeldungen an.');
      if (state.registered[cmd.pid]) return reject('already_registered', 'Du bist schon angemeldet.');
      const gate = d.kernels.get(state.kernelId).gateRegistration?.(state.kernelState, state.settings.config, ctx.now.toISOString());
      if (gate) return gate;
      return [{ type: GIVEAWAY_EVENTS.registered, payload: { pid: cmd.pid } }];
    },
  };
}

export function withdrawHandler(d: GiveawayDeps): CommandHandler<RegisterCmd, GiveawayState> {
  return {
    type: 'withdraw',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: authorizeRegistration,
    decide(state, cmd) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (!state.registered[cmd.pid]) return reject('not_registered', NOT_REGISTERED_TEXT);
      if (TOO_LATE.includes(state.status)) return reject('too_late', TOO_LATE_TEXT);
      return [{ type: GIVEAWAY_EVENTS.withdrawn, payload: { pid: cmd.pid } }];
    },
  };
}
