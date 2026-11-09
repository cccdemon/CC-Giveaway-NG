import type pg from 'pg';
import { purgeIps } from '../audit/access-log.js';
import { purgeUnregisteredAll } from '../framework/giveaway/purge.js';
import type { Runtime } from '../framework/runtime.js';
import { purgeInactiveAccounts } from '../identity/inactivity.js';
import type { AccountHandlers } from '../identity/runtime.js';
import { purgeExpiredSessions } from '../identity/sessions.js';
import { ensurePartitions } from '../journal/partitions.js';
import { purgeBrowserErrors } from '../platform/ops.js';

export interface MaintenanceResult {
  partitions: string[];
  ipsPurged: number;
  sessionsPurged: number;
  accountsPurged: number;
  /** Giveaways, deren Unangemeldete gelöscht wurden (NEW_DESIGN.md 12.4). */
  unregisteredPurged: number;
  /** Browser-Fehler älter als 30 Tage (NEW_DESIGN.md 12.4). */
  browserErrorsPurged: number;
}

/** Stündliche Wartung. Ohne Runtime bleiben inaktive Konten unberührt (Tests des Fundaments). */
export async function runMaintenance(pool: pg.Pool, now: Date, o?: { rt: Runtime; accounts: AccountHandlers }): Promise<MaintenanceResult> {
  const partitions = await ensurePartitions(pool, now, 2);
  const ipsPurged = await purgeIps(pool, now);
  const sessionsPurged = await purgeExpiredSessions(pool, now);
  const accountsPurged = o ? (await purgeInactiveAccounts(pool, o.rt, o.accounts, now)).deleted.length : 0;
  const unregisteredPurged = o ? (await purgeUnregisteredAll(pool, o.rt, now)).purged : 0;
  const browserErrorsPurged = await purgeBrowserErrors(pool, now);
  return { partitions, ipsPurged, sessionsPurged, accountsPurged, unregisteredPurged, browserErrorsPurged };
}
