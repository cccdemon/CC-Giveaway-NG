// Live-Push-Client (NEW_DESIGN.md 3.3 Schritt 5, 12.1): abonniert Ströme, meldet je Ereignis, verbindet mit Backoff neu.
// Rein gegen eine WebSocket-Fabrik, damit Tests ohne Netz laufen. Nachrichten tragen keine Payloads.
import { writable, type Readable } from 'svelte/store';

export type LiveState = 'connected' | 'reconnecting' | 'off';

export interface LiveEvent {
  stream: string;
  seq: number;
  type: string;
  id: string;
  at: string;
}

export interface LiveClient {
  /** Abonniert Ströme (gezählt). Die Rückgabe gibt sie wieder frei. */
  subscribe(streams: string[]): () => void;
  state: Readable<LiveState>;
  close(): void;
}

export interface LiveOptions {
  url: string;
  makeSocket: (url: string) => WebSocket;
  onEvent: (e: LiveEvent) => void;
  /** Code 4401: keine Sitzung. Kein Wiederverbinden. */
  onNoSession: () => void;
  backoffMs?: (attempt: number) => number;
}

export const CLOSE_NO_SESSION = 4401;
export const defaultBackoff = (attempt: number): number => Math.min(30_000, 1000 * 2 ** attempt);

export function createLiveClient(o: LiveOptions): LiveClient {
  const backoff = o.backoffMs ?? defaultBackoff;
  const state = writable<LiveState>('reconnecting');
  const counts = new Map<string, number>();
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const send = (m: unknown) => {
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
  };

  const connect = () => {
    const s = o.makeSocket(o.url);
    socket = s;
    s.onopen = () => {
      attempt = 0;
      state.set('connected');
      if (counts.size > 0) send({ subscribe: [...counts.keys()] });
    };
    s.onmessage = (ev) => {
      let m: unknown;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const e = (m as { event?: LiveEvent } | null)?.event;
      if (e && typeof e.stream === 'string') o.onEvent(e);
    };
    s.onerror = () => {
      // close folgt immer, dort entscheidet sich das Weitere.
    };
    s.onclose = (ev) => {
      if (socket !== s) return;
      socket = null;
      if (closed) return;
      if (ev.code === CLOSE_NO_SESSION) {
        closed = true;
        state.set('off');
        o.onNoSession();
        return;
      }
      state.set('reconnecting');
      timer = setTimeout(connect, backoff(attempt++));
    };
  };
  connect();

  return {
    state: { subscribe: state.subscribe },
    subscribe(streams) {
      const fresh: string[] = [];
      for (const st of streams) {
        const n = (counts.get(st) ?? 0) + 1;
        counts.set(st, n);
        if (n === 1) fresh.push(st);
      }
      if (fresh.length > 0) send({ subscribe: fresh });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const gone: string[] = [];
        for (const st of streams) {
          const n = (counts.get(st) ?? 1) - 1;
          if (n <= 0) {
            counts.delete(st);
            gone.push(st);
          } else counts.set(st, n);
        }
        if (gone.length > 0) send({ unsubscribe: gone });
      };
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      const s = socket;
      socket = null;
      s?.close();
      state.set('off');
    },
  };
}
