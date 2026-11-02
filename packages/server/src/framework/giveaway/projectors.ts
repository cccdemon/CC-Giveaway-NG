// Lesetabellen des Stroms giveaway:<id>. Sie entstehen aus dem Zustand nach jedem Befehl.
import type pg from 'pg';
import type { StreamId } from '../../journal/types.js';
import type { KernelRegistry } from '../kernel-registry.js';
import type { Runtime } from '../runtime.js';
import { UUID_RE } from './authorize.js';
import type { StateProjector } from '../projections.js';
import { giveawayStream, type GiveawayState, type GiveawayStatus } from './state.js';

const PREFIX = 'giveaway:';

function idOf(stream: StreamId): string {
  return stream.startsWith(PREFIX) ? stream.slice(PREFIX.length) : stream;
}

export function giveawaysProjector(kernels: KernelRegistry): StateProjector<GiveawayState> {
  return {
    name: 'giveaways',
    reducer: 'giveaway',
    async apply(c: pg.PoolClient, stream: StreamId, state: GiveawayState, head: { seq: number; at: Date }) {
      if (!state.exists) return;
      const kernel = kernels.get(state.kernelId);
      const s = state.settings;
      const pool = kernel.pool(state.kernelState, s.config);
      const poolWeight = pool.reduce((sum, e) => sum + e.weight, 0);
      await c.query(
        `INSERT INTO giveaways (id, team_id, kernel, kernel_version, status, prize, sponsor, winners_count, claim_days,
           config, channels, gates, registered_count, pool_size, pool_weight, last_seq, created_at, updated_at,
           counting, purge_days, closed_at, purged_at, boost)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17, $18, $19, $20, $21, $22)
         ON CONFLICT (id) DO UPDATE SET
           team_id = EXCLUDED.team_id, kernel = EXCLUDED.kernel, kernel_version = EXCLUDED.kernel_version,
           status = EXCLUDED.status, prize = EXCLUDED.prize, sponsor = EXCLUDED.sponsor,
           winners_count = EXCLUDED.winners_count, claim_days = EXCLUDED.claim_days, config = EXCLUDED.config,
           channels = EXCLUDED.channels, gates = EXCLUDED.gates, registered_count = EXCLUDED.registered_count,
           pool_size = EXCLUDED.pool_size, pool_weight = EXCLUDED.pool_weight, last_seq = EXCLUDED.last_seq,
           updated_at = EXCLUDED.updated_at, counting = EXCLUDED.counting, purge_days = EXCLUDED.purge_days,
           closed_at = EXCLUDED.closed_at, purged_at = EXCLUDED.purged_at, boost = EXCLUDED.boost`,
        [
          idOf(stream),
          state.teamId,
          state.kernelId,
          kernel.version,
          state.status,
          s.prize,
          s.sponsor,
          s.winnersCount,
          s.claimDays,
          JSON.stringify(s.config),
          JSON.stringify(s.channels),
          JSON.stringify(s.gates),
          Object.keys(state.registered).length,
          pool.length,
          poolWeight,
          head.seq,
          head.at,
          s.counting,
          s.purgeDays,
          state.closedAt === null ? null : new Date(state.closedAt),
          state.purgedAt === null ? null : new Date(state.purgedAt),
          state.boost === null ? null : JSON.stringify(state.boost),
        ],
      );
    },
    async reset(c: pg.PoolClient, stream?: StreamId) {
      if (stream === undefined) await c.query('DELETE FROM giveaways');
      else if (UUID_RE.test(idOf(stream))) await c.query('DELETE FROM giveaways WHERE id = $1', [idOf(stream)]);
    },
  };
}

/**
 * Eine Zeile je angemeldetem, gesehenem oder im Topf stehendem Teilnehmer. Die Chance wird nicht gespeichert
 * (Gewicht ÷ giveaways.pool_weight beim Lesen). Schreibt bei jedem Befehl alle Zeilen in einer Anweisung neu.
 */
export function participantsProjector(kernels: KernelRegistry): StateProjector<GiveawayState> {
  return {
    name: 'giveaway_participants',
    reducer: 'giveaway',
    async apply(c: pg.PoolClient, stream: StreamId, state: GiveawayState) {
      if (!state.exists) return;
      const id = idOf(stream);
      const pool = kernels.get(state.kernelId).pool(state.kernelState, state.settings.config);
      const weights = new Map(pool.map((e) => [e.pid, e.weight]));
      const pids = [...new Set([...Object.keys(state.registered), ...weights.keys(), ...Object.keys(state.seen)])];
      await c.query('DELETE FROM giveaway_participants WHERE giveaway_id = $1 AND NOT (pid = ANY($2::uuid[]))', [id, pids]);
      if (pids.length === 0) return;
      await c.query(
        `INSERT INTO giveaway_participants (giveaway_id, pid, registered, in_pool, weight, winner_status, seen)
         SELECT $1::uuid, * FROM unnest($2::uuid[], $3::bool[], $4::bool[], $5::float8[], $6::text[], $7::bool[])
         ON CONFLICT (giveaway_id, pid) DO UPDATE SET
           registered = EXCLUDED.registered, in_pool = EXCLUDED.in_pool, weight = EXCLUDED.weight,
           winner_status = EXCLUDED.winner_status, seen = EXCLUDED.seen`,
        [
          id,
          pids,
          pids.map((pid) => pid in state.registered),
          pids.map((pid) => weights.has(pid)),
          pids.map((pid) => weights.get(pid) ?? 0),
          pids.map((pid) => state.winners[pid] ?? null),
          pids.map((pid) => pid in state.seen),
        ],
      );
    },
    async reset(c: pg.PoolClient, stream?: StreamId) {
      if (stream === undefined) await c.query('DELETE FROM giveaway_participants');
      else if (UUID_RE.test(idOf(stream))) await c.query('DELETE FROM giveaway_participants WHERE giveaway_id = $1', [idOf(stream)]);
    },
  };
}

/** Zeitgeber des Rahmens tragen dieses Präfix im Befehlstyp. Der Scheduler ruft dafür den Rahmen-Befehl. */
export const FRAMEWORK_TIMER_PREFIX = 'framework:';
export const BOOST_END_TIMER = { key: 'boost_end', type: `${FRAMEWORK_TIMER_PREFIX}stop_boost` } as const;

/** Zeitgeber des Kerns (nur Offen) und des Rahmens (Boost-Ende, jeder Zustand). Der Scheduler liest die Tabelle. */
export function timersProjector(kernels: KernelRegistry): StateProjector<GiveawayState> {
  return {
    name: 'timers',
    reducer: 'giveaway',
    async apply(c: pg.PoolClient, stream: StreamId, state: GiveawayState) {
      if (!state.exists) return;
      const kernel = kernels.get(state.kernelId);
      const specs = state.status === 'open' ? (kernel.timers?.(state.kernelState, state.settings.config) ?? []) : [];
      if (state.boost !== null) specs.push({ key: BOOST_END_TIMER.key, dueAt: state.boost.until, command: { type: BOOST_END_TIMER.type, args: {} } });
      await c.query('DELETE FROM timers WHERE stream = $1 AND NOT (key = ANY($2::text[]))', [stream, specs.map((t) => t.key)]);
      for (const t of specs) {
        await c.query(
          `INSERT INTO timers (stream, key, due_at, command) VALUES ($1, $2, $3, $4)
           ON CONFLICT (stream, key) DO UPDATE SET due_at = EXCLUDED.due_at, command = EXCLUDED.command`,
          [stream, t.key, new Date(t.dueAt), JSON.stringify(t.command)],
        );
      }
    },
    async reset(c: pg.PoolClient, stream?: StreamId) {
      if (stream === undefined) await c.query('DELETE FROM timers');
      else await c.query('DELETE FROM timers WHERE stream = $1', [stream]);
    },
  };
}

/** Zustände, in denen ein Giveaway noch läuft. Nur hier baut ein Kern-Versionswechsel die Lesetabellen neu auf. */
export const RUNNING: readonly GiveawayStatus[] = ['draft', 'open', 'paused', 'closed'] as const;

/**
 * Giveaways in RUNNING mit abweichender kernel_version → rebuildStream. Liefert die neu aufgebauten ids.
 * Giveaways mit unbekanntem Kern bleiben unberührt und stehen in skipped. Abgeschlossene behalten ihre Version.
 */
export async function reconcileKernelVersions(
  pool: pg.Pool,
  rt: Runtime,
): Promise<{ rebuilt: string[]; skipped: { id: string; kernel: string }[] }> {
  const r = await pool.query<{ id: string; kernel: string; kernel_version: number }>(
    'SELECT id, kernel, kernel_version FROM giveaways WHERE status = ANY($1) ORDER BY id',
    [[...RUNNING]],
  );
  const rebuilt: string[] = [];
  const skipped: { id: string; kernel: string }[] = [];
  for (const row of r.rows) {
    if (!rt.kernels.has(row.kernel)) {
      skipped.push({ id: row.id, kernel: row.kernel });
      continue;
    }
    if (rt.kernels.get(row.kernel).version === row.kernel_version) continue;
    await rt.projections.rebuildStream(pool, rt.registry, giveawayStream(row.id), rt.reducer);
    rebuilt.push(row.id);
  }
  return { rebuilt, skipped };
}
