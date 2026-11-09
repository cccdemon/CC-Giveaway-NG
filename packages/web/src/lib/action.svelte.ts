// Ein Befehl aus der Oberfläche: läuft, zeigt die Ablehnung des Servers als Text am Knopf, lädt danach neu (NEW_DESIGN.md 12.1).
import { ApiError, apiOf, type Api } from './api/client.js';
import { S } from './texts/sentences.js';

export class Action {
  busy = $state(false);
  error = $state<string | null>(null);
  done = $state(false);
  readonly api: Api = apiOf((...args) => globalThis.fetch(...args));

  /** Führt fn aus. Bei Erfolg after (z. B. invalidate), bei Ablehnung steht der Text in error. Liefert undefined bei Fehler. */
  async run<T>(fn: (api: Api) => Promise<T>, after?: (result: T) => Promise<unknown> | unknown): Promise<T | undefined> {
    this.busy = true;
    this.error = null;
    this.done = false;
    try {
      const result = await fn(this.api);
      await after?.(result);
      this.done = true;
      return result;
    } catch (e) {
      this.error = e instanceof ApiError ? e.message : S.serverError;
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  reset(): void {
    this.error = null;
    this.done = false;
  }
}
