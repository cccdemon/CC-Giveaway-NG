// Ereignistypen des Stroms account:<pid> mit Umkehrarten (NEW_DESIGN.md 5.3).
import { z } from 'zod';
import type { EventTypeRegistry } from '../../journal/event-types.js';
import { legalSchema, type LegalTexts } from '../../framework/legal.js';
import { canonicalJson } from '../../shared/canonical.js';
import { reject } from '../../shared/rejection.js';
import { ACCOUNT_EVENTS, type AccountState } from './state.js';

const NOT_LATEST = () => reject('not_latest', 'Nimm zuerst die späteren Änderungen zurück.');

export function registerAccountEvents(registry: EventTypeRegistry): void {
  registry.register({
    type: ACCOUNT_EVENTS.created,
    version: 1,
    schema: z.object({ soloTeamId: z.uuid() }),
    reversal: { kind: 'none', why: 'Ein Konto entsteht beim Anmelden. Lösche es unter Meine Daten.' },
  });

  const terms = z.object({ version: z.int().min(0), previous: z.int().min(0) });
  registry.register({
    type: ACCOUNT_EVENTS.termsAccepted,
    version: 1,
    schema: terms,
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const p = target.payload as { version: number; previous: number };
        if ((state as AccountState).termsVersion !== p.version) return NOT_LATEST();
        return { type: ACCOUNT_EVENTS.termsWithdrawn, payload: p };
      },
    },
  });
  registry.register({
    type: ACCOUNT_EVENTS.termsWithdrawn,
    version: 1,
    schema: terms,
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const p = target.payload as { version: number; previous: number };
        if ((state as AccountState).termsVersion !== p.previous) return NOT_LATEST();
        return { type: ACCOUNT_EVENTS.termsAccepted, payload: p };
      },
    },
  });

  registry.register({
    type: ACCOUNT_EVENTS.profileUpdated,
    version: 1,
    schema: z.object({ before: legalSchema, after: legalSchema }),
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const { before, after } = target.payload as { before: LegalTexts; after: LegalTexts };
        if (canonicalJson((state as AccountState).legal) !== canonicalJson(after)) return NOT_LATEST();
        return { type: ACCOUNT_EVENTS.profileUpdated, payload: { before: after, after: before } };
      },
    },
  });

  const scopes = z.object({ scopes: z.array(z.string().min(1)) });
  registry.register({
    type: ACCOUNT_EVENTS.channelConnected,
    version: 1,
    schema: scopes,
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        if (!(state as AccountState).channelConnected) return reject('not_connected', 'Es ist kein Kanal verbunden.');
        return { type: ACCOUNT_EVENTS.channelDisconnected, payload: target.payload };
      },
    },
  });
  registry.register({
    type: ACCOUNT_EVENTS.channelDisconnected,
    version: 1,
    schema: scopes,
    reversal: { kind: 'none', why: 'Zum Verbinden brauchst du eine neue Anmeldung bei Twitch.' },
  });

  registry.register({
    type: ACCOUNT_EVENTS.deleted,
    version: 1,
    schema: z.object({}),
    reversal: { kind: 'none', why: 'Eine Löschung lässt sich nicht rückgängig machen.' },
  });
}
