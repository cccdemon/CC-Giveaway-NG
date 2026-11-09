// Löschfrist für Unangemeldete (NEW_DESIGN.md 6.1, 12.4): Wer in der Zählweise „ab erstem Erscheinen“ eine pid bekam und sich
// bis Schließen + Frist nicht anmeldete, verliert die Zuordnung. Das Ereignis nennt die pids, ein Projektor im Modul identity löscht.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Queryable } from '../../db/pool.js';
import type { Pid } from '../../kernel-api/index.js';
import { reject, type Rejection } from '../../shared/rejection.js';
import type { CommandContext, CommandHandler } from '../command-bus.js';
import type { Runtime } from '../runtime.js';
import { GIVEAWAY_NOT_FOUND, authorizeControl } from './authorize.js';
import type { GiveawayCmd, GiveawayDeps } from './lifecycle.js';
import { RUNNING } from './projectors.js';
import { SERVICE_EVENT_TYPES } from './services.js';
import { giveawayStream, type GiveawayState, type GiveawayStatus } from './state.js';

export const PURGE_STATUSES: readonly GiveawayStatus[] = ['closed', 'drawn', 'completed', 'cancelled'];

const DAY_MS = 86_400_000;

/**
 * Löschbar ist nur, wer kein Konto hat, nirgends angemeldet oder Gewinner ist (auch nicht in abgeschlossenen Giveaways,
 * Spec 7.3: der Gewinn muss meldbar bleiben), in keinem anderen laufenden Giveaway gesehen wurde und in keinem Team
 * gesperrt ist (15.3: die Sperre braucht die Zuordnung, sonst käme die Person mit neuer pid zurück).
 */
async function deletable(c: pg.PoolClient, giveawayId: string, candidates: Pid[]): Promise<Pid[]> {
  if (candidates.length === 0) return [];
  const r = await c.query<{ pid: string }>(
    `SELECT p.pid FROM unnest($1::uuid[]) AS p(pid)
     WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.pid = p.pid)
       AND NOT EXISTS (SELECT 1 FROM giveaway_participants gp WHERE gp.pid = p.pid AND (gp.registered OR gp.winner_status IS NOT NULL))
       AND NOT EXISTS (
         SELECT 1 FROM giveaway_participants gp JOIN giveaways g ON g.id = gp.giveaway_id
         WHERE gp.pid = p.pid AND g.id <> $2 AND g.status = ANY($3)
       )
       AND NOT EXISTS (SELECT 1 FROM team_bans b WHERE b.pid = p.pid)
     ORDER BY p.pid`,
    [candidates, giveawayId, [...RUNNING]],
  );
  return r.rows.map((x) => x.pid);
}

export function purgeUnregisteredHandler(d: GiveawayDeps): CommandHandler<GiveawayCmd, GiveawayState, Pid[]> {
  const control = authorizeControl(d.auth);
  return {
    type: 'purge_unregistered',
    streamOf: (cmd) => giveawayStream(cmd.giveawayId),
    reducer: d.reducer,
    authorize: (cmd: GiveawayCmd, ctx: CommandContext, c: pg.PoolClient) => (ctx.actor === 'system:scheduler' ? null : control(cmd, ctx, c)),
    prepare(c, cmd, _ctx, _pre, state) {
      const candidates = Object.keys(state.seen).filter((pid) => !(pid in state.registered));
      return deletable(c, cmd.giveawayId, candidates);
    },
    decide(state, _cmd, ctx, pids): Rejection | ReturnType<CommandHandler<GiveawayCmd, GiveawayState>['decide']> {
      if (!state.exists) return GIVEAWAY_NOT_FOUND();
      if (!PURGE_STATUSES.includes(state.status) || state.closedAt === null) return reject('purge_not_closed', 'Die Löschung läuft erst nach dem Schließen.');
      if (state.purgedAt !== null) return reject('already_purged', 'Die Unangemeldeten dieses Giveaways sind schon gelöscht.');
      if (Date.parse(state.closedAt) + state.settings.purgeDays * DAY_MS > ctx.now.getTime()) return reject('purge_not_due', 'Die Löschfrist ist noch nicht um.');
      return [{ type: SERVICE_EVENT_TYPES.unregisteredPurged, payload: { pids: [...pids].sort() } }];
    },
  };
}

/** Giveaways, deren Löschfrist um ist. Nur die Zählweise „ab erstem Erscheinen“ kennt Unangemeldete. */
export async function dueForPurge(db: Queryable, now: Date): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM giveaways
     WHERE purged_at IS NULL AND counting = 'first_seen' AND status = ANY($1)
       AND closed_at IS NOT NULL AND closed_at + purge_days * interval '1 day' <= $2
     ORDER BY closed_at, id`,
    [[...PURGE_STATUSES], now],
  );
  return r.rows.map((x) => x.id);
}

/** Stündlich aus der Wartung: je fälligem Giveaway ein Befehl mit Akteur system:scheduler. */
export async function purgeUnregisteredAll(pool: pg.Pool, rt: Runtime, now: Date): Promise<{ purged: number; pids: number; failed: number }> {
  let purged = 0, pids = 0, failed = 0;
  for (const giveawayId of await dueForPurge(pool, now)) {
    try {
      const r = await rt.bus.execute(rt.handlers.purgeUnregistered, { giveawayId }, { actor: 'system:scheduler', correlationId: randomUUID(), now });
      if (!r.ok) {
        failed++;
        continue;
      }
      purged++;
      for (const e of r.events) pids += (e.payload as { pids: Pid[] }).pids.length;
    } catch {
      failed++;
    }
  }
  return { purged, pids, failed };
}
