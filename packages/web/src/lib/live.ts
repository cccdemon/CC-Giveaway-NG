// Verdrahtung des Live-Clients im Browser: je Ereignis lädt die Seite die Daten des Stroms neu (depends('api:stream:<stream>')).
import { goto, invalidate } from '$app/navigation';
import { writable } from 'svelte/store';
import { createLiveClient, type LiveClient, type LiveState } from './ws.js';

export const liveState = writable<LiveState>('off');
export const streamDependency = (stream: string): string => `api:stream:${stream}`;

let client: LiveClient | null = null;

function wsUrl(): string {
  const { protocol, host } = globalThis.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/api/ws`;
}

export function liveClient(): LiveClient {
  if (!client) {
    client = createLiveClient({
      url: wsUrl(),
      makeSocket: (url) => new WebSocket(url),
      onEvent: (e) => {
        void invalidate(streamDependency(e.stream));
      },
      onNoSession: () => {
        liveState.set('off');
        void goto('/');
      },
    });
    client.state.subscribe((s) => liveState.set(s));
  }
  return client;
}

/** Für $effect in Seiten: abonniert, solange die Seite lebt. */
export function watchStreams(streams: string[]): () => void {
  if (streams.length === 0) return () => undefined;
  return liveClient().subscribe(streams);
}

export function stopLive(): void {
  client?.close();
  client = null;
  liveState.set('off');
}
