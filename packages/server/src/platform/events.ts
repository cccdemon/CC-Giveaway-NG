// Ereignistypen des Stroms platform mit Umkehrarten (NEW_DESIGN.md 5.3). Payloads tragen nur pids, Ereignis-IDs und den Text der Fassung.
import { z } from 'zod';
import type { EventTypeRegistry } from '../journal/event-types.js';
import { reject } from '../shared/rejection.js';
import { PLATFORM_EVENTS, type PlatformState } from './state.js';

export const TERMS_TEXT_MAX = 50_000;

const pidPayload = z.object({ pid: z.uuid() });

export function registerPlatformEvents(registry: EventTypeRegistry): void {
  registry.register({
    type: PLATFORM_EVENTS.banned,
    version: 1,
    schema: pidPayload,
    requiresReason: true,
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const { pid } = target.payload as { pid: string };
        if (!(state as PlatformState).bans[pid]) return reject('not_banned', 'Diese Person ist nicht gesperrt.');
        return { type: PLATFORM_EVENTS.unbanned, payload: { pid } };
      },
    },
  });
  registry.register({
    type: PLATFORM_EVENTS.unbanned,
    version: 1,
    schema: pidPayload,
    requiresReason: true,
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const { pid } = target.payload as { pid: string };
        if ((state as PlatformState).bans[pid]) return reject('already_banned', 'Diese Person ist schon gesperrt.');
        return { type: PLATFORM_EVENTS.banned, payload: { pid } };
      },
    },
  });
  registry.register({
    type: PLATFORM_EVENTS.warned,
    version: 1,
    schema: pidPayload,
    requiresReason: true,
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const { pid } = target.payload as { pid: string };
        if (!(state as PlatformState).warnings[pid]?.some((w) => w.eventId === target.id)) {
          return reject('warning_not_found', 'Diese Verwarnung gibt es nicht mehr.');
        }
        return { type: PLATFORM_EVENTS.warningWithdrawn, payload: { pid, warningEventId: target.id } };
      },
    },
  });
  registry.register({
    type: PLATFORM_EVENTS.warningWithdrawn,
    version: 1,
    schema: z.object({ pid: z.uuid(), warningEventId: z.string().min(1) }),
    requiresReason: true,
    reversal: { kind: 'none', why: 'Eine zurückgenommene Verwarnung bleibt zurückgenommen. Sprich eine neue aus.' },
  });
  registry.register({
    type: PLATFORM_EVENTS.termsPublished,
    version: 1,
    schema: z.object({ version: z.int().min(1), text: z.string().min(1).max(TERMS_TEXT_MAX) }),
    reversal: { kind: 'none', why: 'Eine veröffentlichte Fassung ist ein Nachweis. Veröffentliche eine neue.' },
  });
}
