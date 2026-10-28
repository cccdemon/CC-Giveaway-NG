// Ereignistypen des Stroms giveaway:<id>: Rahmen-Typen, je Kern dessen Typen, dazu event_voided.
import { z } from 'zod';
import type { GateId, KernelEventDef, KernelReversal } from '../../kernel-api/index.js';
import type { EventTypeRegistry, ReversalSpec } from '../../journal/event-types.js';
import { canonicalJson } from '../../shared/canonical.js';
import { reject } from '../../shared/rejection.js';
import type { KernelRegistry } from '../kernel-registry.js';
import { registerRevertTypes } from '../revert.js';
import { NOT_REGISTERED_TEXT, TOO_LATE, TOO_LATE_TEXT } from './registration.js';
import { GIVEAWAY_EVENTS, type GiveawaySettings, type GiveawayState, type GiveawayStatus, type WinnerStatus } from './state.js';

const GATE_IDS = ['follow', 'account_age', 'follow_age', 'presence'] as const satisfies readonly GateId[];
const STATUSES = ['draft', 'open', 'paused', 'closed', 'drawn', 'completed', 'cancelled'] as const satisfies readonly GiveawayStatus[];
const WINNER_STATUSES = ['pending', 'reported', 'shipped', 'done', 'forfeited'] as const satisfies readonly WinnerStatus[];

const settingsSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  prize: z.string().min(1).max(200),
  sponsor: z.string().max(200).nullable(),
  channels: z.array(z.uuid()).min(1),
  winnersCount: z.int().min(1).max(100),
  claimDays: z.int().min(1).max(90),
  gates: z.array(z.looseObject({ id: z.enum(GATE_IDS) })),
});

const pidSchema = z.object({ pid: z.uuid() });

const NOT_LATEST = (): ReturnType<typeof reject> => reject('not_latest_transition', 'Nimm zuerst die späteren Übergänge zurück.');

function kernelReversal(r: KernelReversal): ReversalSpec {
  if (r.kind === 'compensate') {
    return { kind: 'compensate', inverse: (target, state) => r.inverse(target.payload, (state as GiveawayState).kernelState) };
  }
  return r;
}

function registerKernelEvent(registry: EventTypeRegistry, def: KernelEventDef): void {
  registry.register({
    type: def.type,
    version: def.version,
    schema: z.unknown().superRefine((p, ctx) => {
      const err = def.check(p);
      if (err) ctx.addIssue({ code: 'custom', message: err });
    }),
    reversal: kernelReversal(def.reversal),
  });
}

export function registerGiveawayEvents(registry: EventTypeRegistry, kernels: KernelRegistry): void {
  registry.register({
    type: GIVEAWAY_EVENTS.created,
    version: 1,
    schema: z.object({
      teamId: z.uuid(),
      kernelId: z.string().min(1),
      kernelVersion: z.int().min(1),
      settings: settingsSchema,
    }),
    reversal: { kind: 'none', why: 'Einen Entwurf nimmst du nicht zurück. Brich das Giveaway ab.' },
  });

  registry.register({
    type: GIVEAWAY_EVENTS.statusChanged,
    version: 1,
    schema: z.object({ from: z.enum(STATUSES), to: z.enum(STATUSES) }),
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const { from, to } = target.payload as { from: GiveawayStatus; to: GiveawayStatus };
        if ((state as GiveawayState).status !== to) return NOT_LATEST();
        return { type: GIVEAWAY_EVENTS.statusChanged, payload: { from: to, to: from } };
      },
    },
  });

  registry.register({
    type: GIVEAWAY_EVENTS.settingsChanged,
    version: 1,
    schema: z.object({ before: settingsSchema, after: settingsSchema }),
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const { before, after } = target.payload as { before: GiveawaySettings; after: GiveawaySettings };
        if (canonicalJson((state as GiveawayState).settings) !== canonicalJson(after)) return NOT_LATEST();
        return { type: GIVEAWAY_EVENTS.settingsChanged, payload: { before: after, after: before } };
      },
    },
  });

  registry.register({
    type: GIVEAWAY_EVENTS.registered,
    version: 1,
    schema: pidSchema,
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const s = state as GiveawayState;
        const { pid } = target.payload as { pid: string };
        // Dieselben Regeln wie withdraw. Nur die aktuelle Anmeldung lässt sich zurücknehmen.
        if (TOO_LATE.includes(s.status)) return reject('too_late', TOO_LATE_TEXT);
        if (s.registered[pid]?.eventId !== target.id) return reject('not_registered', NOT_REGISTERED_TEXT);
        return { type: GIVEAWAY_EVENTS.withdrawn, payload: { pid } };
      },
    },
  });

  registry.register({
    type: GIVEAWAY_EVENTS.withdrawn,
    version: 1,
    schema: pidSchema,
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        if ((state as GiveawayState).status !== 'open') {
          return reject('not_open', 'Das Giveaway nimmt gerade keine Anmeldungen an.');
        }
        return { type: GIVEAWAY_EVENTS.registered, payload: { pid: (target.payload as { pid: string }).pid } };
      },
    },
  });

  registry.register({
    type: GIVEAWAY_EVENTS.drawn,
    version: 1,
    schema: z.object({
      mode: z.enum(['weighted', 'equal', 'highest']),
      winners: z.array(z.uuid()),
      pool: z.array(z.object({ pid: z.uuid(), weight: z.number().nonnegative() })),
      poolHash: z.string(),
      random: z.array(z.number()),
      gates: z.array(z.object({ pid: z.uuid(), ok: z.boolean(), reasons: z.array(z.string()) })),
      excluded: z.array(z.uuid()),
    }),
    reversal: { kind: 'void' },
  });

  registry.register({
    type: GIVEAWAY_EVENTS.winnerStatusSet,
    version: 1,
    schema: z.object({ pid: z.uuid(), from: z.enum(WINNER_STATUSES), to: z.enum(WINNER_STATUSES) }),
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const { pid, from, to } = target.payload as { pid: string; from: WinnerStatus; to: WinnerStatus };
        if ((state as GiveawayState).winners[pid] !== to) return NOT_LATEST();
        return { type: GIVEAWAY_EVENTS.winnerStatusSet, payload: { pid, from: to, to: from } };
      },
    },
  });

  for (const kernel of kernels.list()) {
    for (const def of kernel.events) registerKernelEvent(registry, def);
  }

  registerRevertTypes(registry);
}
