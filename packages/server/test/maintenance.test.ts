import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { logRead } from '../src/audit/access-log.js';
import { findIdentity, findPidByTwitchId } from '../src/identity/identities.js';
import { identityResolver } from '../src/identity/resolver.js';
import { minuteOf } from '../src/ingest/bundler.js';
import { INACTIVE_DAYS } from '../src/identity/inactivity.js';
import { attachAccounts } from '../src/identity/runtime.js';
import { SESSION_TTL_DAYS, createSession } from '../src/identity/sessions.js';
import { runMaintenance } from '../src/scheduler/maintenance.js';
import { AT, freshDb } from './helpers/db.js';
import { ACTOR, ctx } from './helpers/fixtures.js';
import { GID, P1, createOpen, must, setupGiveaway } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const PID = '77777777-7777-4777-8777-777777777777';
const day = (n: number) => new Date(AT.getTime() + n * 86_400_000);

describe('runMaintenance', () => {
  it('creates upcoming partitions, purges old IPs and expired sessions', async () => {
    const db = await freshDb();
    close = db.close;
    await logRead(db.pool, { actor: ACTOR, action: 'a', target: 't', ip: '10.0.0.1', at: AT });
    await createSession(db.pool, PID, AT);
    await createSession(db.pool, PID, day(39));
    const res = await runMaintenance(db.pool, day(40));
    expect(res).toEqual({ partitions: ['events_y2026m11', 'events_y2026m12', 'events_y2027m01'], ipsPurged: 1, sessionsPurged: 1, accountsPurged: 0, unregisteredPurged: 0 });
    expect(SESSION_TTL_DAYS).toBeLessThan(40);
  });

  it('with a runtime it also removes inactive accounts', async () => {
    const s = await setupGiveaway();
    close = s.close;
    const accounts = attachAccounts(s.rt, { tokenKey: randomBytes(32) });
    const r = await s.rt.bus.execute(accounts.signIn, { pid: PID, soloTeamId: PID, user: { id: '1', login: 'a', displayName: 'A' } }, ctx({ actor: 'system:twitch' }));
    expect(r.ok).toBe(true);
    const res = await runMaintenance(s.pool, day(INACTIVE_DAYS + 1), { rt: s.rt, accounts });
    expect(res.accountsPurged).toBe(1);
    expect(await findIdentity(s.pool, PID)).toBeNull();
  });

  it('maintenance reports unregisteredPurged', async () => {
    const s = await setupGiveaway({ identities: identityResolver() });
    close = s.close;
    const accounts = attachAccounts(s.rt, { tokenKey: randomBytes(32) });
    await createOpen(s.rt, { kernelId: 'watchtime', settings: { prize: 'Key', channels: [P1], config: {}, counting: 'first_seen' } });
    const ghost = { id: '99', login: 'ghost', displayName: 'Ghost' };
    await must(s.rt, s.rt.handlers.applySignals, { giveawayId: GID, channel: P1, minute: minuteOf(AT), presence: [ghost], chat: [], follows: [] }, { actor: 'system:ingest' });
    await must(s.rt, s.rt.handlers.close, { giveawayId: GID });
    expect(await findPidByTwitchId(s.pool, ghost.id)).not.toBeNull();
    const res = await runMaintenance(s.pool, day(8), { rt: s.rt, accounts });
    expect(res.unregisteredPurged).toBe(1);
    expect(await findPidByTwitchId(s.pool, ghost.id)).toBeNull();
  });
});
