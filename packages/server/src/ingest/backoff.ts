// Wiederholung mit Backoff für Twitch-Aufrufe (NEW_DESIGN.md 12.1): 1 s, 2 s, 4 s, dann Fehler.

export const BACKOFF_ATTEMPTS = 3;
export const BACKOFF_BASE_MS = 1_000;

export interface BackoffOptions {
  attempts?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  retryOn?: (e: unknown) => boolean;
  /** Eigene Wartezeit für einen Fehler, z. B. Ratelimit-Reset. undefined = Backoff. */
  delayMs?: (e: unknown, attempt: number) => number | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withBackoff<T>(fn: (attempt: number) => Promise<T>, o: BackoffOptions = {}): Promise<T> {
  const attempts = o.attempts ?? BACKOFF_ATTEMPTS;
  const baseMs = o.baseMs ?? BACKOFF_BASE_MS;
  const sleep = o.sleep ?? defaultSleep;
  const retryOn = o.retryOn ?? (() => true);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt + 1 >= attempts || !retryOn(e)) throw e;
      await sleep(o.delayMs?.(e, attempt) ?? baseMs * 2 ** attempt);
    }
  }
}
