import { z } from 'zod';
import type { EventTypeRegistry } from '../journal/event-types.js';
import { isReverted, readEvent } from '../journal/journal.js';
import type { EventId, EventRecord, StreamId } from '../journal/types.js';
import { isRejection, reject } from '../shared/rejection.js';
import type { CommandHandler, StreamReducer } from './command-bus.js';

export interface RevertCommand {
  stream: StreamId;
  eventId: EventId;
  reason: string;
}

export interface RevertPrepared {
  target: EventRecord | null;
  reverted: boolean;
}

export const EVENT_VOIDED = 'event_voided';

export function registerRevertTypes(registry: EventTypeRegistry): void {
  registry.register({
    type: EVENT_VOIDED,
    version: 1,
    schema: z.object({ targetType: z.string() }),
    requiresReason: true,
    reversal: { kind: 'none', why: 'Ein ungültiger Eintrag bleibt ungültig. Für ein neues Ergebnis führe die Aktion neu aus.' },
  });
}

export function makeRevertHandler<S>(
  reducer: StreamReducer<S>,
  registry: EventTypeRegistry,
  authorize: CommandHandler<RevertCommand, S, RevertPrepared>['authorize'],
): CommandHandler<RevertCommand, S, RevertPrepared> {
  return {
    type: 'revert',
    streamOf: (cmd) => cmd.stream,
    reducer,
    authorize,
    async prepare(c, cmd) {
      const target = await readEvent(c, registry, cmd.eventId);
      const reverted = target ? await isReverted(c, cmd.eventId) : false;
      return { target, reverted };
    },
    decide(state, cmd, _ctx, { target, reverted }) {
      if (typeof cmd.reason !== 'string' || !cmd.reason.trim()) return reject('reason_required', 'Gib einen Grund für die Umkehrung an.');
      if (!target || target.stream !== cmd.stream) return reject('event_not_found', 'Diesen Eintrag gibt es in diesem Verlauf nicht.');
      if (reverted) return reject('already_reverted', 'Dieser Eintrag ist schon aufgehoben.');
      const spec = registry.get(target.type).reversal;
      if (spec.kind === 'none') return reject('not_reversible', spec.why);
      if (spec.kind === 'void') {
        return [{ type: EVENT_VOIDED, payload: { targetType: target.type }, reason: cmd.reason, reversesEventId: target.id }];
      }
      const inverse = spec.inverse(target, state);
      if (isRejection(inverse)) return inverse;
      return [{ ...inverse, reason: cmd.reason, reversesEventId: target.id }];
    },
  };
}
