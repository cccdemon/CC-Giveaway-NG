import { afterEach, describe, expect, it } from 'vitest';
import { denyUsers } from '../src/framework/giveaway/authorize.js';
import { GIVEAWAY_EVENTS, giveawayStream } from '../src/framework/giveaway/state.js';
import type { CommandResult } from '../src/framework/command-bus.js';
import { readStream } from '../src/journal/journal.js';
import { GID, GID2, GID3, GID4, P1, STREAMER, TEAM, at, createOpen, must, run, setupGiveaway, state } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

async function setup(over: Parameters<typeof setupGiveaway>[0] = {}) {
  const s = await setupGiveaway(over);
  close = s.close;
  return s;
}

const createCmd = (over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) => ({
  giveawayId: GID,
  teamId: TEAM,
  kernelId: 'instant',
  settings: { prize: 'Key', channels: [P1], ...settings },
  ...over,
});

async function code(p: Promise<CommandResult>): Promise<string> {
  const r = await p;
  return r.ok ? 'ok' : r.rejection.code;
}

describe('Lebenszyklus', () => {
  it('create writes giveaway_created with defaults and projects the row', async () => {
    const { pool, rt } = await setup();
    const events = await must(rt, rt.handlers.create, createCmd());
    expect(events.map((e) => e.type)).toEqual([GIVEAWAY_EVENTS.created]);
    expect(events[0]!.payload).toEqual({
      teamId: TEAM,
      kernelId: 'instant',
      kernelVersion: 1,
      settings: { config: { windowSec: 120 }, prize: 'Key', sponsor: null, channels: [P1], winnersCount: 1, claimDays: 14, gates: [], legal: null },
    });
    const row = (await pool.query('SELECT * FROM giveaways WHERE id = $1', [GID])).rows[0];
    expect(row).toMatchObject({
      id: GID, status: 'draft', team_id: TEAM, kernel: 'instant', kernel_version: 1, claim_days: 14, winners_count: 1,
      prize: 'Key', sponsor: null, config: { windowSec: 120 }, channels: [P1], gates: [],
      registered_count: 0, pool_size: 0, pool_weight: 0, last_seq: 1,
    });
  });

  it('create rejects: duplicate, unknown kernel, bad config, no prize, no channel, bad counts, unsupported gate', async () => {
    const { pool, rt } = await setup();
    await must(rt, rt.handlers.create, createCmd());
    const c = (cmd: ReturnType<typeof createCmd>) => code(run(rt, rt.handlers.create, cmd));
    expect(await c(createCmd())).toBe('already_exists');
    expect(await c(createCmd({ giveawayId: GID2, kernelId: 'nope' }))).toBe('unknown_kernel');
    expect(await c(createCmd({ giveawayId: GID2 }, { config: { windowSec: 5 } }))).toBe('invalid_config');
    expect(await c(createCmd({ giveawayId: GID2 }, { prize: '  ' }))).toBe('prize_required');
    expect(await c(createCmd({ giveawayId: GID2 }, { channels: [] }))).toBe('channels_required');
    expect(await c(createCmd({ giveawayId: GID2 }, { winnersCount: 0 }))).toBe('invalid_winners_count');
    expect(await c(createCmd({ giveawayId: GID2 }, { claimDays: 91 }))).toBe('invalid_claim_days');
    const gate = await run(rt, rt.handlers.create, createCmd({ giveawayId: GID2 }, { gates: [{ id: 'presence' }] }));
    expect(gate).toEqual({ ok: false, rejection: { rejected: true, code: 'gate_unsupported', message: 'Die Bedingung presence gibt es für diesen Kern nicht.' } });
    const all = await pool.query('SELECT stream, type FROM events ORDER BY id');
    expect(all.rows).toEqual([{ stream: giveawayStream(GID), type: GIVEAWAY_EVENTS.created }]);
  });

  it('bad user input is rejected, not thrown', async () => {
    const { pool, rt } = await setup();
    const cases: [ReturnType<typeof createCmd>, string][] = [
      [createCmd({}, { prize: 'x'.repeat(201) }), 'prize_too_long'],
      [createCmd({}, { sponsor: 'x'.repeat(201) }), 'sponsor_too_long'],
      [createCmd({}, { channels: ['kanal_a'] }), 'invalid_channel'],
      [createCmd({}, { gates: [null] }), 'invalid_gate'],
      [createCmd({}, { gates: ['follow'] }), 'invalid_gate'],
      [createCmd({ giveawayId: 'kein-uuid' }), 'invalid_id'],
      [createCmd({ teamId: 'kein-uuid' }), 'invalid_id'],
    ];
    for (const [cmd, want] of cases) {
      const r = await run(rt, rt.handlers.create, cmd as never);
      expect(r.ok ? 'ok' : r.rejection.code).toBe(want);
    }
    await must(rt, rt.handlers.create, createCmd());
    const r = await run(rt, rt.handlers.changeSettings, { giveawayId: GID, settings: { prize: 'x'.repeat(201) } });
    expect(r.ok ? 'ok' : r.rejection.code).toBe('prize_too_long');
    expect((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(1);
  });

  it('created_at stays, updated_at and last_seq move', async () => {
    const { pool, rt } = await setup();
    await must(rt, rt.handlers.create, createCmd());
    await must(rt, rt.handlers.open, { giveawayId: GID }, { now: at(60) });
    const row = (await pool.query('SELECT created_at, updated_at, last_seq FROM giveaways WHERE id = $1', [GID])).rows[0];
    expect(row).toEqual({ created_at: at(0), updated_at: at(60), last_seq: 3 });
  });

  it('transitions follow the table', async () => {
    const { pool, rt } = await setup();
    const h = rt.handlers;
    const cmd = { giveawayId: GID };
    await must(rt, h.create, createCmd());
    expect(await code(run(rt, h.reopen, cmd))).toBe('invalid_transition');
    await must(rt, h.open, cmd);
    expect(await code(run(rt, h.resume, cmd))).toBe('invalid_transition');
    await must(rt, h.pause, cmd);
    await must(rt, h.resume, cmd);
    await must(rt, h.close, cmd);
    expect(await code(run(rt, h.pause, cmd))).toBe('invalid_transition');
    expect(await code(run(rt, h.complete, cmd))).toBe('invalid_transition');
    await must(rt, h.reopen, cmd);
    await must(rt, h.close, cmd);
    const events = await readStream(pool, rt.registry, giveawayStream(GID));
    expect(events.filter((e) => e.type === GIVEAWAY_EVENTS.statusChanged).map((e) => e.payload)).toEqual([
      { from: 'draft', to: 'open' },
      { from: 'open', to: 'paused' },
      { from: 'paused', to: 'open' },
      { from: 'open', to: 'closed' },
      { from: 'closed', to: 'open' },
      { from: 'open', to: 'closed' },
    ]);
    expect((await state(rt)).status).toBe('closed');
    expect((await pool.query('SELECT status, last_seq FROM giveaways WHERE id = $1', [GID])).rows[0]).toEqual({ status: 'closed', last_seq: 8 });
    const bad = await run(rt, h.pause, cmd);
    expect(bad).toEqual({ ok: false, rejection: { rejected: true, code: 'invalid_transition', message: 'Aus dem Zustand Geschlossen geht Pausieren nicht.' } });
  });

  it('cancel works from draft, open, paused and closed', async () => {
    const { pool, rt } = await setup();
    const h = rt.handlers;
    await must(rt, h.create, createCmd({ giveawayId: GID }));
    await createOpen(rt, { giveawayId: GID2 });
    await createOpen(rt, { giveawayId: GID3 });
    await must(rt, h.pause, { giveawayId: GID3 });
    await createOpen(rt, { giveawayId: GID4 });
    await must(rt, h.close, { giveawayId: GID4 });
    for (const id of [GID, GID2, GID3, GID4]) {
      await must(rt, h.cancel, { giveawayId: id });
      expect((await state(rt, id)).status).toBe('cancelled');
      expect(await code(run(rt, h.open, { giveawayId: id }))).toBe('invalid_transition');
    }
    const rows = await pool.query('SELECT status FROM giveaways ORDER BY id');
    expect(rows.rows.map((r) => r.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);
  });

  it('change_settings only before closing and is reversible', async () => {
    const { pool, rt } = await setup();
    const h = rt.handlers;
    await createOpen(rt);
    const [changed] = await must(rt, h.changeSettings, { giveawayId: GID, settings: { winnersCount: 2 } });
    expect(changed!.type).toBe(GIVEAWAY_EVENTS.settingsChanged);
    const p = changed!.payload as { before: { winnersCount: number }; after: { winnersCount: number } };
    expect(p.before.winnersCount).toBe(1);
    expect(p.after.winnersCount).toBe(2);
    expect((await pool.query('SELECT winners_count FROM giveaways WHERE id = $1', [GID])).rows[0].winners_count).toBe(2);
    const same = await run(rt, h.changeSettings, { giveawayId: GID, settings: { winnersCount: 2 } });
    expect(same).toEqual({ ok: true, events: [] });
    await must(rt, h.close, { giveawayId: GID });
    expect(await code(run(rt, h.changeSettings, { giveawayId: GID, settings: { winnersCount: 3 } }))).toBe('settings_locked');
    const revert = { stream: giveawayStream(GID), eventId: changed!.id, reason: 'Vertippt' };
    await must(rt, h.revert, revert);
    expect((await state(rt)).settings.winnersCount).toBe(1);
    expect((await pool.query('SELECT winners_count FROM giveaways WHERE id = $1', [GID])).rows[0].winners_count).toBe(1);
    expect(await code(run(rt, h.revert, revert))).toBe('already_reverted');
  });

  it('revert of the latest transition only', async () => {
    const { pool, rt } = await setup();
    const h = rt.handlers;
    await createOpen(rt);
    const [paused] = await must(rt, h.pause, { giveawayId: GID });
    const [closed] = await must(rt, h.close, { giveawayId: GID });
    const stream = giveawayStream(GID);
    expect(await code(run(rt, h.revert, { stream, eventId: paused!.id, reason: 'zu früh' }))).toBe('not_latest_transition');
    await must(rt, h.revert, { stream, eventId: closed!.id, reason: 'zu früh' });
    expect((await state(rt)).status).toBe('paused');
    expect((await pool.query('SELECT status FROM giveaways WHERE id = $1', [GID])).rows[0].status).toBe('paused');
  });

  it('authorizer denies users, allows system', async () => {
    const { pool, rt } = await setup({ auth: denyUsers });
    const denied = await run(rt, rt.handlers.create, createCmd(), { actor: STREAMER });
    expect(denied).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'no_accounts', message: 'Dieser Prozess nimmt keine Nutzerbefehle an. Nutze die App.' },
    });
    expect((await pool.query('SELECT count(*)::int AS n FROM stream_heads')).rows[0].n).toBe(0);
    expect(await code(run(rt, rt.handlers.create, createCmd(), { actor: 'system:scheduler' }))).toBe('ok');
    expect(await code(run(rt, rt.handlers.open, { giveawayId: GID }, { actor: STREAMER }))).toBe('no_accounts');
    expect(await code(run(rt, rt.handlers.open, { giveawayId: GID }, { actor: 'system:scheduler' }))).toBe('ok');
  });

  it('unknown giveaway is rejected before locking', async () => {
    const { pool, rt } = await setup();
    const r = await run(rt, rt.handlers.open, { giveawayId: GID });
    expect(r).toEqual({ ok: false, rejection: { rejected: true, code: 'giveaway_not_found', message: 'Dieses Giveaway gibt es nicht.' } });
    expect((await pool.query('SELECT count(*)::int AS n FROM stream_heads')).rows[0].n).toBe(0);
    expect(await code(run(rt, rt.handlers.revert, { stream: giveawayStream(GID), eventId: '1', reason: 'x' }))).toBe('giveaway_not_found');
  });
  it('change_settings merges a partial config over the current one', async () => {
    const { rt } = await setup();
    await createOpen(rt);
    await must(rt, rt.handlers.changeSettings, { giveawayId: GID, settings: { config: { windowSec: 300 } } });
    expect((await state(rt)).settings.config).toEqual({ windowSec: 300 });
    expect(await must(rt, rt.handlers.changeSettings, { giveawayId: GID, settings: { config: {} } })).toEqual([]);
    await must(rt, rt.handlers.changeSettings, { giveawayId: GID, settings: { prize: 'Neu' } });
    const s = await state(rt);
    expect(s.settings.config).toEqual({ windowSec: 300 });
    expect(s.settings.prize).toBe('Neu');
  });
});
