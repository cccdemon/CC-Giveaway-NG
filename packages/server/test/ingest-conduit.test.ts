import { describe, expect, it, vi } from 'vitest';
import type { ChannelRef } from '../src/ingest/signals.js';
import { ensureConduit, subscribeChannel } from '../src/ingest/twitch/conduit.js';
import type { Conduit, HelixClient } from '../src/ingest/twitch/helix.js';

const P1 = '77777777-7777-4777-8777-777777777777';

function fakeHelix(list: () => Conduit[]) {
  const h = {
    listConduits: vi.fn(async () => list()),
    createConduit: vi.fn(async (shardCount: number) => ({ id: 'neu', shardCount })),
    updateConduit: vi.fn(async () => {}),
    bindShard: vi.fn(async () => {}),
    subscribe: vi.fn<HelixClient['subscribe']>(async () => 'created'),
    getStreams: vi.fn(async () => []),
    getChatters: vi.fn(async () => []),
    isFollower: vi.fn(async () => ({ userId: '', follows: false, since: null })),
    sendChatMessage: vi.fn(async () => ({ ok: true as const, messageId: 'x' })),
  };
  return h as typeof h & HelixClient;
}

const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});

describe('ensureConduit', () => {
  it('worker 0 creates a conduit when none exists and resizes a wrong one', async () => {
    const empty = fakeHelix(() => []);
    expect(await ensureConduit(empty, { workers: 2, index: 0, sleep })).toBe('neu');
    expect(empty.createConduit).toHaveBeenCalledWith(2);
    const wrong = fakeHelix(() => [{ id: 'alt', shardCount: 1 }]);
    expect(await ensureConduit(wrong, { workers: 3, index: 0, sleep })).toBe('alt');
    expect(wrong.updateConduit).toHaveBeenCalledWith('alt', 3);
    expect(wrong.createConduit).not.toHaveBeenCalled();
    const right = fakeHelix(() => [{ id: 'ok', shardCount: 2 }]);
    expect(await ensureConduit(right, { workers: 2, index: 0, sleep })).toBe('ok');
    expect(right.updateConduit).not.toHaveBeenCalled();
  });

  it('worker 1 waits for a conduit and gives up after attempts', async () => {
    let calls = 0;
    const late = fakeHelix(() => (++calls < 3 ? [] : [{ id: 'da', shardCount: 2 }]));
    const s = vi.fn<(ms: number) => Promise<void>>(async () => {});
    expect(await ensureConduit(late, { workers: 2, index: 1, sleep: s })).toBe('da');
    expect(s.mock.calls.map((c) => c[0])).toEqual([2000, 2000]);
    expect(late.createConduit).not.toHaveBeenCalled();
    const small = fakeHelix(() => [{ id: 'klein', shardCount: 1 }]);
    await expect(ensureConduit(small, { workers: 2, index: 1, sleep: s, attempts: 2 })).rejects.toThrow('Kein Conduit. Starte Worker 0 zuerst.');
  });
});

describe('subscribeChannel', () => {
  const ref = (watch: 'state' | 'full'): ChannelRef => ({ pid: P1, twitchId: '1001', watch, owned: true });

  it('subscribes state channels to online/offline and full channels additionally to chat and follow', async () => {
    const h = fakeHelix(() => []);
    await subscribeChannel(h, 'cid', ref('state'), '999');
    expect(h.subscribe.mock.calls).toEqual([
      ['stream.online', '1', { broadcaster_user_id: '1001' }, 'cid'],
      ['stream.offline', '1', { broadcaster_user_id: '1001' }, 'cid'],
    ]);
    h.subscribe.mockClear();
    h.subscribe.mockResolvedValue('exists');
    await subscribeChannel(h, 'cid', ref('full'), '999');
    expect(h.subscribe.mock.calls).toEqual([
      ['stream.online', '1', { broadcaster_user_id: '1001' }, 'cid'],
      ['stream.offline', '1', { broadcaster_user_id: '1001' }, 'cid'],
      ['channel.chat.message', '1', { broadcaster_user_id: '1001', user_id: '999' }, 'cid'],
      ['channel.follow', '2', { broadcaster_user_id: '1001', moderator_user_id: '1001' }, 'cid'],
    ]);
  });
});
