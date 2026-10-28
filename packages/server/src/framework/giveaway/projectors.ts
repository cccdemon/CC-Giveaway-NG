// Lesetabellen des Stroms giveaway:<id>. Sie entstehen aus dem Zustand nach jedem Befehl.
import type pg from 'pg';
import type { StreamId } from '../../journal/types.js';
import type { KernelRegistry } from '../kernel-registry.js';
import { UUID_RE } from './authorize.js';
import type { StateProjector } from '../projections.js';
import type { GiveawayState } from './state.js';

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
