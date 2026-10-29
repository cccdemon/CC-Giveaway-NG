// Befehle des Stroms account:<pid> (NEW_DESIGN.md 9.1, 9.2, 11.3). Twitch-Daten gehen nur in identities und channel_tokens.
import { authorizeSelf, UUID_RE } from '../../framework/authorize.js';
import type { CommandContext, CommandHandler } from '../../framework/command-bus.js';
import { checkLegal, type LegalTexts } from '../../framework/legal.js';
import { makeRevertHandler, type RevertCommand, type RevertPrepared } from '../../framework/revert.js';
import type { EventTypeRegistry } from '../../journal/event-types.js';
import { canonicalJson } from '../../shared/canonical.js';
import { isRejection, reject, type Rejection } from '../../shared/rejection.js';
import { findIdentity, upsertIdentity, type TwitchUser } from '../identities.js';
import { PLATFORM_TERMS_VERSION } from '../terms.js';
import { saveChannelToken } from '../tokens.js';
import { REQUIRED_CHANNEL_SCOPES } from '../twitch.js';
import { ACCOUNT_EVENTS, accountReducer, accountStream, pidOfStream, type AccountState } from './state.js';

export interface SignInCmd {
  pid: string;
  soloTeamId: string;
  user: TwitchUser;
}

export interface AccountCmd {
  pid: string;
}

export interface AcceptTermsCmd extends AccountCmd {
  version: number;
}

export interface UpdateProfileCmd extends AccountCmd {
  legal: Partial<LegalTexts>;
}

export interface ConnectChannelCmd extends AccountCmd {
  twitchId: string;
  token: { accessToken: string; refreshToken: string; expiresIn: number; scopes: string[] };
}

type Handler<C, P = undefined> = CommandHandler<C, AccountState, P>;

const NO_ACCOUNT = (): Rejection => reject('no_account', 'Melde dich zuerst an.');
const SELF_TEXT = 'Du kannst nur dein eigenes Konto ändern.';

function requireAccount(state: AccountState): Rejection | null {
  return !state.exists || state.deleted ? NO_ACCOUNT() : null;
}

function self(cmd: AccountCmd, ctx: CommandContext): Rejection | null {
  return authorizeSelf(cmd.pid, ctx.actor, SELF_TEXT);
}

/** Anmeldung nach dem Twitch-Callback. Akteur ist `system:twitch` (oder die Person selbst). */
export function signInHandler(): Handler<SignInCmd, { pid: string }> {
  return {
    type: 'sign_in',
    streamOf: (cmd) => accountStream(cmd.pid),
    reducer: accountReducer,
    authorize(cmd, ctx) {
      if (typeof cmd.pid !== 'string' || !UUID_RE.test(cmd.pid) || typeof cmd.soloTeamId !== 'string' || !UUID_RE.test(cmd.soloTeamId)) {
        return reject('invalid_id', 'Die ID ist keine gültige UUID.');
      }
      if (ctx.actor === 'system:twitch') return null;
      return authorizeSelf(cmd.pid, ctx.actor, SELF_TEXT);
    },
    prepare: async (c, cmd, ctx) => ({ pid: await upsertIdentity(c, cmd.user, cmd.pid, ctx.now) }),
    decide(state, cmd, _ctx, prepared) {
      if (prepared.pid !== cmd.pid) return reject('pid_mismatch', 'Dieses Twitch-Konto hat schon eine pid. Melde dich erneut an.');
      if (state.deleted) return reject('account_deleted', 'Dieses Konto ist gelöscht.');
      if (state.exists) return [];
      return [{ type: ACCOUNT_EVENTS.created, payload: { soloTeamId: cmd.soloTeamId } }];
    },
  };
}

export function acceptTermsHandler(): Handler<AcceptTermsCmd> {
  return {
    type: 'accept_terms',
    streamOf: (cmd) => accountStream(cmd.pid),
    reducer: accountReducer,
    authorize: self,
    decide(state, cmd) {
      const missing = requireAccount(state);
      if (missing) return missing;
      if (cmd.version !== PLATFORM_TERMS_VERSION) {
        return reject('terms_version_stale', 'Die Nutzungsbedingungen haben sich geändert. Lade die Seite neu.');
      }
      if (state.termsVersion === cmd.version) return [];
      return [{ type: ACCOUNT_EVENTS.termsAccepted, payload: { version: cmd.version, previous: state.termsVersion } }];
    },
  };
}

export function updateProfileHandler(): Handler<UpdateProfileCmd> {
  return {
    type: 'update_profile',
    streamOf: (cmd) => accountStream(cmd.pid),
    reducer: accountReducer,
    authorize: self,
    decide(state, cmd) {
      const missing = requireAccount(state);
      if (missing) return missing;
      if (typeof cmd.legal !== 'object' || cmd.legal === null) return reject('invalid_legal', 'Die Rechtstexte sind ungültig.');
      const after = checkLegal({ ...state.legal, ...cmd.legal });
      if (isRejection(after)) return after;
      if (canonicalJson(after) === canonicalJson(state.legal)) return [];
      return [{ type: ACCOUNT_EVENTS.profileUpdated, payload: { before: state.legal, after } }];
    },
  };
}

export function connectChannelHandler(o: { tokenKey: Buffer }): Handler<ConnectChannelCmd, { mismatch: boolean }> {
  return {
    type: 'connect_channel',
    streamOf: (cmd) => accountStream(cmd.pid),
    reducer: accountReducer,
    authorize: self,
    async prepare(c, cmd, ctx) {
      const identity = await findIdentity(c, cmd.pid);
      const mismatch = !identity || identity.twitchId !== cmd.twitchId;
      if (!mismatch) {
        const t = cmd.token;
        await saveChannelToken(
          c,
          cmd.pid,
          { accessToken: t.accessToken, refreshToken: t.refreshToken, scopes: t.scopes, expiresAt: new Date(ctx.now.getTime() + t.expiresIn * 1000) },
          o.tokenKey,
          ctx.now,
        );
      }
      return { mismatch };
    },
    decide(state, cmd, _ctx, prepared) {
      const missing = requireAccount(state);
      if (missing) return missing;
      if (prepared.mismatch) {
        return reject('wrong_twitch_account', 'Dieses Twitch-Konto gehört nicht zu deiner Anmeldung. Melde dich mit dem Kanal-Konto an.');
      }
      const granted = new Set(cmd.token.scopes);
      if (!REQUIRED_CHANNEL_SCOPES.every((s) => granted.has(s))) {
        return reject('scopes_missing', 'Twitch hat nicht alle Rechte erteilt. Verbinde den Kanal erneut und bestätige alle Rechte.');
      }
      const scopes = [...REQUIRED_CHANNEL_SCOPES];
      if (state.channelConnected && canonicalJson(state.channelScopes) === canonicalJson(scopes)) return [];
      return [{ type: ACCOUNT_EVENTS.channelConnected, payload: { scopes } }];
    },
  };
}

export function disconnectChannelHandler(): Handler<AccountCmd> {
  return {
    type: 'disconnect_channel',
    streamOf: (cmd) => accountStream(cmd.pid),
    reducer: accountReducer,
    authorize: self,
    decide(state) {
      const missing = requireAccount(state);
      if (missing) return missing;
      if (!state.channelConnected) return reject('not_connected', 'Es ist kein Kanal verbunden.');
      return [{ type: ACCOUNT_EVENTS.channelDisconnected, payload: { scopes: state.channelScopes } }];
    },
  };
}

/** Die Person selbst oder der Scheduler (Löschfristen, NEW_DESIGN.md 12.4). */
export function deleteAccountHandler(): Handler<AccountCmd> {
  return {
    type: 'delete_account',
    streamOf: (cmd) => accountStream(cmd.pid),
    reducer: accountReducer,
    authorize: (cmd, ctx) => (ctx.actor === 'system:scheduler' && typeof cmd.pid === 'string' && UUID_RE.test(cmd.pid) ? null : self(cmd, ctx)),
    decide(state) {
      if (!state.exists) return NO_ACCOUNT();
      if (state.deleted) return reject('already_deleted', 'Dieses Konto ist schon gelöscht.');
      return [{ type: ACCOUNT_EVENTS.deleted, payload: {} }];
    },
  };
}

export function accountRevertHandler(registry: EventTypeRegistry): CommandHandler<RevertCommand, AccountState, RevertPrepared> {
  return makeRevertHandler(accountReducer, registry, (cmd: RevertCommand, ctx) => {
    const pid = pidOfStream(cmd.stream);
    if (pid === null) return NO_ACCOUNT();
    return authorizeSelf(pid, ctx.actor, SELF_TEXT);
  });
}
