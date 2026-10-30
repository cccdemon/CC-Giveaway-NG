import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/config.js';
import { readChannelStatus } from '../src/ingest/channel-status.js';
import { buildIngest } from '../src/ingest/build.js';
import { SimulatorAdapter } from '../src/ingest/simulator.js';
import { AT } from './helpers/db.js';
import { P1, setupGiveaway } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5433/ccg',
  REDIS_URL: 'redis://localhost:6380',
  TWITCH_CLIENT_ID: 'cid',
  TWITCH_CLIENT_SECRET: 'csecret',
  PUBLIC_URL: 'https://giveaway.example.org',
  TOKEN_KEY_FILE: './secrets/token.key',
};

describe('buildIngest', () => {
  it('with simulator wires sim.tick and needs no bot id', async () => {
    const s = await setupGiveaway();
    close = s.close;
    const config = loadConfig({ ...ENV, INGEST_ADAPTER: 'simulator', INGEST_SIM_VIEWERS: '4' });
    const { worker, adapter } = buildIngest(config, { pool: s.pool, rt: s.rt, tokenKey: randomBytes(32), log: { error: vi.fn() }, now: () => AT });
    expect(adapter).toBeInstanceOf(SimulatorAdapter);
    await adapter.start([{ pid: P1, twitchId: '1', watch: 'full', owned: true }]);
    await worker.tick(AT);
    const row = (await readChannelStatus(s.pool, [P1])).get(P1);
    expect(row).toMatchObject({ live: true, viewers: 4, chatters: expect.any(Number), lastPresenceAt: AT });
    await worker.stop();
  });

  it('with twitch and empty TWITCH_BOT_USER_ID throws a ConfigError naming the variable', async () => {
    const s = await setupGiveaway();
    close = s.close;
    const config = loadConfig({ ...ENV, INGEST_ADAPTER: 'twitch' });
    let err: unknown;
    try {
      buildIngest(config, { pool: s.pool, rt: s.rt, tokenKey: randomBytes(32), log: { error: vi.fn() } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems.join('\n')).toMatch(/TWITCH_BOT_USER_ID: Pflichtwert fehlt, wenn INGEST_ADAPTER=twitch/);
  });

  it('with twitch and a bot id builds a twitch adapter without touching the network', async () => {
    const s = await setupGiveaway();
    close = s.close;
    const config = loadConfig({ ...ENV, INGEST_ADAPTER: 'twitch', TWITCH_BOT_USER_ID: '999' });
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response('{}', { status: 500 }));
    const { adapter } = buildIngest(config, { pool: s.pool, rt: s.rt, tokenKey: randomBytes(32), log: { error: vi.fn() }, fetch: fetchSpy });
    expect(adapter).not.toBeInstanceOf(SimulatorAdapter);
    expect(adapter.health()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
