// Ereignistypen des Stroms giveaway:<id>: Rahmen-Typen, je Kern dessen Typen, dazu event_voided.
import { z } from 'zod';
import type { KernelEventDef, KernelReversal } from '../../kernel-api/index.js';
import type { EventTypeRegistry, ReversalSpec } from '../../journal/event-types.js';
import { canonicalJson } from '../../shared/canonical.js';
import { reject } from '../../shared/rejection.js';
import type { KernelRegistry } from '../kernel-registry.js';
import { frozenLegalSchema, legalSchema } from '../legal.js';
import { registerRevertTypes } from '../revert.js';
import { GATE_IDS } from './gates.js';
import { NOT_REGISTERED_TEXT, TOO_LATE, TOO_LATE_TEXT } from './registration.js';
import { ANNOUNCEMENT_SENT, ANNOUNCEMENT_SENT_WHY, TEMPLATE_MAX } from './announcements.js';
import { KEYWORD_RE, PURGE_DAYS_MAX, PURGE_DAYS_MIN, chatBonusSchema, countingSchema, registerServiceEvents, upcastSettingsV1, upcastSettingsV2, upcastSettingsV3 } from './services.js';
import { GIVEAWAY_EVENTS, type GiveawaySettings, type GiveawayState, type GiveawayStatus, type WinnerStatus } from './state.js';

const STATUSES = ['draft', 'open', 'paused', 'closed', 'drawn', 'completed', 'cancelled'] as const satisfies readonly GiveawayStatus[];
const WINNER_STATUSES = ['pending', 'reported', 'shipped', 'done', 'forfeited'] as const satisfies readonly WinnerStatus[];

export const CONTACT_MAX = 200;

const settingsSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  prize: z.string().min(1).max(200),
  sponsor: z.string().max(200).nullable(),
  channels: z.array(z.uuid()).min(1),
  winnersCount: z.int().min(1).max(100),
  claimDays: z.int().min(1).max(90),
  gates: z.array(z.looseObject({ id: z.enum(GATE_IDS) })),
  legal: legalSchema.nullable(),
  counting: countingSchema,
  purgeDays: z.int().min(PURGE_DAYS_MIN).max(PURGE_DAYS_MAX),
  keyword: z.string().regex(KEYWORD_RE).nullable(),
  chatBonus: chatBonusSchema,
  contact: z.string().max(CONTACT_MAX).nullable(),
  announcements: z.object({ muted: z.boolean(), links: z.boolean(), texts: z.record(z.string(), z.string().max(TEMPLATE_MAX)) }),
});

/** v1 → v2: legal und die Felder der Dienste (Teilprojekt 5) mit Defaults. v2 → v3: contact (Teilprojekt 8a). */
const liftSettings = (up: (s: unknown) => unknown) => ({
  created: (p: unknown): unknown => ({ ...(p as object), settings: up((p as { settings: unknown }).settings) }),
  changed: (p: unknown): unknown => {
    const { before, after } = p as { before: unknown; after: unknown };
    return { before: up(before), after: up(after) };
  },
});
const v1 = liftSettings(upcastSettingsV1);
const v2 = liftSettings(upcastSettingsV2);
const v3 = liftSettings(upcastSettingsV3);

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
    type: ANNOUNCEMENT_SENT,
    version: 1,
    schema: z.object({
      kind: z.string().min(1).max(60),
      channel: z.uuid(),
      triggerEventId: z.string().min(1),
      ok: z.boolean(),
      error: z.string().max(200).optional(),
      messageId: z.string().max(200).optional(),
    }),
    reversal: { kind: 'none', why: ANNOUNCEMENT_SENT_WHY },
  });
  registry.register({
    type: GIVEAWAY_EVENTS.created,
    version: 4,
    schema: z.object({
      teamId: z.uuid(),
      kernelId: z.string().min(1),
      kernelVersion: z.int().min(1),
      settings: settingsSchema,
    }),
    upcasters: { 1: v1.created, 2: v2.created, 3: v3.created },
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
    version: 4,
    schema: z.object({ before: settingsSchema, after: settingsSchema }),
    upcasters: { 1: v1.changed, 2: v2.changed, 3: v3.changed },
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
    type: GIVEAWAY_EVENTS.legalFrozen,
    version: 1,
    schema: frozenLegalSchema,
    reversal: { kind: 'none', why: 'Eingefrorene Rechtstexte sind ein Nachweis und bleiben.' },
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

  registerServiceEvents(registry);

  for (const kernel of kernels.list()) {
    for (const def of kernel.events) registerKernelEvent(registry, def);
  }

  registerRevertTypes(registry);
}
