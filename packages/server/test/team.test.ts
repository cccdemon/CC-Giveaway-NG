import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../src/framework/command-bus.js';
import { loadStreamState } from '../src/framework/state.js';
import { denyUsersTeams } from '../src/framework/team/commands.js';
import { INVITE_TTL_DAYS, TEAM_EVENTS, TEAM_NAME_MAX, teamStream, type TeamState } from '../src/framework/team/state.js';
import { assertNoTwitchIdentity } from '../src/journal/guard.js';
import { readStream } from '../src/journal/journal.js';
import type { Runtime } from '../src/framework/runtime.js';
import { AT } from './helpers/db.js';
import { P1, P2, P3, STREAMER, TEAM, at, must, run, setupGiveaway, userOf } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const FOUNDER = STREAMER.slice('user:'.length);
const TEAM2 = '55555555-5555-4555-8555-555555555556';
const INVITE = '11111111-1111-4111-8111-111111111111';
const INVITE2 = '11111111-1111-4111-8111-111111111112';
const STREAM = teamStream(TEAM);
const MIGRATION = { actor: 'system:migration' };
const TTL_SEC = INVITE_TTL_DAYS * 86_400;

async function setup(over: Parameters<typeof setupGiveaway>[0] = {}) {
  const s = await setupGiveaway(over);
  close = s.close;
  return s;
}

async function code(p: Promise<CommandResult>): Promise<string> {
  const r = await p;
  return r.ok ? 'ok' : r.rejection.code;
}

async function teamState(s: { pool: import('pg').Pool; rt: Runtime }, teamId = TEAM): Promise<TeamState> {
  const c = await s.pool.connect();
  try {
    return await loadStreamState(c, s.rt.registry, teamStream(teamId), s.rt.teamReducer);
  } finally {
    c.release();
  }
}

const createTeam = (rt: Runtime, name = 'Werwölfe') => must(rt, rt.teams.create, { teamId: TEAM, name });
const invite = (rt: Runtime, inviteId = INVITE, over = {}) => must(rt, rt.teams.createInvite, { teamId: TEAM, inviteId }, over);
const join = (rt: Runtime, pid: string, inviteId = INVITE, over = {}) => run(rt, rt.teams.join, { teamId: TEAM, inviteId, pid }, { actor: userOf(pid), ...over });
const types = (events: { type: string }[]) => events.map((e) => e.type);

async function rows(pool: import('pg').Pool, table: string, teamId = TEAM): Promise<Record<string, unknown>[]> {
  const col = table === 'teams' ? 'id' : 'team_id';
  const r = await pool.query(`SELECT * FROM ${table} WHERE ${col} = $1 ORDER BY 2`, [teamId]);
  return r.rows;
}

describe('Strom team', () => {
  it('create_team writes team_created with the founder as only member and projects teams + team_members', async () => {
    const { pool, rt } = await setup();
    const events = await createTeam(rt);
    expect(events.map((e) => [e.type, e.payload, e.actor])).toEqual([[TEAM_EVENTS.created, { name: 'Werwölfe', members: [FOUNDER] }, STREAMER]]);
    const s = await teamState({ pool, rt });
    expect(s).toMatchObject({ exists: true, name: 'Werwölfe', active: true, invites: {}, banned: {} });
    expect(s.members).toEqual({ [FOUNDER]: { since: AT.toISOString(), eventId: events[0]!.id } });
    expect(await rows(pool, 'teams')).toEqual([expect.objectContaining({ id: TEAM, name: 'Werwölfe', active: true, member_count: 1, last_seq: 1 })]);
    expect((await rows(pool, 'team_members')).map((r) => r.pid)).toEqual([FOUNDER]);
  });

  it('create_team rejects a second create, an invalid name and members from a user; system:migration may pass members', async () => {
    const { pool, rt } = await setup();
    await createTeam(rt);
    expect(await code(run(rt, rt.teams.create, { teamId: TEAM, name: 'Nochmal' }))).toBe('already_exists');
    expect(await run(rt, rt.teams.create, { teamId: TEAM2, name: '   ' })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'team_name_invalid', message: 'Der Teamname hat 1 bis 60 Zeichen.' },
    });
    expect(await code(run(rt, rt.teams.create, { teamId: TEAM2, name: 'x'.repeat(TEAM_NAME_MAX + 1) }))).toBe('team_name_invalid');
    expect(await run(rt, rt.teams.create, { teamId: TEAM2, name: 'Alt', members: [P1] })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'members_reserved', message: 'Mitglieder vorgeben darf nur die Übernahme.' },
    });
    expect(await code(run(rt, rt.teams.create, { teamId: TEAM2, name: 'Alt' }, MIGRATION))).toBe('members_required');
    const imported = await must(rt, rt.teams.create, { teamId: TEAM2, name: ' Alt ', members: [P2, P1] }, MIGRATION);
    expect(imported[0]!.payload).toEqual({ name: 'Alt', members: [P1, P2] });
    expect((await rows(pool, 'team_members', TEAM2)).map((r) => r.pid)).toEqual([P1, P2]);
    expect(await code(run(rt, rt.teams.create, { teamId: 'nope', name: 'x' }))).toBe('invalid_id');
  });

  it('rename writes before/after, revert restores the old name, revert of an older rename is not_latest', async () => {
    const { pool, rt } = await setup();
    await createTeam(rt);
    const [first] = await must(rt, rt.teams.rename, { teamId: TEAM, name: 'Neu' });
    expect(first!.payload).toEqual({ before: 'Werwölfe', after: 'Neu' });
    expect(await must(rt, rt.teams.rename, { teamId: TEAM, name: 'Neu' })).toEqual([]);
    const [second] = await must(rt, rt.teams.rename, { teamId: TEAM, name: 'Neu2' });
    expect(await code(run(rt, rt.teams.revert, { stream: STREAM, eventId: first!.id, reason: 'x' }))).toBe('not_latest');
    await must(rt, rt.teams.revert, { stream: STREAM, eventId: second!.id, reason: 'Tippfehler' });
    expect((await teamState({ pool, rt })).name).toBe('Neu');
    expect((await rows(pool, 'teams'))[0]!.name).toBe('Neu');
    expect(await code(run(rt, rt.teams.rename, { teamId: TEAM2, name: 'x' }))).toBe('team_not_found');
  });

  it('invite → join adds the member with inviteId, second join is a no-op, projection lists members and the invite', async () => {
    const { pool, rt } = await setup();
    await createTeam(rt);
    const [inv] = await invite(rt);
    expect(inv!.payload).toEqual({ inviteId: INVITE, expiresAt: at(TTL_SEC).toISOString() });
    const joined = await join(rt, P1);
    expect(joined).toMatchObject({ ok: true });
    if (!joined.ok) return;
    expect(joined.events.map((e) => [e.type, e.payload, e.actor])).toEqual([[TEAM_EVENTS.memberJoined, { pid: P1, inviteId: INVITE }, userOf(P1)]]);
    expect(await join(rt, P1)).toEqual({ ok: true, events: [] });
    expect((await rows(pool, 'team_members')).map((r) => r.pid)).toEqual([P1, FOUNDER]);
    expect(await rows(pool, 'team_invites')).toEqual([expect.objectContaining({ invite_id: INVITE, team_id: TEAM, revoked: false, expires_at: at(TTL_SEC) })]);
    expect((await rows(pool, 'teams'))[0]).toMatchObject({ member_count: 2 });
    expect(await code(run(rt, rt.teams.join, { teamId: TEAM, inviteId: INVITE, pid: P2 }, { actor: userOf(P3) }))).toBe('not_you');
  });

  it('join rejects unknown, revoked and expired invites, inactive team and banned pid; nothing is written', async () => {
    const { pool, rt } = await setup();
    await createTeam(rt);
    await invite(rt);
    const before = (await readStream(pool, rt.registry, STREAM)).length;
    expect(await join(rt, P2, INVITE2)).toEqual({ ok: false, rejection: { rejected: true, code: 'invite_not_found', message: 'Diese Einladung gibt es nicht.' } });
    expect(await join(rt, P2, INVITE, { now: at(TTL_SEC) })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'invite_expired', message: 'Diese Einladung ist abgelaufen. Bitte um eine neue.' },
    });
    expect(await code(join(rt, P2, INVITE, { now: at(TTL_SEC - 1) }))).toBe('ok');
    await must(rt, rt.teams.revokeInvite, { teamId: TEAM, inviteId: INVITE });
    expect(await must(rt, rt.teams.revokeInvite, { teamId: TEAM, inviteId: INVITE })).toEqual([]);
    expect(await code(run(rt, rt.teams.revokeInvite, { teamId: TEAM, inviteId: INVITE2 }))).toBe('invite_not_found');
    expect(await code(join(rt, P3, INVITE))).toBe('invite_revoked');
    await invite(rt, INVITE2);
    await must(rt, rt.teams.deactivate, { teamId: TEAM });
    expect(await join(rt, P3, INVITE2)).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'team_inactive', message: 'Dieses Team ist deaktiviert. Aktiviere es oder nutze ein anderes.' },
    });
    await must(rt, rt.teams.reactivate, { teamId: TEAM });
    await must(rt, rt.teams.ban, { teamId: TEAM, pid: P3 });
    expect(await join(rt, P3, INVITE2)).toEqual({ ok: false, rejection: { rejected: true, code: 'banned', message: 'Du bist in diesem Team gesperrt.' } });
    const after = await readStream(pool, rt.registry, STREAM);
    // Geschrieben wurden nur: join P2, revoke, invite2, deactivate, reactivate, ban.
    expect(after.length - before).toBe(6);
    expect((await rows(pool, 'team_invites')).map((r) => [r.invite_id, r.revoked])).toEqual([[INVITE, true], [INVITE2, false]]);
  });

  it('leave removes a member; the last member gets last_member, also via revert of member_joined', async () => {
    const { pool, rt } = await setup();
    await createTeam(rt);
    await invite(rt);
    const joined = await join(rt, P1);
    const joinedId = joined.ok ? joined.events[0]!.id : '';
    expect(await code(run(rt, rt.teams.leave, { teamId: TEAM, pid: P2 }, { actor: userOf(P2) }))).toBe('not_member');
    expect(await code(run(rt, rt.teams.leave, { teamId: TEAM, pid: P1 }, { actor: userOf(P2) }))).toBe('not_you');
    const left = await must(rt, rt.teams.leave, { teamId: TEAM, pid: FOUNDER }, { actor: STREAMER });
    expect(left.map((e) => [e.type, e.payload])).toEqual([[TEAM_EVENTS.memberLeft, { pid: FOUNDER }]]);
    expect((await rows(pool, 'team_members')).map((r) => r.pid)).toEqual([P1]);
    expect(await run(rt, rt.teams.leave, { teamId: TEAM, pid: P1 }, { actor: userOf(P1) })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'last_member', message: 'Du bist das letzte Mitglied. Deaktiviere das Team.' },
    });
    expect(await code(run(rt, rt.teams.revert, { stream: STREAM, eventId: joinedId, reason: 'x' }, { actor: userOf(P1) }))).toBe('last_member');
    expect(await run(rt, rt.teams.revert, { stream: STREAM, eventId: left[0]!.id, reason: 'x' }, { actor: userOf(P1) })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'not_reversible', message: 'Zum Wiedereintritt braucht es eine neue Einladung.' },
    });
  });

  it('deactivate/reactivate toggle active, repeated calls write nothing, revert of deactivated reactivates, invites fail while inactive', async () => {
    const { pool, rt } = await setup();
    await createTeam(rt);
    const [d1] = await must(rt, rt.teams.deactivate, { teamId: TEAM });
    expect(d1!.type).toBe(TEAM_EVENTS.deactivated);
    expect(await must(rt, rt.teams.deactivate, { teamId: TEAM })).toEqual([]);
    expect(await code(run(rt, rt.teams.createInvite, { teamId: TEAM, inviteId: INVITE }))).toBe('team_inactive');
    expect((await rows(pool, 'teams'))[0]).toMatchObject({ active: false });
    const [r1] = await must(rt, rt.teams.reactivate, { teamId: TEAM });
    expect(r1!.type).toBe(TEAM_EVENTS.reactivated);
    expect(await must(rt, rt.teams.reactivate, { teamId: TEAM })).toEqual([]);
    expect(await code(run(rt, rt.teams.revert, { stream: STREAM, eventId: d1!.id, reason: 'x' }))).toBe('not_latest');
    const [d2] = await must(rt, rt.teams.deactivate, { teamId: TEAM });
    const [undo] = await must(rt, rt.teams.revert, { stream: STREAM, eventId: d2!.id, reason: 'Versehen' });
    expect(undo).toMatchObject({ type: TEAM_EVENTS.reactivated, reversesEventId: d2!.id, reason: 'Versehen' });
    expect((await teamState({ pool, rt })).active).toBe(true);
  });

  it('ban/unban toggle team_bans, revert of participant_banned unbans, unban of a non-banned pid is not_banned', async () => {
    const { pool, rt } = await setup();
    await createTeam(rt);
    const [ban] = await must(rt, rt.teams.ban, { teamId: TEAM, pid: P2 });
    expect(ban!.payload).toEqual({ pid: P2 });
    expect(await must(rt, rt.teams.ban, { teamId: TEAM, pid: P2 })).toEqual([]);
    expect((await rows(pool, 'team_bans')).map((r) => r.pid)).toEqual([P2]);
    expect(await run(rt, rt.teams.unban, { teamId: TEAM, pid: P3 })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'not_banned', message: 'Diese Person ist nicht gesperrt.' },
    });
    const [undo] = await must(rt, rt.teams.revert, { stream: STREAM, eventId: ban!.id, reason: 'Verwechslung' });
    expect(undo).toMatchObject({ type: TEAM_EVENTS.unbanned, payload: { pid: P2 }, reversesEventId: ban!.id });
    expect(await rows(pool, 'team_bans')).toEqual([]);
    await must(rt, rt.teams.ban, { teamId: TEAM, pid: P2 });
    const [unban] = await must(rt, rt.teams.unban, { teamId: TEAM, pid: P2 });
    expect(unban!.type).toBe(TEAM_EVENTS.unbanned);
    expect((await teamState({ pool, rt })).banned).toEqual({});
    expect(await code(run(rt, rt.teams.revert, { stream: STREAM, eventId: ban!.id, reason: 'x' }))).toBe('already_reverted');
  });

  it('payloads of the whole team stream contain no login or twitch id', async () => {
    const { pool, rt } = await setup();
    await createTeam(rt);
    await invite(rt);
    await join(rt, P1);
    await must(rt, rt.teams.rename, { teamId: TEAM, name: 'alice' });
    await must(rt, rt.teams.ban, { teamId: TEAM, pid: P2 });
    const events = await readStream(pool, rt.registry, STREAM);
    expect(types(events)).toEqual([TEAM_EVENTS.created, TEAM_EVENTS.inviteCreated, TEAM_EVENTS.memberJoined, TEAM_EVENTS.renamed, TEAM_EVENTS.banned]);
    for (const e of events) expect(() => assertNoTwitchIdentity(e.payload)).not.toThrow();
  });

  it('team commands by users are rejected through the authorizer, system:migration passes', async () => {
    const { rt } = await setup({ teamAuth: denyUsersTeams });
    expect(await run(rt, rt.teams.create, { teamId: TEAM, name: 'x' })).toEqual({
      ok: false,
      rejection: { rejected: true, code: 'no_accounts', message: 'Dieser Prozess nimmt keine Nutzerbefehle an. Nutze die App.' },
    });
    expect(await code(run(rt, rt.teams.create, { teamId: TEAM, name: 'Alt', members: [P1] }, MIGRATION))).toBe('ok');
    expect(await code(run(rt, rt.teams.rename, { teamId: TEAM, name: 'y' }, { actor: userOf(P1) }))).toBe('no_accounts');
    expect(await code(run(rt, rt.teams.ban, { teamId: TEAM, pid: P2 }, MIGRATION))).toBe('ok');
  });
});
