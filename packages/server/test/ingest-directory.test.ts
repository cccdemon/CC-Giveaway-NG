import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachAccounts } from '../src/identity/runtime.js';
import { markTokenInvalid } from '../src/identity/tokens.js';
import { REQUIRED_CHANNEL_SCOPES } from '../src/identity/twitch.js';
import { Directory, pgChannelSource, type ChannelSource } from '../src/ingest/directory.js';
import { allAdmins } from '../src/platform/admin.js';
import { attachPlatform } from '../src/platform/runtime.js';
import { shardOf } from '../src/ingest/shard.js';
import type { ChannelRef, IngestAdapter } from '../src/ingest/signals.js';
import { AT } from './helpers/db.js';
import { GID, P1, P2, P3, createOpen, must, setupGiveaway } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const KEY = randomBytes(32);
const SOLO = '55555555-5555-4555-8555-555555555555';
const token = { accessToken: 'acc', refreshToken: 'ref', expiresIn: 3600, scopes: [...REQUIRED_CHANNEL_SCOPES] };

function fakeAdapter(): IngestAdapter & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onSignal: () => {},
    sendChat: async () => ({ ok: true, messageId: 'x' }),
    checkFollows: async () => [],
    health: () => [],
    close: async () => {},
  };
}

describe('pgChannelSource', () => {
  it('lists connected channels with a valid token, watch full only with an open giveaway', async () => {
    const s = await setupGiveaway();
    close = s.close;
    const accounts = attachAccounts(s.rt, { tokenKey: KEY });
    const connect = async (pid: string, twitchId: string, login: string) => {
      await must(s.rt, accounts.signIn, { pid, soloTeamId: SOLO.replace('5555-4', `${twitchId}-4`), user: { id: twitchId, login, displayName: login } }, { actor: 'system:twitch' });
      await must(s.rt, accounts.connectChannel, { pid, twitchId, token }, { actor: `user:${pid}` });
    };
    await connect(P1, '1001', 'alice');
    await connect(P2, '1002', 'bob');
    await connect(P3, '1003', 'carol');
    await markTokenInvalid(s.pool, P3, AT);
    await createOpen(s.rt, { settings: { prize: 'Key', channels: [P1] } });
    const source = pgChannelSource(s.pool);
    expect(await source.list()).toEqual([
      { pid: P1, twitchId: '1001', watch: 'full' },
      { pid: P2, twitchId: '1002', watch: 'state' },
    ]);
    await must(s.rt, s.rt.handlers.pause, { giveawayId: GID });
    expect((await source.list()).map((x) => x.watch)).toEqual(['state', 'state']);
    await must(s.rt, accounts.disconnectChannel, { pid: P2 }, { actor: `user:${P2}` });
    expect((await source.list()).map((x) => x.pid)).toEqual([P1]);
  });
});

describe('Directory', () => {
  const log = { error: vi.fn() };
  const ref = (pid: string, watch: 'state' | 'full' = 'full', twitchId = 't'): { pid: string; twitchId: string; watch: 'state' | 'full' } => ({ pid, twitchId, watch });

  it('starts new refs, restarts changed ones and stops removed ones, only owned ones poll', async () => {
    let list = [ref(P1), ref(P2, 'state'), ref(P3)];
    const source: ChannelSource = { list: async () => list };
    const adapter = fakeAdapter();
    const d = new Directory({ source, adapter, workers: 2, index: 0, log });
    expect(await d.refresh()).toEqual({ started: 3, stopped: 0 });
    const started = adapter.start.mock.calls[0]![0] as ChannelRef[];
    expect(started.map((r) => r.owned)).toEqual([P1, P2, P3].map((p) => shardOf(p, 2) === 0));
    expect(d.byTwitchId('t')?.pid).toBe(P1);
    expect(await d.refresh()).toEqual({ started: 0, stopped: 0 });
    expect(adapter.start).toHaveBeenCalledOnce();
    list = [ref(P1, 'state'), ref(P3, 'full', 't3')];
    expect(await d.refresh()).toEqual({ started: 2, stopped: 1 });
    expect((adapter.start.mock.calls[1]![0] as ChannelRef[]).map((r) => [r.pid, r.watch, r.twitchId])).toEqual([[P1, 'state', 't'], [P3, 'full', 't3']]);
    expect((adapter.stop.mock.calls[0]![0] as ChannelRef).pid).toBe(P2);
    expect(d.current().map((r) => r.pid)).toEqual([P1, P3]);
    expect(d.byTwitchId('t3')?.pid).toBe(P3);
  });

  it('a failing source keeps the last state and logs', async () => {
    let fail = false;
    const source: ChannelSource = { list: async () => { if (fail) throw new Error('db weg'); return [ref(P1)]; } };
    const adapter = fakeAdapter();
    const d = new Directory({ source, adapter, workers: 1, index: 0, log });
    await d.refresh();
    fail = true;
    expect(await d.refresh()).toEqual({ started: 0, stopped: 0 });
    expect(d.current()).toHaveLength(1);
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });
});

describe('pgChannelSource und Plattform-Sperre (Teilprojekt 8c)', () => {
  it('channel directory leaves out banned channels and lists them again after unban', async () => {
    const s = await setupGiveaway();
    close = s.close;
    const accounts = attachAccounts(s.rt, { tokenKey: KEY });
    const platform = attachPlatform(s.rt, { admins: allAdmins });
    const connect = async (pid: string, twitchId: string, login: string) => {
      await must(s.rt, accounts.signIn, { pid, soloTeamId: SOLO.replace('5555-4', `${twitchId}-4`), user: { id: twitchId, login, displayName: login } }, { actor: 'system:twitch' });
      await must(s.rt, accounts.connectChannel, { pid, twitchId, token }, { actor: `user:${pid}` });
    };
    await connect(P1, '1001', 'alice');
    await connect(P2, '1002', 'bob');
    const source = pgChannelSource(s.pool);
    expect((await source.list()).map((x) => x.pid)).toEqual([P1, P2]);
    await must(s.rt, platform.ban, { pid: P1, reason: 'Bot-Verhalten' }, { actor: `user:${P3}` });
    expect((await source.list()).map((x) => x.pid)).toEqual([P2]);
    await must(s.rt, platform.unban, { pid: P1, reason: 'Geklärt' }, { actor: `user:${P3}` });
    expect((await source.list()).map((x) => x.pid)).toEqual([P1, P2]);
  });
});
