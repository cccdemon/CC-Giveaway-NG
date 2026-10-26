import type { z } from 'zod';
import type { Rejection } from '../shared/rejection.js';
import { assertNoTwitchIdentity } from './guard.js';
import { JournalError, type EventId, type EventRecord, type NewEvent } from './types.js';

export type ReversalSpec =
  | { kind: 'compensate'; inverse: (target: EventRecord, state: unknown) => NewEvent | Rejection }
  | { kind: 'void' }
  | { kind: 'none'; why: string };

export interface EventTypeDef {
  type: string;
  version: number;
  schema: z.ZodTypeAny;
  reversal: ReversalSpec;
  requiresReason?: boolean;
  /** upcasters[n] übersetzt Payload-Version n nach n+1. */
  upcasters?: Record<number, (payload: unknown) => unknown>;
}

export interface PreparedEvent {
  type: string;
  typeVersion: number;
  payload: unknown;
  reason: string | null;
  reversesEventId: EventId | null;
}

export class EventTypeRegistry {
  private readonly defs = new Map<string, EventTypeDef>();

  register(def: EventTypeDef): void {
    if (this.defs.has(def.type)) throw new Error(`Ereignistyp doppelt registriert: ${def.type}`);
    for (let v = 1; v < def.version; v++) {
      if (!def.upcasters?.[v]) throw new Error(`Upcaster fehlt: ${def.type} v${v}→v${v + 1}`);
    }
    this.defs.set(def.type, def);
  }

  get(type: string): EventTypeDef {
    const def = this.defs.get(type);
    if (!def) throw new JournalError('unknown_event_type', `Unbekannter Ereignistyp: ${type}`);
    return def;
  }

  prepare(e: NewEvent): PreparedEvent {
    const def = this.get(e.type);
    const reason = e.reason?.trim() ? e.reason.trim() : null;
    if ((def.requiresReason || e.reversesEventId) && !reason) {
      throw new JournalError('reason_required', `Für ${e.type} fehlt ein Grund.`);
    }
    const parsed = def.schema.safeParse(e.payload);
    if (!parsed.success) {
      throw new JournalError('invalid_payload', `Ungültige Daten für ${e.type}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    assertNoTwitchIdentity(parsed.data);
    return { type: e.type, typeVersion: def.version, payload: parsed.data, reason, reversesEventId: e.reversesEventId ?? null };
  }

  upcast(r: EventRecord): EventRecord {
    const def = this.get(r.type);
    if (!Number.isInteger(r.typeVersion) || r.typeVersion < 1 || r.typeVersion > def.version) {
      throw new JournalError(
        'event_version_unsupported',
        `Das Ereignis ${r.type} hat die Formatversion ${r.typeVersion}, dieser Code kennt nur 1 bis ${def.version}. Aktualisiere den Code, bevor du weiterliest.`,
      );
    }
    let payload = r.payload;
    for (let v = r.typeVersion; v < def.version; v++) payload = def.upcasters![v]!(payload);
    return { ...r, payload, typeVersion: def.version };
  }
}
