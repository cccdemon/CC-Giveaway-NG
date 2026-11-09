import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveClient, defaultBackoff, type LiveEvent } from './ws.js';

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 } as CloseEvent);
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  message(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent);
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

describe('live client', () => {
  const sockets: FakeSocket[] = [];
  const makeSocket = (url: string) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s as unknown as WebSocket;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('sends subscribe after open, re-sends all subscriptions after reconnect with backoff', () => {
    const events: LiveEvent[] = [];
    const client = createLiveClient({ url: 'ws://x/api/ws', makeSocket, onEvent: (e) => events.push(e), onNoSession: () => undefined });
    const off = client.subscribe(['giveaway:a']);
    client.subscribe(['giveaway:a', 'team:b']);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toEqual([]);
    sockets[0]!.open();
    expect(get(client.state)).toBe('connected');
    expect(sockets[0]!.sent.map((s) => JSON.parse(s))).toEqual([{ subscribe: ['giveaway:a', 'team:b'] }]);
    off();
    expect(sockets[0]!.sent).toHaveLength(1); // giveaway:a hat noch einen Abonnenten
    sockets[0]!.drop(1012);
    expect(get(client.state)).toBe('reconnecting');
    vi.advanceTimersByTime(defaultBackoff(0) - 1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.drop(1006);
    vi.advanceTimersByTime(defaultBackoff(1));
    expect(sockets).toHaveLength(3);
    sockets[2]!.open();
    expect(sockets[2]!.sent.map((s) => JSON.parse(s))).toEqual([{ subscribe: ['giveaway:a', 'team:b'] }]);
    expect(defaultBackoff(10)).toBe(30_000);
    client.close();
    expect(get(client.state)).toBe('off');
  });

  it('close code 4401 calls onNoSession and does not reconnect', () => {
    const onNoSession = vi.fn();
    const client = createLiveClient({ url: 'ws://x/api/ws', makeSocket, onEvent: () => undefined, onNoSession });
    sockets[0]!.open();
    sockets[0]!.drop(4401);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(onNoSession).toHaveBeenCalledTimes(1);
    expect(get(client.state)).toBe('off');
  });

  it('event messages reach onEvent, error and unknown messages do not throw, unsubscribe is sent when the last subscriber leaves', () => {
    const events: LiveEvent[] = [];
    const client = createLiveClient({ url: 'ws://x/api/ws', makeSocket, onEvent: (e) => events.push(e), onNoSession: () => undefined });
    const off = client.subscribe(['giveaway:a']);
    sockets[0]!.open();
    sockets[0]!.message({ event: { stream: 'giveaway:a', seq: 7, type: 'participant_registered', id: 'e1', at: '2026-10-15T12:00:00.000Z' } });
    sockets[0]!.message({ error: { code: 'not_allowed', message: 'Nein.', stream: 'team:x' } });
    sockets[0]!.message('kein json');
    sockets[0]!.message({ subscribed: ['giveaway:a'] });
    expect(events).toEqual([{ stream: 'giveaway:a', seq: 7, type: 'participant_registered', id: 'e1', at: '2026-10-15T12:00:00.000Z' }]);
    off();
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({ unsubscribe: ['giveaway:a'] });
  });
});
