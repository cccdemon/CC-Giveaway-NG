import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import { withTx } from '../src/db/pool.js';
import type { GateChecker } from '../src/framework/giveaway/gates.js';
import { GIVEAWAY_EVENTS } from '../src/framework/giveaway/state.js';
import { FRAMEWORK_EVENTS } from '../src/kernel-api/index.js';
import { upsertIdentity } from '../src/identity/identities.js';
import { identityResolver } from '../src/identity/resolver.js';
import { attachAccounts } from '../src/identity/runtime.js';
import { pgBanDirectory, pgTeamDirectory } from '../src/identity/team-directory.js';
import { minuteOf } from '../src/ingest/bundler.js';
import { AT } from './helpers/db.js';
import { GID, GID2, P1, P2, P3, STREAMER, TEAM, at, createOpen, must, run, setupGiveaway, state, userOf } from './helpers/giveaway.js';
import { kernelsWithPlain } from './helpers/plain-kernel.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const FOUNDER = STREAMER.slice('user:'.length);
const INVITE = '11111111-1111-4111-8111-111111111111';
const SOLO3 = '55555555-5555-4555-8555-555555555559';
const ALICE = { id: '12345', login: 'alice', displayName: 'Alice' };
const INGEST = { actor: 'system:ingest' };
const CHANNEL_NOT_IN_TEAM = { rejected: true, code: 'channel_not_in_team', message: 'Dieser Kanal gehört nicht zum Team.' };

async function setup(over: Parameters<typeof setupGiveaway>[0] = {}) {
  const s = await setupGiveaway({ teamDirectory: pgTeamDirectory(), bans: pgBanDirectory(), identities: identityResolver(), ...over });
  close = s.close;
  const accounts = attachAccounts(s.rt, { tokenKey: randomBytes(32) });
  return { ...s, accounts };
}

async function code(p: Promise<CommandResult>): Promise<string> {
  const r = await p;
  return r.ok ? 'ok' : r.rejection.code;
}

/** Team TEAM mit Gründer STREAMER und Mitglied P1. */
async function teamWithP1(rt: Awaited<ReturnType<typeof setup>>['rt']) {
  await must(rt, rt.teams.create, { teamId: TEAM, name: 'Werwölfe' });
  await must(rt, rt.teams.createInvite, { teamId: TEAM, inviteId: INVITE });
  await must(rt, rt.teams.join, { teamId: TEAM, inviteId: INVITE, pid: P1 }, { actor: userOf(P1) });
}

const createCmd = (channels: string[], over: Record<string, unknown> = {}) => ({
  giveawayId: GID,
  teamId: TEAM,
  kernelId: 'instant',
  settings: { prize: 'Key', channels },
  ...over,
});

describe('Teams im Giveaway', () => {
  it('create_giveaway accepts channels of members, rejects a non-member channel; solo team accepts only the own pid; unknown team passes', async () => {
    const { rt, accounts } = await setup();
    await teamWithP1(rt);
    expect(await run(rt, rt.handlers.create, createCmd([FOUNDER, P2]))).toEqual({ ok: false, rejection: CHANNEL_NOT_IN_TEAM });
    expect(await code(run(rt, rt.handlers.create, createCmd([FOUNDER, P1])))).toBe('ok');
    await must(rt, accounts.signIn, { pid: P3, soloTeamId: SOLO3, user: { id: '999', login: 'carol', displayName: 'Carol' } }, { actor: 'system:twitch' });
    expect(await run(rt, rt.handlers.create, createCmd([P1], { giveawayId: GID2, teamId: SOLO3 }))).toEqual({ ok: false, rejection: CHANNEL_NOT_IN_TEAM });
    expect(await code(run(rt, rt.handlers.create, createCmd([P3], { giveawayId: GID2, teamId: SOLO3 })))).toBe('ok');
    const UNKNOWN_TEAM = '55555555-5555-4555-8555-55555555555a';
    expect(await code(run(rt, rt.handlers.create, createCmd([P2], { giveawayId: '66666666-6666-4666-8666-66666666666a', teamId: UNKNOWN_TEAM })))).toBe('ok');
  });

  it('after a member leaves, change_settings with their channel is channel_not_in_team, without channels it still works', async () => {
    const { rt } = await setup();
    await teamWithP1(rt);
    await must(rt, rt.handlers.create, createCmd([FOUNDER, P1]));
    await must(rt, rt.teams.leave, { teamId: TEAM, pid: P1 }, { actor: userOf(P1) });
    // Unveränderte Liste (volles Formular) geht durch, nur neu gesetzte Kanäle müssen zum Team gehören.
    expect(await code(run(rt, rt.handlers.changeSettings, { giveawayId: GID, settings: { channels: [FOUNDER, P1], prize: 'Neu' } }))).toBe('ok');
    expect(await code(run(rt, rt.handlers.changeSettings, { giveawayId: GID, settings: { prize: 'Neu 2' } }))).toBe('ok');
    expect(await code(run(rt, rt.handlers.changeSettings, { giveawayId: GID, settings: { channels: [FOUNDER] } }))).toBe('ok');
    expect((await state(rt)).settings.channels).toEqual([FOUNDER]);
    expect(await run(rt, rt.handlers.changeSettings, { giveawayId: GID, settings: { channels: [FOUNDER, P1] } })).toEqual({ ok: false, rejection: CHANNEL_NOT_IN_TEAM });
  });

  it('signals for the channel of a member who left are rejected, the remaining channel still credits', async () => {
    const { pool, rt } = await setup();
    await teamWithP1(rt);
    await withTx(pool, (c) => upsertIdentity(c, ALICE, P2, AT));
    await createOpen(rt, createCmd([FOUNDER, P1], { kernelId: 'watchtime', settings: { prize: 'Key', channels: [FOUNDER, P1], config: { coinBaseSec: 60 }, counting: 'first_seen' } }));
    const presence = (channel: string, minute: Date) => ({ giveawayId: GID, channel, minute: minuteOf(minute), presence: [ALICE], chat: [], follows: [] });
    expect(await code(run(rt, rt.handlers.applySignals, presence(P1, AT), INGEST))).toBe('ok');
    await must(rt, rt.teams.leave, { teamId: TEAM, pid: P1 }, { actor: userOf(P1) });
    expect(await run(rt, rt.handlers.applySignals, presence(P1, at(60)), INGEST)).toEqual({ ok: false, rejection: CHANNEL_NOT_IN_TEAM });
    expect(await code(run(rt, rt.handlers.applySignals, presence(FOUNDER, at(60)), INGEST))).toBe('ok');
    expect((await state(rt)).watchMinutes[P1]).toBe(minuteOf(AT));
  });

  it('create_giveaway in a deactivated team is team_inactive; pause, close and draw of the running giveaway still work', async () => {
    const { rt } = await setup({ kernels: kernelsWithPlain() });
    await teamWithP1(rt);
    await createOpen(rt, createCmd([FOUNDER], { kernelId: 'plain', settings: { prize: 'Key', channels: [FOUNDER], config: {} } }));
    await must(rt, rt.handlers.register, { giveawayId: GID, pid: P2 }, { actor: userOf(P2) });
    await must(rt, rt.teams.deactivate, { teamId: TEAM });
    expect(await run(rt, rt.handlers.create, createCmd([FOUNDER], { giveawayId: GID2 }))).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'team_inactive', message: 'Dieses Team ist deaktiviert. Aktiviere es oder nutze ein anderes.' },
    });
    expect(await code(run(rt, rt.handlers.pause, { giveawayId: GID }))).toBe('ok');
    expect(await code(run(rt, rt.handlers.close, { giveawayId: GID }))).toBe('ok');
    const drawn = await must(rt, rt.handlers.draw, { giveawayId: GID });
    expect(drawn[0]!.payload).toMatchObject({ winners: [P2] });
  });

  it('banned pid: register is banned, keyword and presence in chat write nothing, after unban everything works', async () => {
    const { pool, rt } = await setup();
    await teamWithP1(rt);
    await withTx(pool, (c) => upsertIdentity(c, ALICE, P2, AT));
    await createOpen(rt, createCmd([FOUNDER], { kernelId: 'watchtime', settings: { prize: 'Key', channels: [FOUNDER], config: { coinBaseSec: 60 }, counting: 'first_seen', keyword: '!go' } }));
    await must(rt, rt.teams.ban, { teamId: TEAM, pid: P2 });
    expect(await run(rt, rt.handlers.register, { giveawayId: GID, pid: P2 }, { actor: userOf(P2) })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'banned', message: 'Du bist in diesem Team gesperrt.' },
    });
    const signals = (minute: Date) => ({
      giveawayId: GID,
      channel: FOUNDER,
      minute: minuteOf(minute),
      presence: [ALICE],
      chat: [{ user: ALICE, at: minute.toISOString(), text: '!go', messageId: 'm1' }],
      follows: [],
    });
    expect(await must(rt, rt.handlers.applySignals, signals(AT), INGEST)).toEqual([]);
    let s = await state(rt);
    expect(s.registered).toEqual({});
    expect(s.seen).toEqual({});
    await must(rt, rt.teams.unban, { teamId: TEAM, pid: P2 });
    const events = await must(rt, rt.handlers.applySignals, signals(at(60)), INGEST);
    expect(events.map((e) => e.type)).toEqual([GIVEAWAY_EVENTS.registered, FRAMEWORK_EVENTS.watchCredited]);
    s = await state(rt);
    expect(Object.keys(s.registered)).toEqual([P2]);
    expect(await code(run(rt, rt.handlers.withdraw, { giveawayId: GID, pid: P2 }, { actor: userOf(P2) }))).toBe('ok');
    expect(await code(run(rt, rt.handlers.register, { giveawayId: GID, pid: P2 }, { actor: userOf(P2) }))).toBe('ok');
  });

  it('draw excludes a banned pid with reason banned before not_registered and without a gate check', async () => {
    const gates: GateChecker = { check: vi.fn(async (_db, input) => input.pids.map((pid: string) => ({ pid, ok: true, reasons: [] as string[] }))) };
    const { rt } = await setup({ kernels: kernelsWithPlain(), gates });
    await teamWithP1(rt);
    await createOpen(rt, createCmd([FOUNDER], { kernelId: 'plain', settings: { prize: 'Key', channels: [FOUNDER], config: {} } }));
    await must(rt, rt.handlers.register, { giveawayId: GID, pid: P2 }, { actor: userOf(P2) });
    await must(rt, rt.handlers.register, { giveawayId: GID, pid: P3 }, { actor: userOf(P3) });
    await must(rt, rt.teams.ban, { teamId: TEAM, pid: P2 });
    await must(rt, rt.handlers.close, { giveawayId: GID });
    const [drawn] = await must(rt, rt.handlers.draw, { giveawayId: GID });
    expect(drawn!.payload).toMatchObject({
      winners: [P3],
      gates: [
        { pid: P2, ok: false, reasons: ['banned'] },
        { pid: P3, ok: true, reasons: [] },
      ],
    });
    expect(gates.check).toHaveBeenCalledOnce();
    expect((gates.check as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({ pids: [P3] });
  });

  it('without directories nothing changes: foreign channels and unknown teams pass, nobody is banned', async () => {
    const s = await setupGiveaway();
    close = s.close;
    expect(await code(run(s.rt, s.rt.handlers.create, createCmd([P2, P3])))).toBe('ok');
    await must(s.rt, s.rt.handlers.open, { giveawayId: GID });
    await must(s.rt, s.rt.teams.create, { teamId: TEAM, name: 'x' });
    await must(s.rt, s.rt.teams.ban, { teamId: TEAM, pid: P2 });
    await must(s.rt, s.rt.handlers.kernelCommand, { giveawayId: GID, command: { type: 'open_window', args: {} } });
    expect(await code(run(s.rt, s.rt.handlers.register, { giveawayId: GID, pid: P2 }, { actor: userOf(P2) }))).toBe('ok');
  });
});
