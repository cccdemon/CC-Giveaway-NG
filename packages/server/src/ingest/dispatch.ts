// Ein Signalbündel wird je offenem Giveaway des Kanals ein Befehl apply_signals mit Akteur system:ingest (NEW_DESIGN.md 3.3).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { BusLogger } from '../framework/command-bus.js';
import type { Runtime } from '../framework/runtime.js';
import type { Pid } from '../kernel-api/index.js';
import type { SignalBundle } from './bundler.js';

export interface GiveawayLookup {
  openGiveawaysFor(channel: Pid): Promise<string[]>;
}

export function pgGiveawayLookup(pool: pg.Pool): GiveawayLookup {
  return {
    async openGiveawaysFor(channel) {
      const r = await pool.query<{ id: string }>("SELECT id FROM giveaways WHERE status = 'open' AND channels @> $1::jsonb ORDER BY id", [JSON.stringify([channel])]);
      return r.rows.map((x) => x.id);
    },
  };
}

export interface DispatchResult {
  giveaways: number;
  rejected: number;
  failed: number;
}

export function dispatcher(o: { rt: Runtime; lookup: GiveawayLookup; log: BusLogger; now: () => Date }) {
  return {
    async handle(b: SignalBundle): Promise<DispatchResult> {
      const now = o.now();
      const ids = await o.lookup.openGiveawaysFor(b.channel);
      let rejected = 0, failed = 0;
      for (const giveawayId of ids) {
        try {
          const r = await o.rt.bus.execute(
            o.rt.handlers.applySignals,
            { giveawayId, channel: b.channel, minute: b.minute, presence: b.presence, chat: b.chat, follows: b.follows },
            { actor: 'system:ingest', correlationId: randomUUID(), now },
          );
          if (!r.ok) rejected++;
        } catch (err) {
          failed++;
          o.log.error({ err, giveawayId, channel: b.channel, minute: b.minute }, 'Signale für ein Giveaway ließen sich nicht anwenden. Die Minute ist für dieses Giveaway verloren.');
        }
      }
      return { giveaways: ids.length, rejected, failed };
    },
  };
}
