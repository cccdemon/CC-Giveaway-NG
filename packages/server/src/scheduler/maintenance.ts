import type pg from 'pg';
import { purgeIps } from '../audit/access-log.js';
import type { Runtime } from '../framework/runtime.js';
import { purgeInactiveAccounts } from '../identity/inactivity.js';
import type { AccountHandlers } from '../identity/runtime.js';
import { purgeExpiredSessions } from '../identity/sessions.js';
import { ensurePartitions } from '../journal/partitions.js';

export interface MaintenanceResult {
  partitions: string[];
  ipsPurged: number;
  sessionsPurged: number;
  accountsPurged: number;
}

/** Stündliche Wartung. Ohne Runtime bleiben inaktive Konten unberührt (Tests des Fundaments). */
export async function runMaintenance(pool: pg.Pool, now: Date, o?: { rt: Runtime; accounts: AccountHandlers }): Promise<MaintenanceResult> {
  const partitions = await ensurePartitions(pool, now, 2);
  const ipsPurged = await purgeIps(pool, now);
  const sessionsPurged = await purgeExpiredSessions(pool, now);
  const accountsPurged = o ? (await purgeInactiveAccounts(pool, o.rt, o.accounts, now)).deleted.length : 0;
  return { partitions, ipsPurged, sessionsPurged, accountsPurged };
}
