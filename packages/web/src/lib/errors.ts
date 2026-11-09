// Browser-Fehler an den Server melden (NEW_DESIGN.md 11.4, 12.4): ohne Personenbezug, ohne Cookie, höchstens zehn je Seite.
import type { HandleClientError } from '@sveltejs/kit/hooks';
import { S } from './texts/sentences.js';

export const MAX_REPORTS_PER_PAGE = 10;

export type ErrorReporter = (error: unknown, url: string) => Promise<void>;

function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: `${error.name}: ${error.message}`, ...(error.stack ? { stack: error.stack } : {}) };
  return { message: typeof error === 'string' ? error : JSON.stringify(error) };
}

export function createErrorReporter(fetchFn: typeof fetch): ErrorReporter {
  let sent = 0;
  return async (error, url) => {
    if (sent >= MAX_REPORTS_PER_PAGE) return;
    sent += 1;
    try {
      await fetchFn('/api/errors', {
        method: 'POST',
        credentials: 'omit',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...describe(error), url }),
      });
    } catch {
      // Der Bericht ist Beiwerk. Ein Fehler beim Melden bleibt still.
    }
  };
}

/**
 * handleError für hooks.client.ts: nur unbekannte Fehler (echte Ausnahmen) gehen an den Betreiber.
 * Erwartete Fehler (error(403, …)) und 404 des Rahmens behalten ihre Meldung und sind kein Browser-Fehler.
 */
export function makeHandleError(report: ErrorReporter): HandleClientError {
  return (input) => {
    // Erwartete Fehler und 404 behalten die Behandlung von SvelteKit (ihre Meldung bleibt).
    if (input.kind !== 'unknown') return undefined;
    void report(input.error, input.event.url.href);
    return { message: S.serverError };
  };
}
