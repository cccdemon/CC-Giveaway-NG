import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Runtime } from '../src/framework/runtime.js';
import { findPidByTwitchId, type TwitchUser } from '../src/identity/identities.js';
import { identityResolver } from '../src/identity/resolver.js';
import { attachAccounts, type AccountHandlers } from '../src/identity/runtime.js';
import { assertNoTwitchIdentity } from '../src/journal/guard.js';
import { parseBackup, type LegacyBackup } from '../src/migration/legacy/format.js';
import { giveawayIdOf, soloTeamIdOf, teamIdOf } from '../src/migration/legacy/ids.js';
import { renderReport, reportPathOf } from '../src/migration/legacy/report.js';
import type { LoginResolver } from '../src/migration/legacy/resolve.js';
import { runImport, type RunResult } from '../src/migration/legacy/run.js';
import { AT } from './helpers/db.js';
import { ctx } from './helpers/fixtures.js';
import { setupGiveaway, state } from './helpers/giveaway.js';
import { FIXTURE_TEXT } from './legacy-format.test.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const KEY = randomBytes(32);
const fixture = (): LegacyBackup => parseBackup(FIXTURE_TEXT);
/** Alt-Team mit genau einem Mitglied: wird auf das Solo-Team abgebildet. */
const soloFixture = (): LegacyBackup => {
  const b = fixture();
  b.team.members = b.team.members.slice(0, 1);
  return b;
};

const userOf = (login: string): TwitchUser => ({ id: login === 'streamer_a' ? '1001' : `id-${login}`, login, displayName: login.toUpperCase() });

function stubResolver(unknown: string[] = ['ghost_9']) {
  const calls: string[][] = [];
  const resolver: LoginResolver = {
    async byLogin(logins) {
      calls.push(logins);
      return new Map(logins.filter((l) => !unknown.includes(l)).map((l) => [l, userOf(l)]));
    },
  };
  return { resolver, calls };
}

async function setup() {
  const s = await setupGiveaway({ identities: identityResolver() });
  close = s.close;
  const accounts = attachAccounts(s.rt, { tokenKey: KEY });
  return { ...s, accounts };
}

const eventCount = async (pool: pg.Pool): Promise<number> => Number((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0]!.n);
const rows = async (pool: pg.Pool, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => (await pool.query(sql, params)).rows as Record<string, unknown>[];

const run = (s: { pool: pg.Pool; rt: Runtime; accounts: AccountHandlers }, backup: LegacyBackup, resolver: LoginResolver, dryRun = false): Promise<RunResult> =>
  runImport(backup, { pool: s.pool, rt: s.rt, accounts: s.accounts, resolver, dryRun, now: () => AT });

const SESS1 = giveawayIdOf('sess_1700000001');
const SESS2 = giveawayIdOf('sess_1700000002');
const SESS3 = giveawayIdOf('sess_1700000003');

describe('runImport', () => {
  it('imports the fixture: team with bans, giveaways paused and closed, seconds per channel equal pgWatchSum minus unresolved, rules clamped with notes, inactive channel named', async () => {
    const s = await setup();
    const { resolver } = stubResolver();
    const r = await run(s, fixture(), resolver);
    expect(r.aborted).toBeNull();
    expect(r.failed).toBe(0);
    expect(r.unresolved).toEqual(['ghost_9']);
    expect(r.team).toMatchObject({ legacyTeamId: 'team_chaoscrew', kind: 'team', teamId: teamIdOf('team_chaoscrew'), outcome: 'created', bansSkipped: [], membersSkipped: [] });
    expect(r.giveaways.map((g) => [g.sessionId, g.outcome, g.status, g.giveawayId])).toEqual([
      ['sess_1700000001', 'created', 'paused', SESS1],
      ['sess_1700000002', 'created', 'closed', SESS2],
      ['sess_1700000003', 'created', 'paused', SESS3],
    ]);
    const g1 = r.giveaways[0]!;
    expect(g1.participants).toEqual({ total: 7, imported: 5, registered: 3, dropped: 2 });
    expect(g1.channels).toEqual([
      { login: 'streamer_a', pid: await findPidByTwitchId(s.pool, '1001'), imported: 38101, pgWatchSum: 38221, notImported: 120, inactive: false },
      { login: 'kanal_b', pid: await findPidByTwitchId(s.pool, 'id-kanal_b'), imported: 7200, pgWatchSum: 7200, notImported: 0, inactive: false },
      { login: 'kanal_c', pid: await findPidByTwitchId(s.pool, 'id-kanal_c'), imported: 600, pgWatchSum: 600, notImported: 0, inactive: true },
    ]);
    expect(g1.unresolved).toEqual([{ login: 'ghost_9', channel: 'streamer_a', sec: 120 }]);
    const g2 = r.giveaways[1]!;
    expect(g2.notes).toEqual(expect.arrayContaining([expect.stringContaining('Coin-Basis'), expect.stringContaining('Follow'), expect.stringContaining('Gewinn')]));
    const g3 = r.giveaways[2]!;
    expect(g3.notes).toEqual([expect.stringContaining('Keyword')]);
    expect(g3.participants).toEqual({ total: 0, imported: 0, registered: 0, dropped: 0 });

    const st1 = await state(s.rt, SESS1);
    expect(st1.status).toBe('paused');
    expect(st1.teamId).toBe(teamIdOf('team_chaoscrew'));
    expect(st1.settings).toMatchObject({ prize: 'Werwolf-Box', sponsor: 'Sponsor GmbH', keyword: '!werwolf', config: { coinBaseSec: 7200 }, gates: [{ id: 'follow', mode: 'min', min: 2 }], counting: 'first_seen' });
    expect(st1.settings.legal).toEqual({ impressumUrl: null, terms: { text: 'Teilnahmebedingungen Fassung 3. Teilnahme ab 18 Jahren.' }, privacyUrl: null });
    expect(Object.keys(st1.registered)).toHaveLength(3);
    const st2 = await state(s.rt, SESS2);
    expect(st2.status).toBe('closed');
    expect(st2.settings).toMatchObject({ prize: 'Test geschlossen', config: { coinBaseSec: 60 }, gates: [{ id: 'follow', mode: 'min', min: 1 }], legal: null, chatBonus: { enabled: false } });
    const st3 = await state(s.rt, SESS3);
    expect(st3.settings.keyword).toBeNull();
    expect(st3.status).toBe('paused');

    expect((await rows(s.pool, 'SELECT legacy_session_id, giveaway_id FROM legacy_imports ORDER BY legacy_session_id')).map((x) => x.giveaway_id)).toEqual([SESS1, SESS2, SESS3]);
    expect(await rows(s.pool, 'SELECT legacy_team_id, team_id FROM legacy_teams')).toEqual([{ legacy_team_id: 'team_chaoscrew', team_id: teamIdOf('team_chaoscrew') }]);
    expect((await rows(s.pool, 'SELECT pid FROM team_bans')).map((x) => x.pid)).toEqual([await findPidByTwitchId(s.pool, 'id-troll_t')]);
    expect((await rows(s.pool, 'SELECT pid FROM team_members ORDER BY pid')).map((x) => x.pid).sort()).toEqual([await findPidByTwitchId(s.pool, '1001'), await findPidByTwitchId(s.pool, 'id-streamer_b')].sort());
    expect(await findPidByTwitchId(s.pool, 'id-nobody_0')).toBeNull();
    expect(await findPidByTwitchId(s.pool, 'id-ghost_9')).toBeNull();
    const parts = await rows(s.pool, 'SELECT pid, registered, seen FROM giveaway_participants WHERE giveaway_id = $1', [SESS1]);
    expect(parts).toHaveLength(5);
    // Kein Login und keine Twitch-ID im Journal (Anti-Ziel 15.2).
    for (const e of await rows(s.pool, 'SELECT payload FROM events')) assertNoTwitchIdentity(e.payload);
    expect(await rows(s.pool, 'SELECT 1 FROM accounts')).toEqual([]);
  });

  it('maps a one-member team to the solo team: new account via sign_in, bans reported as not imported; an existing account keeps pid and solo team', async () => {
    const s = await setup();
    const { resolver } = stubResolver();
    const r = await run(s, soloFixture(), resolver);
    expect(r.team).toMatchObject({ kind: 'solo', teamId: soloTeamIdOf('1001'), outcome: 'created', bansSkipped: ['troll_t'] });
    const pid = await findPidByTwitchId(s.pool, '1001');
    expect(await rows(s.pool, 'SELECT pid, solo_team_id FROM accounts')).toEqual([{ pid, solo_team_id: soloTeamIdOf('1001') }]);
    expect((await state(s.rt, SESS1)).teamId).toBe(soloTeamIdOf('1001'));
    expect(await rows(s.pool, 'SELECT 1 FROM team_bans')).toEqual([]);
    expect(await rows(s.pool, 'SELECT 1 FROM legacy_teams')).toEqual([]);

    // Streamer, der sich vor dem Stichtag schon angemeldet hat: Konto und Solo-Team bleiben.
    const t = await setup();
    const existingPid = randomUUID();
    const existingSolo = randomUUID();
    await t.rt.bus.execute(t.accounts.signIn, { pid: existingPid, soloTeamId: existingSolo, user: userOf('streamer_a') }, ctx({ actor: 'system:twitch' }));
    const r2 = await run(t, soloFixture(), resolver);
    expect(r2.team).toMatchObject({ kind: 'solo', teamId: existingSolo, outcome: 'existing' });
    expect(await findPidByTwitchId(t.pool, '1001')).toBe(existingPid);
    expect((await state(t.rt, SESS1)).teamId).toBe(existingSolo);
    expect((await state(t.rt, SESS1)).settings.channels).toContain(existingPid);
  });

  it('a second run writes no event and reports team and giveaways as existing or skipped', async () => {
    const s = await setup();
    const { resolver } = stubResolver();
    await run(s, fixture(), resolver);
    const before = await eventCount(s.pool);
    const r = await run(s, fixture(), resolver);
    expect(await eventCount(s.pool)).toBe(before);
    expect(r.team).toMatchObject({ outcome: 'existing', teamId: teamIdOf('team_chaoscrew') });
    expect(r.giveaways.map((g) => g.outcome)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(r.giveaways[0]!.reason).toContain('schon übernommen');
    expect(r.failed).toBe(0);
  });

  it('dry run resolves logins, writes nothing and lists unresolved logins with seconds', async () => {
    const s = await setup();
    const { resolver, calls } = stubResolver();
    const r = await run(s, fixture(), resolver, true);
    expect(calls).toHaveLength(1);
    expect(r.team).toMatchObject({ outcome: 'would_create' });
    expect(r.giveaways.map((g) => g.outcome)).toEqual(['would_create', 'would_create', 'would_create']);
    expect(r.giveaways[0]!.unresolved).toEqual([{ login: 'ghost_9', channel: 'streamer_a', sec: 120 }]);
    expect(r.giveaways[0]!.channels[0]).toMatchObject({ login: 'streamer_a', imported: 38101, notImported: 120 });
    expect(await eventCount(s.pool)).toBe(0);
    expect(await rows(s.pool, 'SELECT 1 FROM identities')).toEqual([]);
    expect(await rows(s.pool, 'SELECT 1 FROM legacy_imports')).toEqual([]);
  });

  it('an unresolvable channel skips only that giveaway; an unresolvable member is dropped; without any member the team and its giveaways are skipped', async () => {
    const s = await setup();
    const r = await run(s, fixture(), stubResolver(['ghost_9', 'kanal_c']).resolver);
    expect(r.giveaways.map((g) => g.outcome)).toEqual(['skipped', 'created', 'created']);
    expect(r.giveaways[0]!.reason).toContain('kanal_c');
    expect(await rows(s.pool, 'SELECT 1 FROM legacy_imports')).toHaveLength(2);

    const t = await setup();
    const r2 = await run(t, fixture(), stubResolver(['streamer_b']).resolver);
    expect(r2.team).toMatchObject({ outcome: 'created', membersSkipped: ['streamer_b'] });
    expect((await rows(t.pool, 'SELECT pid FROM team_members'))).toHaveLength(1);

    const u = await setup();
    const r3 = await run(u, fixture(), stubResolver(['streamer_a', 'streamer_b']).resolver);
    expect(r3.team).toMatchObject({ outcome: 'skipped' });
    expect(r3.giveaways.map((g) => g.outcome)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(await eventCount(u.pool)).toBe(0);
  });

  it('a checksum deviation aborts before resolving; a resolver that throws aborts with helix; nothing is written either way', async () => {
    const s = await setup();
    const bad = fixture();
    bad.instances[0]!.pgWatchSum.kanal_b = 7000;
    const { resolver, calls } = stubResolver();
    const r = await run(s, bad, resolver);
    expect(r.aborted).toEqual({ code: 'checksum', message: expect.stringContaining('kanal_b') });
    expect(r.aborted!.message).toContain('200');
    expect(calls).toHaveLength(0);
    const failing: LoginResolver = { byLogin: async () => { throw new Error('Twitch Helix: helix_unreachable'); } };
    const r2 = await run(s, fixture(), failing);
    expect(r2.aborted).toEqual({ code: 'helix', message: expect.stringContaining('helix_unreachable') });
    expect(await eventCount(s.pool)).toBe(0);
    expect(await rows(s.pool, 'SELECT 1 FROM identities')).toEqual([]);
  });
});

describe('Bericht', () => {
  it('names file, dry run, team, giveaways, seconds per channel, unresolved logins, skipped and failed with sums', async () => {
    const s = await setup();
    const r = await run(s, fixture(), stubResolver().resolver, true);
    const text = renderReport('C:\\export\\team_chaoscrew.json', true, AT, r);
    expect(text).toContain('team_chaoscrew.json');
    expect(text).toContain('Probelauf');
    expect(text).toContain('Chaos Crew');
    expect(text).toContain('sess_1700000001');
    expect(text).toContain('Werwolf');
    expect(text).toContain('streamer_a');
    expect(text).toContain('38101');
    expect(text).toContain('38221');
    expect(text).toContain('ghost_9');
    expect(text).toContain('120');
    expect(text).toContain('kanal_c');
    expect(text).toContain('Giveaways: 3');
    expect(reportPathOf('C:\\export\\team_chaoscrew.json')).toBe('C:\\export\\team_chaoscrew.json.bericht.txt');

    const aborted = renderReport('x.json', false, AT, { aborted: { code: 'checksum', message: 'Kanal kanal_b: Datei 7200, Altsystem 7000, Differenz 200.' }, team: null, giveaways: [], unresolved: [], failed: 0 });
    expect(aborted).toContain('Abbruch');
    expect(aborted).toContain('Differenz 200');
  });
});
