// Baut Registry, Projektionen, Reducer, CommandBus und alle Giveaway-Handler aus einer Hand.
import type pg from 'pg';
import { EventTypeRegistry } from '../journal/event-types.js';
import { CommandBus, type BusLogger, type CommandHandler, type StreamReducer } from './command-bus.js';
import type { GiveawayAuthorizer } from './giveaway/authorize.js';
import { registerGiveawayEvents } from './giveaway/events.js';
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
import { giveawaysProjector } from './giveaway/projectors.js';
import { makeGiveawayReducer, type GiveawayState } from './giveaway/state.js';
import { defaultKernels, type KernelRegistry } from './kernel-registry.js';
import { ProjectionRegistry } from './projections.js';
import type { Publisher } from './publisher.js';
import type { RevertCommand, RevertPrepared } from './revert.js';

export interface RuntimeOptions {
  pool: pg.Pool;
  publisher: Publisher;
  auth: GiveawayAuthorizer;
  gates?: unknown; // Task 10: GateChecker
  rng?: () => number; // Task 10: Rng
  log: BusLogger;
  kernels?: KernelRegistry;
  snapshotEvery?: number;
}

type Handler<C, P = undefined> = CommandHandler<C, GiveawayState, P>;

export interface Runtime {
  kernels: KernelRegistry;
  registry: EventTypeRegistry;
  projections: ProjectionRegistry;
  bus: CommandBus;
  reducer: StreamReducer<GiveawayState>;
  handlers: {
    create: Handler<CreateGiveawayCmd>;
    open: Handler<GiveawayCmd>;
    pause: Handler<GiveawayCmd>;
    resume: Handler<GiveawayCmd>;
    close: Handler<GiveawayCmd>;
    reopen: Handler<GiveawayCmd>;
    cancel: Handler<GiveawayCmd>;
    complete: Handler<GiveawayCmd>;
    changeSettings: Handler<ChangeSettingsCmd>;
    revert: Handler<RevertCommand, RevertPrepared>;
  };
}

export function createRuntime(o: RuntimeOptions): Runtime {
  const kernels = o.kernels ?? defaultKernels();
  const registry = new EventTypeRegistry();
  registerGiveawayEvents(registry, kernels);
  const projections = new ProjectionRegistry();
  projections.registerState(giveawaysProjector(kernels));
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
  return {
    kernels,
    registry,
    projections,
    bus,
    reducer,
    handlers: {
      create: createGiveawayHandler(d),
      open: transitionHandler(d, 'open_giveaway'),
      pause: transitionHandler(d, 'pause_giveaway'),
      resume: transitionHandler(d, 'resume_giveaway'),
      close: transitionHandler(d, 'close_giveaway'),
      reopen: transitionHandler(d, 'reopen_giveaway'),
      cancel: transitionHandler(d, 'cancel_giveaway'),
      complete: transitionHandler(d, 'complete_giveaway'),
      changeSettings: changeSettingsHandler(d),
      revert: giveawayRevertHandler(d, registry),
    },
  };
}
