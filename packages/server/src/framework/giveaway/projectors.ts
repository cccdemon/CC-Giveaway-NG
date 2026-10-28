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
           config, channels, gates, registered_count, pool_size, pool_weight, last_seq, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
         ON CONFLICT (id) DO UPDATE SET
           team_id = EXCLUDED.team_id, kernel = EXCLUDED.kernel, kernel_version = EXCLUDED.kernel_version,
           status = EXCLUDED.status, prize = EXCLUDED.prize, sponsor = EXCLUDED.sponsor,
           winners_count = EXCLUDED.winners_count, claim_days = EXCLUDED.claim_days, config = EXCLUDED.config,
           channels = EXCLUDED.channels, gates = EXCLUDED.gates, registered_count = EXCLUDED.registered_count,
           pool_size = EXCLUDED.pool_size, pool_weight = EXCLUDED.pool_weight, last_seq = EXCLUDED.last_seq,
           updated_at = EXCLUDED.updated_at`,
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
 * Eine Zeile je angemeldetem oder im Topf stehendem Teilnehmer. Die Chance wird nicht gespeichert
 * (Gewicht ÷ giveaways.pool_weight beim Lesen). Schreibt bei jedem Befehl alle Zeilen neu (TP5 macht das inkrementell).
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
      const pids = [...new Set([...Object.keys(state.registered), ...weights.keys()])];
      await c.query('DELETE FROM giveaway_participants WHERE giveaway_id = $1 AND NOT (pid = ANY($2::uuid[]))', [id, pids]);
      for (const pid of pids) {
        await c.query(
          `INSERT INTO giveaway_participants (giveaway_id, pid, registered, in_pool, weight, winner_status)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (giveaway_id, pid) DO UPDATE SET
             registered = EXCLUDED.registered, in_pool = EXCLUDED.in_pool, weight = EXCLUDED.weight,
             winner_status = EXCLUDED.winner_status`,
          [id, pid, pid in state.registered, weights.has(pid), weights.get(pid) ?? 0, state.winners[pid] ?? null],
        );
      }
    },
    async reset(c: pg.PoolClient, stream?: StreamId) {
      if (stream === undefined) await c.query('DELETE FROM giveaway_participants');
      else if (UUID_RE.test(idOf(stream))) await c.query('DELETE FROM giveaway_participants WHERE giveaway_id = $1', [idOf(stream)]);
    },
  };
}

/** Zeitgeber des Kerns. Nur ein offenes Giveaway hat Zeitgeber. Der Scheduler liest die Tabelle. */
export function timersProjector(kernels: KernelRegistry): StateProjector<GiveawayState> {
  return {
    name: 'timers',
    reducer: 'giveaway',
    async apply(c: pg.PoolClient, stream: StreamId, state: GiveawayState) {
      if (!state.exists) return;
      const kernel = kernels.get(state.kernelId);
      const specs = state.status === 'open' ? (kernel.timers?.(state.kernelState, state.settings.config) ?? []) : [];
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
 * Giveaways mit unbekanntem Kern bleiben unberührt. Abgeschlossene behalten ihre Version.
 */
export async function reconcileKernelVersions(pool: pg.Pool, rt: Runtime): Promise<string[]> {
  const r = await pool.query<{ id: string; kernel: string; kernel_version: number }>(
    'SELECT id, kernel, kernel_version FROM giveaways WHERE status = ANY($1) ORDER BY id',
    [[...RUNNING]],
  );
  const rebuilt: string[] = [];
  for (const row of r.rows) {
    if (!rt.kernels.has(row.kernel) || rt.kernels.get(row.kernel).version === row.kernel_version) continue;
    await rt.projections.rebuildStream(pool, rt.registry, giveawayStream(row.id), rt.reducer);
    rebuilt.push(row.id);
  }
  return rebuilt;
}
