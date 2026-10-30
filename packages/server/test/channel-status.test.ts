import { afterEach, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { findIdentity, touchIdentities, upsertIdentity } from '../src/identity/identities.js';
import { loadChannelToken, saveChannelToken, updateChannelToken } from '../src/identity/tokens.js';
import { StatusBuffer, deleteChannelStatus, readChannelStatus, upsertChannelStatus } from '../src/ingest/channel-status.js';
import { COVERAGE_MIN, SIGNAL_STALE_MS, channelStatusView, channelWarning } from '../src/ingest/status-view.js';
import { KEY, connect, login, setupApi, type ApiSetup } from './helpers/api.js';
import { AT, freshDb } from './helpers/db.js';

let close: (() => Promise<void>) | undefined;
let s: ApiSetup | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  await s?.close();
  s = undefined;
});

const PID = '77777777-7777-4777-8777-777777777777';
const PID2 = '88888888-8888-4888-8888-888888888888';
const at = (sec: number) => new Date(AT.getTime() + sec * 1000);

describe('channel_status', () => {
  it('upsert creates a row with only the patched fields and keeps the rest on the next patch', async () => {
    const db = await freshDb();
    close = db.close;
    await upsertChannelStatus(db.pool, PID, { viewers: 12, worker: 1 }, AT);
    await upsertChannelStatus(db.pool, PID, { chatters: 9, lastSignalAt: at(5) }, at(5));
    const row = (await readChannelStatus(db.pool, [PID, PID2])).get(PID);
    expect(row).toEqual({
      pid: PID, live: false, liveSince: null, viewers: 12, chatters: 9, lastSignalAt: at(5), lastPresenceAt: null, problem: null, worker: 1, updatedAt: at(5),
    });
    expect((await readChannelStatus(db.pool, [PID2])).size).toBe(0);
    await deleteChannelStatus(db.pool, PID);
    expect((await readChannelStatus(db.pool, [PID])).size).toBe(0);
  });

  it('live true sets live_since once, live false clears it', async () => {
    const db = await freshDb();
    close = db.close;
    await upsertChannelStatus(db.pool, PID, { live: true }, AT);
    await upsertChannelStatus(db.pool, PID, { live: true, viewers: 3 }, at(60));
    let row = (await readChannelStatus(db.pool, [PID])).get(PID)!;
    expect(row.live).toBe(true);
    expect(row.liveSince).toEqual(AT);
    await upsertChannelStatus(db.pool, PID, { live: false }, at(120));
    row = (await readChannelStatus(db.pool, [PID])).get(PID)!;
    expect(row.live).toBe(false);
    expect(row.liveSince).toBeNull();
    await upsertChannelStatus(db.pool, PID, { live: true }, at(180));
    expect((await readChannelStatus(db.pool, [PID])).get(PID)!.liveSince).toEqual(at(180));
  });

  it('StatusBuffer merges patches per pid and writes each pid once', async () => {
    const db = await freshDb();
    close = db.close;
    const buf = new StatusBuffer();
    buf.note(PID, { viewers: 1, problem: 'twitch_error' });
    buf.note(PID, { viewers: 2, chatters: 5 });
    buf.note(PID2, { live: true });
    expect(await buf.flush(db.pool, AT)).toBe(2);
    expect(await buf.flush(db.pool, AT)).toBe(0);
    const rows = await readChannelStatus(db.pool, [PID, PID2]);
    expect(rows.get(PID)).toMatchObject({ viewers: 2, chatters: 5, problem: 'twitch_error' });
    expect(rows.get(PID2)).toMatchObject({ live: true, liveSince: AT });
  });

  it('channelStatusView joins accounts, tokens and status and computes coverage', async () => {
    s = await setupApi();
    const { cookie } = await login(s);
    await connect(s, cookie);
    const me = (await s.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json() as { pid: string };
    await upsertChannelStatus(s.pool, me.pid, { live: true, viewers: 100, chatters: 40, lastSignalAt: AT, problem: null }, AT);
    const [view, none] = await channelStatusView(s.pool, [me.pid, PID2], at(10));
    expect(view).toEqual({
      pid: me.pid, connected: true, tokenStatus: 'ok', live: true, liveSince: AT.toISOString(), viewers: 100, chatters: 40, coverage: 0.4,
      lastSignalAt: AT.toISOString(), problem: null, warning: { level: 'hinweis', text: 'Abdeckung unter 50 %. Twitch meldet nicht alle Zuschauer im Chat.' },
    });
    expect(none).toEqual({
      pid: PID2, connected: false, tokenStatus: 'none', live: false, liveSince: null, viewers: null, chatters: null, coverage: null, lastSignalAt: null, problem: null, warning: null,
    });
  });

  it('channelWarning: token invalid → rot, live without signal 2 min → gelb, twitch_error → gelb, coverage 0.4 → hinweis, healthy → null', () => {
    const base = { connected: true, tokenStatus: 'ok' as const, live: true, lastSignalAt: AT.toISOString(), coverage: 0.9, problem: null };
    expect(channelWarning({ ...base, tokenStatus: 'invalid' }, at(1))).toEqual({ level: 'rot', text: 'Kanal neu verbinden. Das Twitch-Token ist abgelaufen oder ein Recht fehlt.' });
    expect(channelWarning({ ...base, tokenStatus: 'none' }, at(1))!.level).toBe('rot');
    expect(channelWarning(base, new Date(AT.getTime() + SIGNAL_STALE_MS + 1))).toEqual({ level: 'gelb', text: 'Kanal neu verbinden. Seit über 2 Minuten kommt kein Signal.' });
    expect(channelWarning({ ...base, lastSignalAt: null }, at(1))!.level).toBe('gelb');
    expect(channelWarning({ ...base, live: false, lastSignalAt: null }, at(1))).toBeNull();
    expect(channelWarning({ ...base, problem: 'twitch_error' }, at(1))).toEqual({ level: 'gelb', text: 'Twitch antwortet nicht. Der Ingest versucht es weiter.' });
    expect(channelWarning({ ...base, coverage: COVERAGE_MIN - 0.1 }, at(1))!.level).toBe('hinweis');
    expect(channelWarning({ ...base, coverage: null }, at(1))).toBeNull();
    expect(channelWarning({ ...base, connected: false, tokenStatus: 'none' }, at(1))).toBeNull();
  });

  it('updateChannelToken overwrites an existing row and returns false without one', async () => {
    const db = await freshDb();
    close = db.close;
    const t = { accessToken: 'a1', refreshToken: 'r1', scopes: ['x'], expiresAt: at(3600) };
    expect(await updateChannelToken(db.pool, PID, t, KEY, AT)).toBe(false);
    await withTx(db.pool, (c) => saveChannelToken(c, PID, t, KEY, AT));
    await db.pool.query("UPDATE channel_tokens SET status = 'invalid'");
    expect(await updateChannelToken(db.pool, PID, { ...t, accessToken: 'a2', refreshToken: 'r2', expiresAt: at(7200) }, KEY, at(1))).toBe(true);
    expect(await loadChannelToken(db.pool, PID, KEY)).toEqual({ accessToken: 'a2', refreshToken: 'r2', scopes: ['x'], expiresAt: at(7200), status: 'ok' });
  });

  it('touchIdentities updates only rows older than one hour', async () => {
    const db = await freshDb();
    close = db.close;
    await withTx(db.pool, (c) => upsertIdentity(c, { id: '1', login: 'a', displayName: 'A' }, PID, AT));
    await withTx(db.pool, (c) => upsertIdentity(c, { id: '2', login: 'b', displayName: 'B' }, PID2, at(-7200)));
    expect(await touchIdentities(db.pool, [PID, PID2], at(60))).toBe(1);
    expect((await findIdentity(db.pool, PID))!.lastSeenAt).toEqual(AT);
    expect((await findIdentity(db.pool, PID2))!.lastSeenAt).toEqual(at(60));
    expect(await touchIdentities(db.pool, [], at(60))).toBe(0);
  });
});
