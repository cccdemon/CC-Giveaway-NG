// Löschfrist für inaktive Konten (NEW_DESIGN.md 12.4): 12 Monate ohne Anmeldung → Zuordnung entfernt.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Runtime } from '../framework/runtime.js';
import type { AccountHandlers } from './runtime.js';

export const INACTIVE_DAYS = 365;

/**
 * Löscht jedes Konto, dessen last_seen_at älter als INACTIVE_DAYS ist, als Befehl mit Akteur system:scheduler.
 * In einem Team oder auf der Plattform Gesperrte bleiben: Ihre Signale werden verworfen, darum altert last_seen_at, und ohne
 * Zuordnung käme die Person mit neuer pid zurück (NEW_DESIGN.md 15.3, 11.4). Eine Ablehnung oder ein Fehler zählt als failed, der Lauf geht weiter.
 */
export async function purgeInactiveAccounts(
  pool: pg.Pool,
  rt: Runtime,
  accounts: AccountHandlers,
  now: Date,
): Promise<{ deleted: string[]; failed: number }> {
  const cutoff = new Date(now.getTime() - INACTIVE_DAYS * 86_400_000);
  const r = await pool.query<{ pid: string }>(
    `SELECT pid FROM identities i WHERE last_seen_at < $1
        AND NOT EXISTS (SELECT 1 FROM team_bans b WHERE b.pid = i.pid)
        AND NOT EXISTS (SELECT 1 FROM platform_bans p WHERE p.pid = i.pid)
      ORDER BY last_seen_at`,
    [cutoff],
  );
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
