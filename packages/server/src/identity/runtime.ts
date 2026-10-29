// Hängt den Konto-Strom an die Runtime des Rahmens: Ereignistypen, Lesetabellen, Befehle.
import type { CommandHandler } from '../framework/command-bus.js';
import type { RevertCommand, RevertPrepared } from '../framework/revert.js';
import type { Runtime } from '../framework/runtime.js';
import {
  acceptTermsHandler,
  accountRevertHandler,
  connectChannelHandler,
  deleteAccountHandler,
  disconnectChannelHandler,
  signInHandler,
  updateProfileHandler,
  type AcceptTermsCmd,
  type AccountCmd,
  type ConnectChannelCmd,
  type SignInCmd,
  type UpdateProfileCmd,
} from './account/commands.js';
import { registerAccountEvents } from './account/events.js';
import { accountsProjector, identityCleanupProjector } from './account/projectors.js';
import type { AccountState } from './account/state.js';

type Handler<C, P = undefined> = CommandHandler<C, AccountState, P>;

export interface AccountHandlers {
  signIn: Handler<SignInCmd, { pid: string }>;
  acceptTerms: Handler<AcceptTermsCmd>;
  updateProfile: Handler<UpdateProfileCmd>;
  connectChannel: Handler<ConnectChannelCmd, { mismatch: boolean }>;
  disconnectChannel: Handler<AccountCmd>;
  deleteAccount: Handler<AccountCmd>;
  revert: Handler<RevertCommand, RevertPrepared>;
}

/** Einmal je Runtime aufrufen, vor dem ersten Befehl. Ein zweiter Aufruf wirft (doppelte Registrierung). */
export function attachAccounts(rt: Runtime, o: { tokenKey: Buffer }): AccountHandlers {
  registerAccountEvents(rt.registry);
  rt.projections.registerState(accountsProjector());
  rt.projections.register(identityCleanupProjector());
  return {
    signIn: signInHandler(),
    acceptTerms: acceptTermsHandler(),
    updateProfile: updateProfileHandler(),
    connectChannel: connectChannelHandler({ tokenKey: o.tokenKey }),
    disconnectChannel: disconnectChannelHandler(),
    deleteAccount: deleteAccountHandler(),
    revert: accountRevertHandler(rt.registry),
  };
}
