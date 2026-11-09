// Zustand des Stroms platform (NEW_DESIGN.md 5.1): Sperren und Verwarnungen für Streamer, Fassungen der Nutzungsbedingungen. Rein.
import type { StreamReducer } from '../framework/command-bus.js';
import type { EventRecord, StreamId } from '../journal/types.js';

export const PLATFORM_STREAM: StreamId = 'platform';

export const PLATFORM_EVENTS = {
  banned: 'streamer_banned',
  unbanned: 'streamer_unbanned',
  warned: 'streamer_warned',
  warningWithdrawn: 'warning_withdrawn',
  termsPublished: 'terms_published',
} as const;

export interface Warning {
  eventId: string;
  reason: string;
  at: string;
}

export interface PlatformState {
  bans: Record<string, { reason: string; since: string; eventId: string }>;
  warnings: Record<string, Warning[]>;
  terms: { version: number; publishedAt: string } | null;
}

function apply(s: PlatformState, e: EventRecord): PlatformState {
  const at = e.createdAt.toISOString();
  switch (e.type) {
    case PLATFORM_EVENTS.banned: {
      const { pid } = e.payload as { pid: string };
      return { ...s, bans: { ...s.bans, [pid]: { reason: e.reason ?? '', since: at, eventId: e.id } } };
    }
    case PLATFORM_EVENTS.unbanned: {
      const { pid } = e.payload as { pid: string };
      const bans = { ...s.bans };
      delete bans[pid];
      return { ...s, bans };
    }
    case PLATFORM_EVENTS.warned: {
      const { pid } = e.payload as { pid: string };
      return { ...s, warnings: { ...s.warnings, [pid]: [...(s.warnings[pid] ?? []), { eventId: e.id, reason: e.reason ?? '', at }] } };
    }
    case PLATFORM_EVENTS.warningWithdrawn: {
      const { pid, warningEventId } = e.payload as { pid: string; warningEventId: string };
      const rest = (s.warnings[pid] ?? []).filter((w) => w.eventId !== warningEventId);
      const warnings = { ...s.warnings };
      if (rest.length === 0) delete warnings[pid];
      else warnings[pid] = rest;
      return { ...s, warnings };
    }
    case PLATFORM_EVENTS.termsPublished: {
      const { version } = e.payload as { version: number };
      return { ...s, terms: { version, publishedAt: at } };
    }
    default:
      return s;
  }
}

export const platformReducer: StreamReducer<PlatformState> = {
  name: 'platform',
  version: 1,
  initial: () => ({ bans: {}, warnings: {}, terms: null }),
  apply,
};
