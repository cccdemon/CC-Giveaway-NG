// Nachweis einer gesendeten Ansage (NEW_DESIGN.md 10.3, 5.3): announcement_sent, Umkehrart none, nur vom Ingest.
// Der Payload trägt keinen Text und keinen Namen: Art, Kanal (pid), auslösendes Ereignis, Erfolg, Fehlercode, Nachrichten-ID.
import type { Pid } from '../../kernel-api/index.js';
import { reject } from '../../shared/rejection.js';
import { UUID_RE } from '../authorize.js';
import type { CommandHandler } from '../command-bus.js';
import type { GiveawayDeps } from './lifecycle.js';
import { GIVEAWAY_NOT_FOUND } from './authorize.js';
import { ANNOUNCEMENT_SENT } from './announcements.js';
import { giveawayStream, type GiveawayState } from './state.js';

export interface RecordAnnouncementCmd {
  giveawayId: string;
  kind: string;
  channel: Pid;
  triggerEventId: string;
  ok: boolean;
  error?: string;
  messageId?: string;
}

export function recordAnnouncementHandler(d: GiveawayDeps): CommandHandler<RecordAnnouncementCmd, GiveawayState> {
  return {
    type: 'record_announcement',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: (_cmd, ctx) => (ctx.actor === 'system:ingest' ? null : reject('system_only', 'Diesen Befehl sendet nur der Ingest.')),
    decide(state, cmd) {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (state.status === 'draft') return reject('not_open', 'Ein Entwurf bekommt keine Ansagen.');
      if (typeof cmd.kind !== 'string' || cmd.kind.trim() === '' || cmd.kind.length > 60) return reject('invalid_announcement', 'Die Art der Ansage fehlt.');
      if (typeof cmd.channel !== 'string' || !UUID_RE.test(cmd.channel)) return reject('invalid_channel', 'Ein Kanal ist keine gültige ID.');
      if (typeof cmd.triggerEventId !== 'string' || cmd.triggerEventId === '') return reject('invalid_announcement', 'Das auslösende Ereignis fehlt.');
      if (typeof cmd.ok !== 'boolean') return reject('invalid_announcement', 'Das Ergebnis der Ansage fehlt.');
      return [
        {
          type: ANNOUNCEMENT_SENT,
          payload: {
            kind: cmd.kind,
            channel: cmd.channel,
            triggerEventId: cmd.triggerEventId,
            ok: cmd.ok,
            ...(typeof cmd.error === 'string' && cmd.error !== '' ? { error: cmd.error.slice(0, 200) } : {}),
            ...(typeof cmd.messageId === 'string' && cmd.messageId !== '' ? { messageId: cmd.messageId.slice(0, 200) } : {}),
          },
        },
      ];
    },
  };
}
