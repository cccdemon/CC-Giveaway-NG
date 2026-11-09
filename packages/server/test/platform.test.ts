import { afterEach, describe, expect, it } from 'vitest';
import { loadStreamState } from '../src/framework/state.js';
import { allAdmins, noAdmins } from '../src/platform/admin.js';
import { attachPlatform, type PlatformHandlers } from '../src/platform/runtime.js';
import { PLATFORM_EVENTS, PLATFORM_STREAM, platformReducer } from '../src/platform/state.js';
import { TERMS_FALLBACK_VERSION, currentTerms } from '../src/platform/terms.js';
import { P1, P2, run, setupGiveaway } from './helpers/giveaway.js';

const ADMIN = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

async function setup(admins = allAdmins) {
  const s = await setupGiveaway();
  close = s.close;
  const platform: PlatformHandlers = attachPlatform(s.rt, { admins });
  const state = async () => {
    const c = await s.pool.connect();
    try {
      return await loadStreamState(c, s.rt.registry, PLATFORM_STREAM, platformReducer);
    } finally {
      c.release();
    }
  };
  return { ...s, platform, state };
}

describe('Plattform-Strom (NEW_DESIGN.md 5.1, 11.4)', () => {
  it('ban writes streamer_banned with reason, projects platform_bans; second ban → already_banned; unban reverses and clears the row', async () => {
    const s = await setup();
    const banned = await run(s.rt, s.platform.ban, { pid: P1, reason: 'Bot-Verhalten' }, { actor: ADMIN });
    expect(banned.ok).toBe(true);
    if (!banned.ok) return;
    expect(banned.events.map((e) => [e.type, e.reason, e.payload])).toEqual([[PLATFORM_EVENTS.banned, 'Bot-Verhalten', { pid: P1 }]]);
    expect((await s.state()).bans[P1]).toMatchObject({ reason: 'Bot-Verhalten', eventId: banned.events[0]!.id });
    const rows = await s.pool.query('SELECT pid, reason FROM platform_bans ORDER BY pid');
    expect(rows.rows).toEqual([{ pid: P1, reason: 'Bot-Verhalten' }]);
    const again = await run(s.rt, s.platform.ban, { pid: P1, reason: 'noch mal' }, { actor: ADMIN });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.rejection.code).toBe('already_banned');
    const lifted = await run(s.rt, s.platform.unban, { pid: P1, reason: 'Geklärt' }, { actor: ADMIN });
    expect(lifted.ok).toBe(true);
    if (!lifted.ok) return;
    expect(lifted.events[0]).toMatchObject({ type: PLATFORM_EVENTS.unbanned, reason: 'Geklärt', reversesEventId: banned.events[0]!.id, payload: { pid: P1 } });
    expect((await s.state()).bans[P1]).toBeUndefined();
    expect((await s.pool.query('SELECT count(*)::int AS n FROM platform_bans')).rows[0]!.n).toBe(0);
    const notBanned = await run(s.rt, s.platform.unban, { pid: P2, reason: 'x' }, { actor: ADMIN });
    expect(notBanned.ok).toBe(false);
    if (!notBanned.ok) expect(notBanned.rejection.code).toBe('not_banned');
  });

  it('warn appends a warning with reason and at; withdraw marks it withdrawn and removes it from state; unknown → warning_not_found', async () => {
    const s = await setup();
    const warned = await run(s.rt, s.platform.warn, { pid: P1, reason: 'Keyword-Spam' }, { actor: ADMIN });
    expect(warned.ok).toBe(true);
    if (!warned.ok) return;
    const warningId = warned.events[0]!.id;
    expect((await s.state()).warnings[P1]).toEqual([{ eventId: warningId, reason: 'Keyword-Spam', at: warned.events[0]!.createdAt.toISOString() }]);
    expect((await s.pool.query('SELECT pid, reason, withdrawn FROM platform_warnings')).rows).toEqual([{ pid: P1, reason: 'Keyword-Spam', withdrawn: false }]);
    const unknown = await run(s.rt, s.platform.withdrawWarning, { pid: P1, warningEventId: '999999', reason: 'x' }, { actor: ADMIN });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.rejection.code).toBe('warning_not_found');
    const withdrawn = await run(s.rt, s.platform.withdrawWarning, { pid: P1, warningEventId: warningId, reason: 'Versehen' }, { actor: ADMIN });
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;
    expect(withdrawn.events[0]).toMatchObject({ type: PLATFORM_EVENTS.warningWithdrawn, reversesEventId: warningId, payload: { pid: P1, warningEventId: warningId } });
    expect((await s.state()).warnings[P1] ?? []).toEqual([]);
    expect((await s.pool.query('SELECT withdrawn FROM platform_warnings WHERE event_id = $1', [warningId])).rows[0]).toEqual({ withdrawn: true });
  });

  it('publish_terms writes version 2 then 3 with text, platform_terms holds both, currentTerms returns the newest; empty text → invalid_terms', async () => {
    const s = await setup();
    expect(await currentTerms(s.pool)).toEqual({ version: TERMS_FALLBACK_VERSION, text: null, publishedAt: null });
    const first = await run(s.rt, s.platform.publishTerms, { text: 'Fassung zwei.' }, { actor: ADMIN });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.events[0]).toMatchObject({ type: PLATFORM_EVENTS.termsPublished, payload: { version: 2, text: 'Fassung zwei.' } });
    const second = await run(s.rt, s.platform.publishTerms, { text: 'Fassung drei.' }, { actor: ADMIN });
    expect(second.ok).toBe(true);
    expect((await s.pool.query('SELECT version, text FROM platform_terms ORDER BY version')).rows).toEqual([
      { version: 2, text: 'Fassung zwei.' },
      { version: 3, text: 'Fassung drei.' },
    ]);
    expect(await currentTerms(s.pool)).toMatchObject({ version: 3, text: 'Fassung drei.', publishedAt: expect.any(String) });
    expect((await s.state()).terms).toMatchObject({ version: 3 });
    const empty = await run(s.rt, s.platform.publishTerms, { text: '   ' }, { actor: ADMIN });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.rejection.code).toBe('invalid_terms');
  });

  it('a non-admin actor gets not_admin on every platform command, system actors too; reason is required', async () => {
    const s = await setup(noAdmins);
    const cmds = [
      () => run(s.rt, s.platform.ban, { pid: P1, reason: 'x' }, { actor: OTHER }),
      () => run(s.rt, s.platform.unban, { pid: P1, reason: 'x' }, { actor: OTHER }),
      () => run(s.rt, s.platform.warn, { pid: P1, reason: 'x' }, { actor: 'system:scheduler' }),
      () => run(s.rt, s.platform.withdrawWarning, { pid: P1, warningEventId: '1', reason: 'x' }, { actor: OTHER }),
      () => run(s.rt, s.platform.publishTerms, { text: 'x' }, { actor: OTHER }),
    ];
    for (const c of cmds) {
      const r = await c();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.rejection.code).toBe('not_admin');
    }
    const t = await setup();
    const noReason = await run(t.rt, t.platform.ban, { pid: P1, reason: '  ' }, { actor: ADMIN });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.rejection.code).toBe('reason_required');
    const badId = await run(t.rt, t.platform.warn, { pid: 'nope', reason: 'x' }, { actor: ADMIN });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.rejection.code).toBe('invalid_id');
    await s.close();
    close = t.close;
  });

  it('revert of streamer_banned writes streamer_unbanned; revert of terms_published is rejected with the none reason', async () => {
    const s = await setup();
    const banned = await run(s.rt, s.platform.ban, { pid: P1, reason: 'x' }, { actor: ADMIN });
    if (!banned.ok) throw new Error('ban');
    const reverted = await run(s.rt, s.platform.revert, { stream: PLATFORM_STREAM, eventId: banned.events[0]!.id, reason: 'Irrtum' }, { actor: ADMIN });
    expect(reverted.ok).toBe(true);
    if (reverted.ok) expect(reverted.events[0]).toMatchObject({ type: PLATFORM_EVENTS.unbanned, reversesEventId: banned.events[0]!.id });
    expect((await s.state()).bans[P1]).toBeUndefined();
    const published = await run(s.rt, s.platform.publishTerms, { text: 'Neu.' }, { actor: ADMIN });
    if (!published.ok) throw new Error('publish');
    const noRevert = await run(s.rt, s.platform.revert, { stream: PLATFORM_STREAM, eventId: published.events[0]!.id, reason: 'x' }, { actor: ADMIN });
    expect(noRevert.ok).toBe(false);
    if (!noRevert.ok) expect(noRevert.rejection.code).toBe('not_reversible');
    const foreign = await run(s.rt, s.platform.revert, { stream: PLATFORM_STREAM, eventId: banned.events[0]!.id, reason: 'x' }, { actor: OTHER });
    expect(foreign.ok).toBe(false);
  });
});
