// Hängt den Strom platform an die Runtime: Ereignistypen, Lesetabellen, Befehle. Einmal je Runtime, in jedem Prozess.
import type { CommandHandler } from '../framework/command-bus.js';
import type { RevertCommand, RevertPrepared } from '../framework/revert.js';
import type { Runtime } from '../framework/runtime.js';
import type { AdminCheck } from './admin.js';
import {
  banStreamerHandler,
  platformRevertHandler,
  publishTermsHandler,
  unbanStreamerHandler,
  warnStreamerHandler,
  withdrawWarningHandler,
  type PublishTermsCmd,
  type StreamerCmd,
  type WithdrawWarningCmd,
} from './commands.js';
import { registerPlatformEvents } from './events.js';
import { platformProjector, termsProjector } from './projectors.js';
import type { PlatformState } from './state.js';

type Handler<C, P = undefined> = CommandHandler<C, PlatformState, P>;

export interface PlatformHandlers {
  ban: Handler<StreamerCmd>;
  unban: Handler<StreamerCmd>;
  warn: Handler<StreamerCmd>;
  withdrawWarning: Handler<WithdrawWarningCmd>;
  publishTerms: Handler<PublishTermsCmd>;
  revert: Handler<RevertCommand, RevertPrepared>;
}

export function attachPlatform(rt: Runtime, o: { admins: AdminCheck }): PlatformHandlers {
  registerPlatformEvents(rt.registry);
  rt.projections.registerState(platformProjector());
  rt.projections.register(termsProjector());
  return {
    ban: banStreamerHandler(o.admins),
    unban: unbanStreamerHandler(o.admins),
    warn: warnStreamerHandler(o.admins),
    withdrawWarning: withdrawWarningHandler(o.admins),
    publishTerms: publishTermsHandler(o.admins),
    revert: platformRevertHandler(rt.registry, o.admins),
  };
}
