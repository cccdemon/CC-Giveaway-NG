// Kleine Einstellungen je Browser (Streamermodus, Darstellung) im localStorage. Ohne Storage (SSR, privates Fenster) bleibt der Default.
import { writable, type Writable } from 'svelte/store';

export function persisted<T>(key: string, fallback: T, parse: (raw: string) => T | null, serialize: (v: T) => string): Writable<T> {
  let initial = fallback;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw !== null && raw !== undefined) initial = parse(raw) ?? fallback;
  } catch {
    // kein Storage: Default
  }
  const store = writable<T>(initial);
  store.subscribe((v) => {
    try {
      globalThis.localStorage?.setItem(key, serialize(v));
    } catch {
      // kein Storage: nur im Speicher
    }
  });
  return store;
}
