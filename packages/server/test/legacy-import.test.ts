import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { CommandResult } from '../src/framework/command-bus.js';
import type { ImportLegacyGiveawayCmd } from '../src/framework/giveaway/legacy.js';
import { giveawayStream } from '../src/framework/giveaway/state.js';
import type { Runtime } from '../src/framework/runtime.js';
import { loadStreamState } from '../src/framework/state.js';
import { TEAM_EVENTS, teamStream, type TeamState } from '../src/framework/team/state.js';
import { findPidByTwitchId, type TwitchUser } from '../src/identity/identities.js';
import { identityResolver } from '../src/identity/resolver.js';
import { attachAccounts } from '../src/identity/runtime.js';
import { assertNoTwitchIdentity } from '../src/journal/guard.js';
import { readStream } from '../src/journal/journal.js';
import { FRAMEWORK_EVENTS } from '../src/kernel-api/index.js';
import type { WatchtimeState } from '../src/kernels/watchtime/index.js';
import { AT } from './helpers/db.js';
import { ctx } from './helpers/fixtures.js';
import { GID, GID2, P1, TEAM, must, run, setupGiveaway, state, userOf } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const MIG = { actor: 'system:migration' };
const KEY = randomBytes(32);
const TEAM2 = '55555555-5555-4555-8555-555555555556';
const A: TwitchUser = { id: '1001', login: 'streamer_a', displayName: 'Streamer_A' };
const B: TwitchUser = { id: '1002', login: 'kanal_b', displayName: 'Kanal_B' };
const V1: TwitchUser = { id: '2001', login: 'viewer_1', displayName: 'Viewer_1' };
const V2: TwitchUser = { id: '2002', login: 'viewer_2', displayName: 'Viewer_2' };
const V3: TwitchUser = { id: '2003', login: 'viewer_3', displayName: 'Viewer_3' };
const V4: TwitchUser = { id: '2004', login: 'viewer_4', displayName: 'Viewer_4' };
const V5: TwitchUser = { id: '2005', login: 'viewer_5', displayName: 'Viewer_5' };
const NOBODY: TwitchUser = { id: '2009', login: 'nobody_0', displayName: 'Nobody' };
const TROLL: TwitchUser = { id: '3001', login: 'troll_t', displayName: 'Troll' };

async function setup() {
  const s = await setupGiveaway({ identities: identityResolver() });
  close = s.close;
  const accounts = attachAccounts(s.rt, { tokenKey: KEY });
  return { ...s, accounts };
}

const cmd = (over: Partial<ImportLegacyGiveawayCmd> = {}): ImportLegacyGiveawayCmd => ({
  giveawayId: GID,
  teamId: TEAM,
  legacySessionId: 'sess_1700000001',
  prize: 'Werwolf-Box',
  sponsor: 'Sponsor GmbH',
  keyword: '!werwolf',
  coinBaseSec: 7200,
  followMin: 2,
  chatBonus: { enabled: true, sec: 2, minWords: 4, cooldownSec: 10 },
  channels: [A, B],
  status: 'paused',
  terms: { version: 3, text: 'Fassung 3.' },
  participants: [
    { user: V1, registered: true, perChannel: { [A.id]: 36000.4, [B.id]: 7200 } },
    { user: V2, registered: true, perChannel: { [A.id]: 1800.6 } },
    { user: V3, registered: false, perChannel: { [B.id]: 600 } },
    { user: V4, registered: true, perChannel: {} },
    { user: NOBODY, registered: false, perChannel: {} },
    { user: V5, registered: false, perChannel: { [A.id]: 0.4 } },
  ],
  ...over,
});

async function code(p: Promise<CommandResult>): Promise<string> {
  const r = await p;
  return r.ok ? 'ok' : r.rejection.code;
}

const pidOf = async (pool: pg.Pool, u: TwitchUser): Promise<string> => {
  const pid = await findPidByTwitchId(pool, u.id);
  if (pid === null) throw new Error(`keine Identität für ${u.login}`);
  return pid;
};

async function rows(pool: pg.Pool, table: string, where = '', params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await pool.query(`SELECT * FROM ${table} ${where}`, params)).rows as Record<string, unknown>[];
}

async function teamState(s: { pool: pg.Pool; rt: Runtime }, teamId: string): Promise<TeamState> {
  const c = await s.pool.connect();
  try {
    return await loadStreamState(c, s.rt.registry, teamStream(teamId), s.rt.teamReducer);
  } finally {
    c.release();
  }
}

describe('import_legacy_giveaway', () => {
  it('writes giveaway_created and legacy_imported with pids only; state is paused, registrations point to the import event, seen holds the channels, the kernel holds the seconds; rows exist', async () => {
    const { pool, rt } = await setup();
    const events = await must(rt, rt.handlers.importLegacy, cmd(), MIG);
    expect(events.map((e) => [e.type, e.actor])).toEqual([['giveaway_created', 'system:migration'], [FRAMEWORK_EVENTS.legacyImported, 'system:migration']]);
    for (const e of events) assertNoTwitchIdentity(e.payload);
    const [pA, pB, pV1, pV2, pV3, pV4] = await Promise.all([A, B, V1, V2, V3, V4].map((u) => pidOf(pool, u)));
    expect(await findPidByTwitchId(pool, NOBODY.id)).toBeNull();
    expect(await findPidByTwitchId(pool, V5.id)).toBeNull();
    const imp = events[1]!;
    expect(imp.payload).toEqual({
      legacySessionId: 'sess_1700000001',
      status: 'paused',
      terms: { version: 3, text: 'Fassung 3.' },
      registered: [pV1, pV2, pV4].sort(),
      entries: [
        { pid: pV1, channel: pA, sec: 36000 },
        { pid: pV1, channel: pB, sec: 7200 },
        { pid: pV2, channel: pA, sec: 1801 },
        { pid: pV3, channel: pB, sec: 600 },
      ],
    });
    const created = events[0]!.payload as { teamId: string; kernelId: string; settings: Record<string, unknown> };
    expect(created.teamId).toBe(TEAM);
    expect(created.kernelId).toBe('watchtime');
    expect(created.settings).toMatchObject({
      prize: 'Werwolf-Box', sponsor: 'Sponsor GmbH', keyword: '!werwolf', counting: 'first_seen', purgeDays: 7, claimDays: 14, winnersCount: 1,
      channels: [pA, pB], config: { coinBaseSec: 7200 }, gates: [{ id: 'follow', mode: 'min', min: 2 }],
      legal: { impressumUrl: null, terms: { text: 'Fassung 3.' }, privacyUrl: null }, chatBonus: { enabled: true, sec: 2, minWords: 4, cooldownSec: 10 }, contact: null,
    });

    const s = await state(rt);
    expect(s.status).toBe('paused');
    expect(s.closedAt).toBeNull();
    expect(s.legal).toBeNull();
    expect(s.legalEventId).toBe(imp.id);
    const atIso = AT.toISOString();
    expect(s.registered).toEqual({
      [pV1!]: { since: atIso, eventId: imp.id, legalEventId: imp.id },
      [pV2!]: { since: atIso, eventId: imp.id, legalEventId: imp.id },
      [pV4!]: { since: atIso, eventId: imp.id, legalEventId: imp.id },
    });
    expect(s.seen).toEqual({ [pV1!]: { since: atIso, channels: [pA, pB] }, [pV2!]: { since: atIso, channels: [pA] }, [pV3!]: { since: atIso, channels: [pB] } });
    const k = s.kernelState as WatchtimeState;
    expect(k.sec).toEqual({ [pV1!]: { [pA!]: 36000, [pB!]: 7200 }, [pV2!]: { [pA!]: 1801 }, [pV3!]: { [pB!]: 600 } });
    expect(k.registered).toEqual([pV1, pV2, pV4].sort());

    expect((await rows(pool, 'giveaways'))[0]).toMatchObject({ id: GID, status: 'paused', keyword: '!werwolf', kernel: 'watchtime', counting: 'first_seen' });
    const parts = await rows(pool, 'giveaway_participants', 'WHERE giveaway_id = $1 ORDER BY pid', [GID]);
    const byPid = Object.fromEntries(parts.map((p) => [p.pid as string, p]));
    expect(Object.keys(byPid).sort()).toEqual([pV1, pV2, pV3, pV4].sort());
    expect(byPid[pV1!]).toMatchObject({ registered: true, in_pool: true, weight: 6, seen: true });
    expect(byPid[pV2!]).toMatchObject({ registered: true, in_pool: false, weight: 0, seen: true });
    expect(byPid[pV3!]).toMatchObject({ registered: false, in_pool: false, seen: true });
    expect(byPid[pV4!]).toMatchObject({ registered: true, in_pool: false, seen: false });
    expect(await rows(pool, 'legacy_imports')).toEqual([expect.objectContaining({ legacy_session_id: 'sess_1700000001', giveaway_id: GID, imported_at: AT })]);

    // Geschlossen, ohne Fassung: closedAt gesetzt, keine Zustimmungsfassung, legal null.
    const closed = await must(rt, rt.handlers.importLegacy, cmd({ giveawayId: GID2, legacySessionId: 'sess_1700000002', status: 'closed', terms: null, keyword: null, followMin: 0 }), MIG);
    const s2 = await state(rt, GID2);
    expect(s2.status).toBe('closed');
    expect(s2.closedAt).toBe(atIso);
    expect(s2.legalEventId).toBeNull();
    expect(s2.registered[pV1!]).toEqual({ since: atIso, eventId: closed[1]!.id, legalEventId: null });
    expect(s2.settings.legal).toBeNull();
    expect(s2.settings.gates).toEqual([]);
    expect(s2.settings.keyword).toBeNull();
    expect(await rows(pool, 'legacy_imports')).toHaveLength(2);
  });

  it('rejects users, a second import of the same session, invalid status, out-of-range rules, an unknown channel and bad ids; nothing is written on rejection', async () => {
    const { pool, rt } = await setup();
    expect(await code(run(rt, rt.handlers.importLegacy, cmd()))).toBe('migration_only');
    expect(await code(run(rt, rt.handlers.importLegacy, cmd(), { actor: 'system:scheduler' }))).toBe('migration_only');
    expect(await code(run(rt, rt.handlers.importLegacy, cmd({ giveawayId: 'nope' }), MIG))).toBe('invalid_id');
    expect(await code(run(rt, rt.handlers.importLegacy, cmd({ status: 'open' as 'paused' }), MIG))).toBe('invalid_status');
    expect(await code(run(rt, rt.handlers.importLegacy, cmd({ coinBaseSec: 30 }), MIG))).not.toBe('ok');
    expect(await code(run(rt, rt.handlers.importLegacy, cmd({ followMin: 3 }), MIG))).toBe('invalid_gate');
    expect(await code(run(rt, rt.handlers.importLegacy, cmd({ prize: '' }), MIG))).toBe('prize_required');
    expect(await code(run(rt, rt.handlers.importLegacy, cmd({ channels: [] }), MIG))).toBe('channels_required');
    expect(await code(run(rt, rt.handlers.importLegacy, cmd({ participants: [{ user: V1, registered: true, perChannel: { '9999': 10 } }] }), MIG))).toBe('unknown_channel');
    expect(await code(run(rt, rt.handlers.importLegacy, cmd({ terms: { version: 0, text: '' } }), MIG))).toBe('invalid_terms');
    const c = await pool.connect();
    try {
      expect(await readStream(c, rt.registry, giveawayStream(GID))).toEqual([]);
    } finally {
      c.release();
    }
    expect(await findPidByTwitchId(pool, V1.id)).toBeNull();
    await must(rt, rt.handlers.importLegacy, cmd(), MIG);
    expect(await code(run(rt, rt.handlers.importLegacy, cmd(), MIG))).toBe('already_imported');
    expect(await rows(pool, 'legacy_imports')).toHaveLength(1);
  });
});

describe('import_legacy_team', () => {
  it('creates team, team_imported, bans and the legacy_teams row; users are rejected; the second call is already_imported; a banned member is refused', async () => {
    const { pool, rt } = await setup();
    const teamCmd = { teamId: TEAM2, legacyTeamId: 'team_chaoscrew', name: ' Chaos Crew ', members: [B, A], banned: [TROLL] };
    expect(await code(run(rt, rt.teams.importLegacy, teamCmd))).toBe('migration_only');
    expect(await code(run(rt, rt.teams.importLegacy, teamCmd, { actor: userOf(P1) }))).toBe('migration_only');
    expect(await code(run(rt, rt.teams.importLegacy, { ...teamCmd, banned: [A] }, MIG))).toBe('banned_member');
    expect(await code(run(rt, rt.teams.importLegacy, { ...teamCmd, members: [] }, MIG))).toBe('members_required');
    expect(await findPidByTwitchId(pool, A.id)).toBeNull();

    const events = await must(rt, rt.teams.importLegacy, teamCmd, MIG);
    const [pA, pB, pT] = await Promise.all([A, B, TROLL].map((u) => pidOf(pool, u)));
    expect(events.map((e) => [e.type, e.payload, e.actor])).toEqual([
      [TEAM_EVENTS.created, { name: 'Chaos Crew', members: [pA, pB].sort() }, 'system:migration'],
      [TEAM_EVENTS.imported, { legacyTeamId: 'team_chaoscrew' }, 'system:migration'],
      [TEAM_EVENTS.banned, { pid: pT }, 'system:migration'],
    ]);
    for (const e of events) assertNoTwitchIdentity(e.payload);
    const s = await teamState({ pool, rt }, TEAM2);
    expect(s).toMatchObject({ exists: true, name: 'Chaos Crew', active: true });
    expect(Object.keys(s.members).sort()).toEqual([pA, pB].sort());
    expect(Object.keys(s.banned)).toEqual([pT]);
    expect((await rows(pool, 'team_members', 'WHERE team_id = $1', [TEAM2])).map((r) => r.pid).sort()).toEqual([pA, pB].sort());
    expect((await rows(pool, 'team_bans', 'WHERE team_id = $1', [TEAM2])).map((r) => r.pid)).toEqual([pT]);
    expect(await rows(pool, 'legacy_teams')).toEqual([expect.objectContaining({ legacy_team_id: 'team_chaoscrew', team_id: TEAM2, imported_at: AT })]);

    expect(await code(run(rt, rt.teams.importLegacy, teamCmd, MIG))).toBe('already_imported');
    expect(await rows(pool, 'legacy_teams')).toHaveLength(1);

    expect(rt.registry.get(TEAM_EVENTS.imported).reversal).toEqual({ kind: 'none', why: 'Die Übernahme bleibt im Nachweis. Deaktiviere das Team.' });
    expect(rt.registry.get(FRAMEWORK_EVENTS.legacyImported).reversal).toEqual({ kind: 'none', why: 'Altbestand. Korrektur über Zeit-Korrektur.' });
  });
});

describe('sign_in für die Übernahme', () => {
  it('system:migration creates identity and account with the given solo team; the later Twitch sign-in reuses pid and solo team', async () => {
    const { pool, rt, accounts } = await setup();
    const SOLO = '55555555-5555-4555-8555-555555555557';
    const first = await rt.bus.execute(accounts.signIn, { pid: P1, soloTeamId: SOLO, user: A }, ctx({ actor: 'system:migration' }));
    expect(first.ok && first.events.map((e) => [e.type, e.payload])).toEqual([['account_created', { soloTeamId: SOLO }]]);
    expect(await findPidByTwitchId(pool, A.id)).toBe(P1);
    const again = await rt.bus.execute(accounts.signIn, { pid: P1, soloTeamId: '55555555-5555-4555-8555-555555555558', user: A }, ctx({ actor: 'system:twitch' }));
    expect(again).toEqual({ ok: true, events: [] });
    expect((await rows(pool, 'accounts'))[0]).toMatchObject({ pid: P1, solo_team_id: SOLO });
    expect(await code(rt.bus.execute(accounts.signIn, { pid: GID, soloTeamId: SOLO, user: B }, ctx({ actor: 'system:scheduler' })))).toBe('not_you');
  });
});
