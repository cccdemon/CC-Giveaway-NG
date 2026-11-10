import { describe, expect, it } from 'vitest';
import { BACKUP_VERSION, LegacyFormatError, checkSums, loginsOf, parseBackup } from '../src/migration/legacy/format.js';
import { parseCliArgs } from '../src/migration/legacy/args.js';
import { giveawayIdOf, soloTeamIdOf, teamIdOf } from '../src/migration/legacy/ids.js';
import { helixLoginResolver } from '../src/migration/legacy/resolve.js';
import { uuidV5 } from '../src/shared/uuid.js';
import { UUID_RE } from '../src/framework/authorize.js';

import { FIXTURE_TEXT, fixture } from './helpers/legacy.js';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof LegacyFormatError ? e.code : `other:${String(e)}`;
  }
};

describe('Export v2 lesen', () => {
  it('parseBackup accepts the v2 fixture and rejects version 1, a foreign format, broken JSON and a missing instances field with the expected version in the message', () => {
    const b = fixture();
    expect(b.team.id).toBe('team_chaoscrew');
    expect(b.team.members).toHaveLength(2);
    expect(b.team.banned).toEqual(['troll_t']);
    expect(b.instances.map((i) => i.sessionId)).toEqual(['sess_1700000001', 'sess_1700000002', 'sess_1700000003']);
    expect(b.instances[0]!.participants[0]).toEqual({ login: 'viewer_1', registered: true, perChannel: { streamer_a: { watchSec: 36000.4 }, kanal_b: { watchSec: 7200 } } });
    expect(b.instances[1]!.termsText).toBeNull();

    const raw = JSON.parse(FIXTURE_TEXT) as Record<string, unknown>;
    expect(codeOf(() => parseBackup(JSON.stringify({ ...raw, version: 1 })))).toBe('wrong_version');
    expect(() => parseBackup(JSON.stringify({ ...raw, version: 1 }))).toThrow(`Version ${BACKUP_VERSION}`);
    expect(codeOf(() => parseBackup(JSON.stringify({ ...raw, format: 'other' })))).toBe('wrong_format');
    expect(codeOf(() => parseBackup('{ kaputt'))).toBe('invalid_json');
    expect(codeOf(() => parseBackup(JSON.stringify({ ...raw, instances: undefined })))).toBe('invalid_shape');
    expect(codeOf(() => parseBackup(JSON.stringify({ ...raw, team: { ...(raw.team as object), members: [{ login: 'x' }] } })))).toBe('invalid_shape');
  });

  it('checkSums is empty for the fixture, reports channel and difference when watchSec and pgWatchSum diverge, and compares the rounded sum of fractional seconds', () => {
    expect(checkSums(fixture())).toEqual([]);
    const b = fixture();
    b.instances[0]!.pgWatchSum.streamer_a = 38000;
    expect(checkSums(b)).toEqual([{ sessionId: 'sess_1700000001', channel: 'streamer_a', fileSum: 38221, pgWatchSum: 38000 }]);
    // Ein Kanal nur in pgWatchSum zählt als Abweichung (Sekunden ohne Redis-Stand). Ein fehlender pgWatchSum-Kanal gilt als 0.
    const c = fixture();
    c.instances[2]!.pgWatchSum.streamer_a = 5;
    expect(checkSums(c)).toEqual([{ sessionId: 'sess_1700000003', channel: 'streamer_a', fileSum: 0, pgWatchSum: 5 }]);
    const d = fixture();
    delete d.instances[1]!.pgWatchSum.streamer_a;
    expect(checkSums(d)).toEqual([{ sessionId: 'sess_1700000002', channel: 'streamer_a', fileSum: 90, pgWatchSum: 0 }]);
    // 36000.4 + 1800.6 + 120 + 300 = 38221.0: gerundete Summe, nicht Summe der gerundeten Einträge.
    const e = fixture();
    e.instances[0]!.participants[0]!.perChannel.streamer_a!.watchSec = 36000.6;
    expect(checkSums(e)).toEqual([]);
    e.instances[0]!.participants[0]!.perChannel.streamer_a!.watchSec = 36001.0;
    expect(checkSums(e)).toEqual([{ sessionId: 'sess_1700000001', channel: 'streamer_a', fileSum: 38222, pgWatchSum: 38221 }]);
  });

  it('loginsOf collects members, channels, participants and banned logins lowercase and unique', () => {
    expect(loginsOf(fixture())).toEqual(['ghost_9', 'kanal_b', 'kanal_c', 'nobody_0', 'streamer_a', 'streamer_b', 'troll_t', 'viewer_1', 'viewer_2', 'viewer_3', 'viewer_4']);
  });

  it('parseCliArgs reads --file, --dry-run and --report (default next to the file) and rejects a missing file', () => {
    expect(parseCliArgs(['--file', '/import/t.json'])).toEqual({ file: '/import/t.json', dryRun: false, report: '/import/t.json.bericht.txt' });
    expect(parseCliArgs(['--file', '/import/t.json', '--dry-run', '--report', '/tmp/b.txt'])).toEqual({ file: '/import/t.json', dryRun: true, report: '/tmp/b.txt' });
    expect(() => parseCliArgs([])).toThrow('Die Datei fehlt');
    expect(() => parseCliArgs(['--file', 'x', '--foo'])).toThrow();
  });

  it('uuidV5 matches the RFC 4122 example and ids are stable for the same legacy id', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
    expect(giveawayIdOf('sess_1700000001')).toBe(giveawayIdOf('sess_1700000001'));
    expect(giveawayIdOf('sess_1700000001')).not.toBe(giveawayIdOf('sess_1700000002'));
    expect(giveawayIdOf('x')).not.toBe(teamIdOf('x'));
    expect(teamIdOf('x')).not.toBe(soloTeamIdOf('x'));
    for (const id of [giveawayIdOf('sess_1'), teamIdOf('team_a'), soloTeamIdOf('1001')]) expect(id).toMatch(UUID_RE);
    expect(() => uuidV5('kein-namensraum', 'x')).toThrow();
  });

  it('helixLoginResolver resolves in chunks of 100 and keys by lowercase login; unknown logins are missing', async () => {
    const calls: string[][] = [];
    const resolver = helixLoginResolver({
      async getUsers() { return []; },
      async getUsersByLogin(logins) {
        calls.push(logins);
        return logins.filter((l) => l !== 'ghost_9').map((l) => ({ id: `id-${l}`, login: l, displayName: l.toUpperCase(), createdAt: '2020-01-01T00:00:00Z' }));
      },
    });
    const logins = [...Array.from({ length: 120 }, (_, i) => `user_${i}`), 'Ghost_9', 'Viewer_2'];
    const out = await resolver.byLogin(logins);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(100);
    expect(calls[1]).toHaveLength(22);
    expect(out.size).toBe(121);
    expect(out.get('viewer_2')).toEqual({ id: 'id-viewer_2', login: 'viewer_2', displayName: 'VIEWER_2' });
    expect(out.has('ghost_9')).toBe(false);
    expect(await resolver.byLogin([])).toEqual(new Map());
    expect(calls).toHaveLength(2);
  });

  it('helixLoginResolver.byId resolves twitch ids in chunks of 100 and keys by id', async () => {
    const calls: string[][] = [];
    const resolver = helixLoginResolver({
      async getUsersByLogin() { return []; },
      async getUsers(ids) {
        calls.push(ids);
        return ids.filter((id) => id !== '9').map((id) => ({ id, login: `user${id}`, displayName: `User ${id}`, createdAt: '2020-01-01T00:00:00Z' }));
      },
    });
    const out = await resolver.byId([...Array.from({ length: 101 }, (_, i) => String(i)), '9']);
    expect(calls.map((c) => c.length)).toEqual([100, 1]);
    expect(out.get('5')).toEqual({ id: '5', login: 'user5', displayName: 'User 5' });
    expect(out.has('9')).toBe(false);
    expect(await resolver.byId([])).toEqual(new Map());
  });
});
