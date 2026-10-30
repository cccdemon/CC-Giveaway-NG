import type { SocketLike } from '../../src/ingest/twitch/eventsub.js';

type Listener = (ev: { data?: unknown; code?: number; reason?: string }) => void;

/** Ersatz für den globalen WebSocket in Tests: Nachrichten werden per emit eingespeist. */
export class FakeSocket implements SocketLike {
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, ev: { data?: unknown; code?: number; reason?: string } = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}
