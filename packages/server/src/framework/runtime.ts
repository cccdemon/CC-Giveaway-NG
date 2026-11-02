// Baut Registry, Projektionen, Reducer, CommandBus und alle Giveaway-Handler aus einer Hand.
import type pg from 'pg';
import type { Queryable } from '../db/pool.js';
import { EventTypeRegistry } from '../journal/event-types.js';
import { CommandBus, type BusLogger, type CommandHandler, type StreamReducer } from './command-bus.js';
import type { GiveawayAuthorizer } from './giveaway/authorize.js';
import {
  csprng,
  drawHandler,
  redrawHandler,
  winnerStatusHandler,
  type DrawCmd,
  type DrawDeps,
  type DrawPre,
  type DrawPrepared,
  type RedrawCmd,
  type Rng,
  type WinnerStatusCmd,
} from './giveaway/draw.js';
import { noGates, type GateChecker } from './giveaway/gates.js';
import { correctWatchHandler, startBoostHandler, stopBoostHandler, type CorrectWatchCmd, type StartBoostCmd } from './giveaway/boost.js';
import { registerGiveawayEvents } from './giveaway/events.js';
import { purgeUnregisteredHandler } from './giveaway/purge.js';
import {
  changeSettingsHandler,
  createGiveawayHandler,
  giveawayRevertHandler,
  transitionHandler,
  type ChangeSettingsCmd,
  type CreateGiveawayCmd,
  type GiveawayCmd,
  type GiveawayDeps,
} from './giveaway/lifecycle.js';
import { kernelCommandHandler, type KernelCommandCmd } from './giveaway/kernel-command.js';
import { noProfile, openGiveawayHandler, type LegalSource, type OpenPre, type OpenPrepared } from './giveaway/open.js';
import { fetchHash, type LegalFetcher } from './legal.js';
import { giveawaysProjector, participantsProjector, timersProjector } from './giveaway/projectors.js';
import { registerHandler, withdrawHandler, type RegisterCmd } from './giveaway/registration.js';
import { applySignalsHandler, noActivity, noIdentities, type ApplySignalsCmd, type ChannelActivity, type IdentityResolver, type ResolvedSignals } from './giveaway/signals.js';
import { makeGiveawayReducer, type GiveawayState } from './giveaway/state.js';
import { defaultKernels, type KernelRegistry } from './kernel-registry.js';
import { ProjectionRegistry } from './projections.js';
import { loadStreamState } from './state.js';
import type { Publisher } from './publisher.js';
import type { RevertCommand, RevertPrepared } from './revert.js';

export interface RuntimeOptions {
  pool: pg.Pool;
  publisher: Publisher;
  auth: GiveawayAuthorizer;
  gates?: GateChecker;
  rng?: Rng;
  log: BusLogger;
  kernels?: KernelRegistry;
  snapshotEvery?: number;
  /** Rechtstexte aus dem Profil des Akteurs (NEW_DESIGN.md 9.4). Default: kein Profil. */
  legalSource?: LegalSource;
  /** Holt Rechtstext-URLs beim Öffnen und bildet den Hash. Default: fetchHash. */
  fetcher?: LegalFetcher;
  /** Twitch-ID → pid für apply_signals (NEW_DESIGN.md 9.1). Default: keine Zuordnung. */
  identities?: IdentityResolver;
  /** Welche Kanäle live sind und Signale liefern (NEW_DESIGN.md 6.2, 6.3). Default: keiner. */
  activity?: ChannelActivity;
}

type Handler<C, P = undefined, Q = undefined> = CommandHandler<C, GiveawayState, P, Q>;

export interface Runtime {
  kernels: KernelRegistry;
  registry: EventTypeRegistry;
  projections: ProjectionRegistry;
  bus: CommandBus;
  reducer: StreamReducer<GiveawayState>;
  handlers: {
    create: Handler<CreateGiveawayCmd>;
    open: Handler<GiveawayCmd, OpenPrepared, OpenPre>;
    pause: Handler<GiveawayCmd>;
    resume: Handler<GiveawayCmd>;
    close: Handler<GiveawayCmd>;
    reopen: Handler<GiveawayCmd>;
    cancel: Handler<GiveawayCmd>;
    complete: Handler<GiveawayCmd>;
    changeSettings: Handler<ChangeSettingsCmd>;
    register: Handler<RegisterCmd>;
    withdraw: Handler<RegisterCmd>;
    kernelCommand: Handler<KernelCommandCmd>;
    revert: Handler<RevertCommand, RevertPrepared>;
    draw: Handler<DrawCmd, DrawPrepared, DrawPre>;
    redraw: Handler<RedrawCmd, DrawPrepared, DrawPre>;
    setWinnerStatus: Handler<WinnerStatusCmd>;
    applySignals: Handler<ApplySignalsCmd, ResolvedSignals>;
    startBoost: Handler<StartBoostCmd, Set<string>>;
    stopBoost: Handler<GiveawayCmd>;
    correctWatch: Handler<CorrectWatchCmd>;
    purgeUnregistered: Handler<GiveawayCmd, string[]>;
  };
}

export function createRuntime(o: RuntimeOptions): Runtime {
  const kernels = o.kernels ?? defaultKernels();
  const registry = new EventTypeRegistry();
  registerGiveawayEvents(registry, kernels);
  const projections = new ProjectionRegistry();
  // Reihenfolge zählt: giveaway_participants verweist per Fremdschlüssel auf giveaways.
  projections.registerState(giveawaysProjector(kernels));
  projections.registerState(participantsProjector(kernels));
  projections.registerState(timersProjector(kernels));
  const reducer = makeGiveawayReducer(kernels);
  const bus = new CommandBus({
    pool: o.pool,
    registry,
    projections,
    publisher: o.publisher,
    log: o.log,
    ...(o.snapshotEvery === undefined ? {} : { snapshotEvery: o.snapshotEvery }),
  });
  const d: GiveawayDeps = { kernels, auth: o.auth, reducer };
  const loadState = (c: Queryable, stream: string) => loadStreamState(c, registry, stream, reducer);
  const dd: DrawDeps = { ...d, gates: o.gates ?? noGates, rng: o.rng ?? csprng, loadState };
  const od = { ...d, legalSource: o.legalSource ?? noProfile, fetcher: o.fetcher ?? fetchHash, loadState };
  const activity = o.activity ?? noActivity;
  return {
    kernels,
    registry,
    projections,
    bus,
    reducer,
    handlers: {
      create: createGiveawayHandler(d),
      open: openGiveawayHandler(od),
      pause: transitionHandler(d, 'pause_giveaway'),
      resume: transitionHandler(d, 'resume_giveaway'),
      close: transitionHandler(d, 'close_giveaway'),
      reopen: transitionHandler(d, 'reopen_giveaway'),
      cancel: transitionHandler(d, 'cancel_giveaway'),
      complete: transitionHandler(d, 'complete_giveaway'),
      changeSettings: changeSettingsHandler(d),
      register: registerHandler(d),
      withdraw: withdrawHandler(d),
      kernelCommand: kernelCommandHandler(d),
      revert: giveawayRevertHandler(d, registry),
      draw: drawHandler(dd),
      redraw: redrawHandler(dd),
      setWinnerStatus: winnerStatusHandler(d),
      applySignals: applySignalsHandler({ ...d, identities: o.identities ?? noIdentities, activity }),
      startBoost: startBoostHandler({ ...d, activity }),
      stopBoost: stopBoostHandler(d),
      correctWatch: correctWatchHandler(d),
      purgeUnregistered: purgeUnregisteredHandler(d),
    },
  };
}
