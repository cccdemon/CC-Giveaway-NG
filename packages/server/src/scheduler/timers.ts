import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { BusLogger } from '../framework/command-bus.js';
import type { Runtime } from '../framework/runtime.js';
import type { KernelCommand } from '../kernel-api/index.js';

export const TIMER_INTERVAL_MS = 5_000;
export const TIMER_BATCH = 100;

const STREAM_PREFIX = 'giveaway:';

/**
 * Fällige timers (due_at <= now, ORDER BY due_at, LIMIT batch) als kernel_command mit Akteur system:scheduler.
 * Abgelehnte oder fehlende Ziele: Zeile löschen (Spiegel, kein Zustand) und zählen.
 * Wirft ein Befehl, zählt `failed`, die Zeile bleibt, der Lauf geht weiter.
 */
export async function runDueTimers(
  pool: pg.Pool,
  rt: Runtime,
  now: Date,
  log: BusLogger,
  batch = TIMER_BATCH,
): Promise<{ ran: number; rejected: number; failed: number }> {
  // due_at als Text: volle Mikrosekunden-Genauigkeit für den Vergleich beim Löschen.
  const due = await pool.query<{ stream: string; key: string; command: KernelCommand; due_at: string }>(
    'SELECT stream, key, command, due_at::text AS due_at FROM timers WHERE due_at <= $1 ORDER BY due_at LIMIT $2',
    [now, batch],
  );
  let ran = 0, rejected = 0, failed = 0;
  // Die Tabelle timers ist nur ein Spiegel der Kern-Zeitgeber, kein Zustand. Eine Zeile zu löschen verliert nichts:
  // Der timersProjector schreibt sie beim nächsten Ereignis des Stroms neu, solange der Kern sie noch will.
  // Gelöscht wird nur die gelesene Fassung: Hat ein anderer Befehl die Zeile inzwischen neu geschrieben, bleibt sie.
  const dropRow = (r: { stream: string; key: string; due_at: string }) =>
    pool.query('DELETE FROM timers WHERE stream = $1 AND key = $2 AND due_at = $3::timestamptz', [r.stream, r.key, r.due_at]);
  for (const row of due.rows) {
    const giveawayId = row.stream.startsWith(STREAM_PREFIX) ? row.stream.slice(STREAM_PREFIX.length) : row.stream;
    try {
      const r = await rt.bus.execute(
        rt.handlers.kernelCommand,
        { giveawayId, command: row.command },
        { actor: 'system:scheduler', correlationId: randomUUID(), now },
      );
      // Gezählt wird erst nach dem Löschen. Wirft das Löschen, zählt der Lauf nur als failed.
      if (r.ok) {
        // Ohne Ereignis läuft kein Projektor. Bleibt die Zeile, ist sie veraltet.
        if (r.events.length === 0) await dropRow(row);
        ran++;
      } else {
        await dropRow(row);
        rejected++;
      }
    } catch (e) {
      failed++;
      log.error({ err: e, stream: row.stream, key: row.key }, 'Ein fälliger Zeitgeber ist fehlgeschlagen. Der nächste Lauf versucht es erneut.');
    }
  }
  return { ran, rejected, failed };
}
