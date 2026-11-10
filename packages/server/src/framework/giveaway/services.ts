// Rahmen-Dienste (NEW_DESIGN.md 6.1–6.3, 12.4): Einstellungen, Ereignistypen und ihre Umkehrung, Boost-Faktor je Minute.
import { z } from 'zod';
import { FRAMEWORK_EVENTS, type CreditedPayload, type Pid } from '../../kernel-api/index.js';
import type { EventTypeRegistry } from '../../journal/event-types.js';
import { reject } from '../../shared/rejection.js';
import { TERMS_TEXT_MAX } from '../legal.js';
import { ANNOUNCEMENT_DEFAULTS } from './announcements.js';
import type { GiveawayState } from './state.js';

export type Counting = 'registered' | 'first_seen';

export interface ChatBonusSettings {
  enabled: boolean;
  sec: number;
  minWords: number;
  cooldownSec: number;
}

export interface ServiceSettings {
  counting: Counting;
  purgeDays: number;
  keyword: string | null;
  chatBonus: ChatBonusSettings;
}

export const SERVICE_DEFAULTS: ServiceSettings = {
  counting: 'registered',
  purgeDays: 7,
  keyword: null,
  chatBonus: { enabled: true, sec: 2, minWords: 4, cooldownSec: 10 },
};

export const KEYWORD_RE = /^\S{2,32}$/;
export const MINUTE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
export const PURGE_DAYS_MIN = 1;
export const PURGE_DAYS_MAX = 90;

export const countingSchema = z.enum(['registered', 'first_seen']);
export const chatBonusSchema = z.object({
  enabled: z.boolean(),
  sec: z.int().min(1).max(60),
  minWords: z.int().min(1).max(20),
  cooldownSec: z.int().min(1).max(600),
});

/** Ergänzt Einstellungen aus Ereignissen der Version 1 um legal und die Dienst-Felder. */
export function upcastSettingsV1(s: unknown): unknown {
  const old = (s ?? {}) as Record<string, unknown>;
  return {
    ...old,
    legal: old.legal ?? null,
    counting: old.counting ?? SERVICE_DEFAULTS.counting,
    purgeDays: old.purgeDays ?? SERVICE_DEFAULTS.purgeDays,
    keyword: old.keyword ?? SERVICE_DEFAULTS.keyword,
    chatBonus: old.chatBonus ?? SERVICE_DEFAULTS.chatBonus,
  };
}

/** v2 → v3: Kontaktweg des Streamers (Teilprojekt 8a, NEW_DESIGN.md 7.3). */
export function upcastSettingsV2(s: unknown): unknown {
  const old = (s ?? {}) as Record<string, unknown>;
  return { ...old, contact: old.contact ?? null };
}

/** v3 → v4: Chat-Ansagen (Teilprojekt 8d, NEW_DESIGN.md 10.3). */
export function upcastSettingsV3(s: unknown): unknown {
  const old = (s ?? {}) as Record<string, unknown>;
  return { ...old, announcements: old.announcements ?? ANNOUNCEMENT_DEFAULTS };
}

export const SERVICE_EVENT_TYPES = {
  boostStarted: 'boost_started',
  boostEnded: 'boost_ended',
  unregisteredPurged: 'unregistered_purged',
} as const;

export const BOOST_FACTOR_MIN = 2;
export const BOOST_FACTOR_MAX = 10;

const entry = z.object({ pid: z.uuid(), sec: z.int().min(1).max(3600) });
export const creditedSchema = z.object({
  minute: z.string().regex(MINUTE_RE),
  channel: z.uuid(),
  factor: z.int().min(1).max(BOOST_FACTOR_MAX),
  entries: z.array(entry).min(1),
});
export const chatCreditedSchema = creditedSchema.extend({
  entries: z.array(entry.extend({ lastAt: z.iso.datetime() })).min(1),
});
export const correctedSchema = z.object({
  channel: z.uuid(),
  entries: z.array(z.object({ pid: z.uuid(), sec: z.int().refine((n) => n !== 0, 'sec darf nicht 0 sein') })).min(1),
});

/** Übernahme aus dem Altsystem (NEW_DESIGN.md 15.6): Umkehrart none, der Grund steht in der UI. */
export const LEGACY_IMPORTED_WHY = 'Altbestand. Korrektur über Zeit-Korrektur.';
export const legacyImportedSchema = z.object({
  legacySessionId: z.string().min(1).max(100),
  status: z.enum(['paused', 'closed']),
  terms: z.object({ version: z.int().min(1), text: z.string().min(1).max(TERMS_TEXT_MAX) }).nullable(),
  registered: z.array(z.uuid()),
  entries: z.array(z.object({ pid: z.uuid(), channel: z.uuid(), sec: z.int().min(1) })),
});

export interface BoostState {
  factor: number;
  since: string;
  until: string;
  eventId: string;
}

/** Faktor für eine Minute: Boost läuft, die Minute liegt vor dem Ende und der Boost begann vor dem Minutenende. */
export function boostFactor(boost: BoostState | null, minute: string): number {
  if (boost === null) return 1;
  const m = Date.parse(minute);
  if (!(m < Date.parse(boost.until))) return 1;
  if (!(Date.parse(boost.since) < m + 60_000)) return 1;
  return boost.factor;
}

/** Gegen-Ereignis einer Gutschrift: dieselben wirksamen Sekunden abziehen. */
function negate(payload: CreditedPayload) {
  return {
    type: FRAMEWORK_EVENTS.watchCorrected,
    payload: { channel: payload.channel, entries: payload.entries.map((e) => ({ pid: e.pid, sec: -(e.sec * payload.factor) })) },
  };
}

export function registerServiceEvents(registry: EventTypeRegistry): void {
  registry.register({
    type: FRAMEWORK_EVENTS.watchCredited,
    version: 1,
    schema: creditedSchema,
    reversal: { kind: 'compensate', inverse: (target) => negate(target.payload as CreditedPayload) },
  });
  registry.register({
    type: FRAMEWORK_EVENTS.chatCredited,
    version: 1,
    schema: chatCreditedSchema,
    reversal: { kind: 'compensate', inverse: (target) => negate(target.payload as CreditedPayload) },
  });
  registry.register({
    type: FRAMEWORK_EVENTS.watchCorrected,
    version: 1,
    schema: correctedSchema,
    requiresReason: true,
    reversal: {
      kind: 'compensate',
      inverse(target) {
        const p = target.payload as { channel: Pid; entries: { pid: Pid; sec: number }[] };
        return { type: FRAMEWORK_EVENTS.watchCorrected, payload: { channel: p.channel, entries: p.entries.map((e) => ({ pid: e.pid, sec: -e.sec })) } };
      },
    },
  });
  registry.register({
    type: FRAMEWORK_EVENTS.legacyImported,
    version: 1,
    schema: legacyImportedSchema,
    reversal: { kind: 'none', why: LEGACY_IMPORTED_WHY },
  });
  registry.register({
    type: SERVICE_EVENT_TYPES.boostStarted,
    version: 1,
    schema: z.object({ factor: z.int().min(BOOST_FACTOR_MIN).max(BOOST_FACTOR_MAX), until: z.iso.datetime() }),
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        if ((state as GiveawayState).boost?.eventId !== target.id) return reject('boost_not_active', 'Dieser Boost läuft nicht mehr.');
        return { type: SERVICE_EVENT_TYPES.boostEnded, payload: {} };
      },
    },
  });
  registry.register({
    type: SERVICE_EVENT_TYPES.boostEnded,
    version: 1,
    schema: z.object({}),
    reversal: { kind: 'none', why: 'Ein beendeter Boost bleibt beendet. Starte einen neuen Boost.' },
  });
  registry.register({
    type: SERVICE_EVENT_TYPES.unregisteredPurged,
    version: 1,
    schema: z.object({ pids: z.array(z.uuid()) }),
    reversal: { kind: 'none', why: 'DSGVO-Löschung. Die Zuordnung ist entfernt.' },
  });
}
