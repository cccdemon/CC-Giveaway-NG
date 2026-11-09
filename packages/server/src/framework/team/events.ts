// Ereignistypen des Stroms team:<id> mit Umkehrarten (NEW_DESIGN.md 5.3, 9.3). Payloads tragen nur pids, UUIDs und den Teamnamen.
import { z } from 'zod';
import type { EventTypeRegistry } from '../../journal/event-types.js';
import { reject } from '../../shared/rejection.js';
import { TEAM_EVENTS, TEAM_NAME_MAX, type TeamState } from './state.js';

const NOT_LATEST = () => reject('not_latest', 'Nimm zuerst die späteren Änderungen zurück.');
const name = z.string().min(1).max(TEAM_NAME_MAX);
const pidPayload = z.object({ pid: z.uuid() });
const invitePayload = z.object({ inviteId: z.uuid() });

export function registerTeamEvents(registry: EventTypeRegistry): void {
  registry.register({
    type: TEAM_EVENTS.created,
    version: 1,
    schema: z.object({ name, members: z.array(z.uuid()).min(1) }),
    reversal: { kind: 'none', why: 'Ein Team bleibt im Nachweis. Deaktiviere es.' },
  });

  registry.register({
    type: TEAM_EVENTS.renamed,
    version: 1,
    schema: z.object({ before: name, after: name }),
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const { before, after } = target.payload as { before: string; after: string };
        if ((state as TeamState).name !== after) return NOT_LATEST();
        return { type: TEAM_EVENTS.renamed, payload: { before: after, after: before } };
      },
    },
  });

  registry.register({
    type: TEAM_EVENTS.inviteCreated,
    version: 1,
    schema: z.object({ inviteId: z.uuid(), expiresAt: z.iso.datetime() }),
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const { inviteId } = target.payload as { inviteId: string };
        const invite = (state as TeamState).invites[inviteId];
        if (!invite || invite.revoked) return reject('invite_revoked', 'Diese Einladung ist schon widerrufen.');
        return { type: TEAM_EVENTS.inviteRevoked, payload: { inviteId } };
      },
    },
  });
  registry.register({
    type: TEAM_EVENTS.inviteRevoked,
    version: 1,
    schema: invitePayload,
    reversal: { kind: 'none', why: 'Erzeuge eine neue Einladung.' },
  });

  registry.register({
    type: TEAM_EVENTS.memberJoined,
    version: 1,
    schema: z.object({ pid: z.uuid(), inviteId: z.uuid().nullable() }),
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const s = state as TeamState;
        const { pid } = target.payload as { pid: string };
        if (!s.members[pid]) return reject('not_member', 'Du bist kein Mitglied dieses Teams.');
        if (Object.keys(s.members).length === 1) return reject('last_member', 'Du bist das letzte Mitglied. Deaktiviere das Team.');
        return { type: TEAM_EVENTS.memberLeft, payload: { pid } };
      },
    },
  });
  registry.register({
    type: TEAM_EVENTS.memberLeft,
    version: 1,
    schema: pidPayload,
    reversal: { kind: 'none', why: 'Zum Wiedereintritt braucht es eine neue Einladung.' },
  });

  registry.register({
    type: TEAM_EVENTS.deactivated,
    version: 1,
    schema: z.object({}),
    reversal: {
      kind: 'compensate',
      inverse: (_target, state) => ((state as TeamState).active ? NOT_LATEST() : { type: TEAM_EVENTS.reactivated, payload: {} }),
    },
  });
  registry.register({
    type: TEAM_EVENTS.reactivated,
    version: 1,
    schema: z.object({}),
    reversal: {
      kind: 'compensate',
      inverse: (_target, state) => ((state as TeamState).active ? { type: TEAM_EVENTS.deactivated, payload: {} } : NOT_LATEST()),
    },
  });

  registry.register({
    type: TEAM_EVENTS.banned,
    version: 1,
    schema: pidPayload,
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const { pid } = target.payload as { pid: string };
        if (!(state as TeamState).banned[pid]) return NOT_LATEST();
        return { type: TEAM_EVENTS.unbanned, payload: { pid } };
      },
    },
  });
  registry.register({
    type: TEAM_EVENTS.unbanned,
    version: 1,
    schema: pidPayload,
    reversal: {
      kind: 'compensate',
      inverse(target, state) {
        const { pid } = target.payload as { pid: string };
        if ((state as TeamState).banned[pid]) return NOT_LATEST();
        return { type: TEAM_EVENTS.banned, payload: { pid } };
      },
    },
  });
}
