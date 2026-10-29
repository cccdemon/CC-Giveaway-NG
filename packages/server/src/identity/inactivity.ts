// Löschfrist für inaktive Konten (NEW_DESIGN.md 12.4): 12 Monate ohne Anmeldung → Zuordnung entfernt.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Runtime } from '../framework/runtime.js';
import type { AccountHandlers } from './runtime.js';

export const INACTIVE_DAYS = 365;

/**
 * Löscht jedes Konto, dessen last_seen_at älter als INACTIVE_DAYS ist, als Befehl mit Akteur system:scheduler.
 * Eine Ablehnung oder ein Fehler zählt als failed, der Lauf geht weiter. Wiederholen ist sicher: Gelöschte haben keine Zeile mehr.
 */
export async function purgeInactiveAccounts(
  pool: pg.Pool,
  rt: Runtime,
  accounts: AccountHandlers,
  now: Date,
): Promise<{ deleted: string[]; failed: number }> {
  const cutoff = new Date(now.getTime() - INACTIVE_DAYS * 86_400_000);
  const r = await pool.query<{ pid: string }>('SELECT pid FROM identities WHERE last_seen_at < $1 ORDER BY last_seen_at', [cutoff]);
  const deleted: string[] = [];
  let failed = 0;
  for (const { pid } of r.rows) {
    try {
      const res = await rt.bus.execute(accounts.deleteAccount, { pid }, { actor: 'system:scheduler', correlationId: randomUUID(), now });
      if (res.ok) deleted.push(pid);
      else failed++;
    } catch {
      failed++;
    }
  }
  return { deleted, failed };
}
