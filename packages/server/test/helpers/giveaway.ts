import type pg from 'pg';
import { vi } from 'vitest';
import type { CommandContext, CommandHandler, CommandResult } from '../../src/framework/command-bus.js';
import type { GiveawayState } from '../../src/framework/giveaway/state.js';
import { giveawayStream } from '../../src/framework/giveaway/state.js';
import { allowAll } from '../../src/framework/giveaway/authorize.js';
import type { CreateGiveawayCmd } from '../../src/framework/giveaway/lifecycle.js';
import { loadStreamState } from '../../src/framework/state.js';
import { InMemoryPublisher, type Publisher } from '../../src/framework/publisher.js';
import { createRuntime, type Runtime, type RuntimeOptions } from '../../src/framework/runtime.js';
import type { Pid } from '../../src/kernel-api/index.js';
import type { EventRecord } from '../../src/journal/types.js';
import { AT, freshDb } from './db.js';
import { ctx } from './fixtures.js';

export const TEAM = '55555555-5555-4555-8555-555555555555';
export const GID = '66666666-6666-4666-8666-666666666666';
export const GID2 = '66666666-6666-4666-8666-666666666667';
export const GID3 = '66666666-6666-4666-8666-666666666668';
export const GID4 = '66666666-6666-4666-8666-666666666669';
export const P1 = '77777777-7777-4777-8777-777777777777', P2 = '88888888-8888-4888-8888-888888888888', P3 = '99999999-9999-4999-8999-999999999999';
export const STREAMER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const userOf = (pid: Pid) => `user:${pid}`;

const pools = new WeakMap<Runtime, pg.Pool>();

export async function setupGiveaway(
  over: Partial<Omit<RuntimeOptions, 'pool' | 'publisher' | 'log'>> & { publisher?: Publisher } = {},
): Promise<{ pool: pg.Pool; rt: Runtime; publisher: InMemoryPublisher | Publisher; close(): Promise<void> }> {
  const db = await freshDb();
  const publisher = over.publisher ?? new InMemoryPublisher();
  const rt = createRuntime({ auth: allowAll, log: { error: vi.fn() }, ...over, pool: db.pool, publisher });
  pools.set(rt, db.pool);
  return { pool: db.pool, rt, publisher, close: db.close };
}

export async function run<C, S, P>(rt: Runtime, h: CommandHandler<C, S, P>, cmd: C, over: Partial<CommandContext> = {}): Promise<CommandResult> {
  return rt.bus.execute(h, cmd, ctx({ actor: STREAMER, ...over }));
}

export async function must<C, S, P>(rt: Runtime, h: CommandHandler<C, S, P>, cmd: C, over: Partial<CommandContext> = {}): Promise<EventRecord[]> {
  const r = await run(rt, h, cmd, over);
  if (!r.ok) throw new Error(`${h.type} abgelehnt: ${r.rejection.code}: ${r.rejection.message}`);
  return r.events;
}

export async function createOpen(rt: Runtime, over: Partial<CreateGiveawayCmd> = {}): Promise<void> {
  const cmd: CreateGiveawayCmd = { giveawayId: GID, teamId: TEAM, kernelId: 'instant', settings: { prize: 'Key', channels: [P1] }, ...over };
  await must(rt, rt.handlers.create, cmd);
  await must(rt, rt.handlers.open, { giveawayId: cmd.giveawayId });
}

export async function state(rt: Runtime, giveawayId: string = GID): Promise<GiveawayState> {
  const pool = pools.get(rt);
  if (!pool) throw new Error('Runtime stammt nicht aus setupGiveaway.');
  const c = await pool.connect();
  try {
    return await loadStreamState(c, rt.registry, giveawayStream(giveawayId), rt.reducer);
  } finally {
    c.release();
  }
}

export const at = (offsetSec: number) => new Date(AT.getTime() + offsetSec * 1000);
