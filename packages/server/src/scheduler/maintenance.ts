import type pg from 'pg';
import { purgeIps } from '../audit/access-log.js';
import { ensurePartitions } from '../journal/partitions.js';

export async function runMaintenance(pool: pg.Pool, now: Date): Promise<{ partitions: string[]; ipsPurged: number }> {
  const partitions = await ensurePartitions(pool, now, 2);
  const ipsPurged = await purgeIps(pool, now);
  return { partitions, ipsPurged };
}
