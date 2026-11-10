import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANNOUNCEMENT_SENT } from '../src/framework/giveaway/announcements.js';
import { giveawayStream } from '../src/framework/giveaway/state.js';
import { LocalBus } from '../src/framework/subscriber.js';
import { Announcer } from '../src/ingest/announcer.js';
import type { ChannelRef, IngestAdapter, SendResult } from '../src/ingest/signals.js';
import { AT } from './helpers/db.js';
import { GID, P1, P2, P3, createOpen, must, setupGiveaway } from './helpers/giveaway.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const PUBLIC_URL = 'https://giveaway.example.org/';
const LINK = `https://giveaway.example.org/g/${GID}`;
const ref = (pid: string, owned = true): ChannelRef => ({ pid, twitchId: `tw-${pid.slice(0, 2)}`, watch: 'full', owned });

function fakeAdapter(reply: (channel: ChannelRef, text: string) => SendResult | Promise<SendResult>) {
  const sent: { channel: string; text: string }[] = [];
  const adapter: IngestAdapter = {
    start: async () => {},
    stop: async () => {},
    onSignal: () => {},
    sendChat: async (channel, text) => {
      sent.push({ channel: channel.pid, text });
      return reply(channel, text);
    },
    checkFollows: async () => [],
    health: () => [],
    close: async () => {},
  };
  return { adapter, sent };
}

async function setup(o: { channels?: ChannelRef[]; reply?: (channel: ChannelRef, text: string) => SendResult | Promise<SendResult>; announcements?: unknown } = {}) {
  const bus = new LocalBus();
  const s = await setupGiveaway({ publisher: bus });
  close = s.close;
  const fake = fakeAdapter(o.reply ?? (() => ({ ok: true, messageId: 'm' })));
  const log = { error: vi.fn() };
  const announcer = new Announcer({
    pool: s.pool, rt: s.rt, adapter: fake.adapter, directory: { current: () => o.channels ?? [ref(P1), ref(P2)] }, publicUrl: PUBLIC_URL, log, now: () => AT,
  });
  const recorded = async () => {
    const r = await s.pool.query<{ payload: Record<string, unknown> }>('SELECT payload FROM events WHERE stream = $1 AND type = $2 ORDER BY seq', [giveawayStream(GID), ANNOUNCEMENT_SENT]);
    return r.rows.map((x) => x.payload);
  };
  return { ...s, bus, announcer, sent: fake.sent, log, recorded };
}

describe('Announcer', () => {
  it('sends the opened announcement to the owned channels of an open giveaway with the link and records announcement_sent per channel', async () => {
    const s = await setup();
    await must(s.rt, s.rt.handlers.create, { giveawayId: GID, teamId: '55555555-5555-4555-8555-555555555555', kernelId: 'instant', settings: { prize: 'Key', channels: [P1, P2] } });
    const opened = await must(s.rt, s.rt.handlers.open, { giveawayId: GID });
    const r = await s.announcer.handle(giveawayStream(GID), opened);
    expect(r).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(s.sent).toEqual([
      { channel: P1, text: `Giveaway „Key“ ist offen! Mach im Portal mit. ${LINK}` },
      { channel: P2, text: `Giveaway „Key“ ist offen! Mach im Portal mit. ${LINK}` },
    ]);
    const statusEvent = opened.find((e) => e.type === 'giveaway_status_changed')!;
    expect(await s.recorded()).toEqual([
      { kind: 'opened', channel: P1, triggerEventId: statusEvent.id, ok: true, messageId: 'm' },
      { kind: 'opened', channel: P2, triggerEventId: statusEvent.id, ok: true, messageId: 'm' },
    ]);
    expect(s.log.error).not.toHaveBeenCalled();
  });

  it('does not send for channels another worker owns or outside the giveaway, and sends once per event and channel even if the bus delivers twice', async () => {
    const s = await setup({ channels: [ref(P1), ref(P2, false), ref(P3)] });
    await must(s.rt, s.rt.handlers.create, { giveawayId: GID, teamId: '55555555-5555-4555-8555-555555555555', kernelId: 'instant', settings: { prize: 'Key', keyword: '!go', channels: [P1, P2] } });
    const opened = await must(s.rt, s.rt.handlers.open, { giveawayId: GID });
    expect(await s.announcer.handle(giveawayStream(GID), opened)).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(await s.announcer.handle(giveawayStream(GID), opened)).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(s.sent).toEqual([{ channel: P1, text: `Giveaway „Key“ ist offen! Schreib !go in den Chat und mach mit. ${LINK}` }]);
    expect(await s.recorded()).toHaveLength(1);
    expect(await s.announcer.handle('team:55555555-5555-4555-8555-555555555555', opened)).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(await s.announcer.handle(giveawayStream('66666666-6666-4666-8666-000000000000'), opened)).toEqual({ sent: 0, failed: 0, skipped: 0 });
  });

  it('muted giveaway: no announcement for pause, resume and close, but the winner announcement is sent with display names', async () => {
    const s = await setup({ channels: [ref(P1)] });
    await s.pool.query('INSERT INTO identities (pid, twitch_id, login, display_name, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $5)', [P3, '4242', 'carol', 'Carol', AT]);
    await must(s.rt, s.rt.handlers.create, {
      giveawayId: GID, teamId: '55555555-5555-4555-8555-555555555555', kernelId: 'instant',
      settings: { prize: 'Key', channels: [P1], claimDays: 7, announcements: { muted: true, links: false, texts: {} } },
    });
    const stream = giveawayStream(GID);
    const opened = await must(s.rt, s.rt.handlers.open, { giveawayId: GID });
    const paused = await must(s.rt, s.rt.handlers.pause, { giveawayId: GID });
    const resumed = await must(s.rt, s.rt.handlers.resume, { giveawayId: GID });
    const window = await must(s.rt, s.rt.handlers.kernelCommand, { giveawayId: GID, command: { type: 'open_window', args: {} } });
    const registered = await must(s.rt, s.rt.handlers.register, { giveawayId: GID, pid: P3 }, { actor: `user:${P3}` });
    const closed = await must(s.rt, s.rt.handlers.close, { giveawayId: GID });
    for (const events of [opened, paused, resumed, window, registered, closed]) {
      expect(await s.announcer.handle(stream, events)).toEqual({ sent: 0, failed: 0, skipped: 0 });
    }
    const drawn = await must(s.rt, s.rt.handlers.draw, { giveawayId: GID });
    expect(await s.announcer.handle(stream, drawn)).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(s.sent).toEqual([{ channel: P1, text: 'Gewinner von „Key“: Carol! Herzlichen Glückwunsch. Melde dich innerhalb von 7 Tagen.' }]);
    expect(await s.recorded()).toMatchObject([{ kind: 'winner', channel: P1, ok: true }]);
  });

  it('a failing or throwing sendChat records announcement_sent with ok false and the reason; the run continues', async () => {
    const s = await setup({
      reply: (channel) => {
        if (channel.pid === P1) return { ok: false, reason: 'helix_ratelimited' };
        throw new Error('boom');
      },
    });
    await must(s.rt, s.rt.handlers.create, { giveawayId: GID, teamId: '55555555-5555-4555-8555-555555555555', kernelId: 'instant', settings: { prize: 'Key', channels: [P1, P2] } });
    const opened = await must(s.rt, s.rt.handlers.open, { giveawayId: GID });
    expect(await s.announcer.handle(giveawayStream(GID), opened)).toEqual({ sent: 0, failed: 2, skipped: 0 });
    expect(await s.recorded()).toMatchObject([
      { kind: 'opened', channel: P1, ok: false, error: 'helix_ratelimited' },
      { kind: 'opened', channel: P2, ok: false, error: 'send_failed' },
    ]);
    // Einmal für den werfenden Adapter, einmal für die abgelehnte Nachricht mit Code.
    expect(s.log.error).toHaveBeenCalledTimes(2);
  });

  it('instant window_opened uses the kernel default with {bis} in Berlin time; unknown event types produce nothing', async () => {
    const s = await setup({ channels: [ref(P1)] });
    await createOpen(s.rt);
    const window = await must(s.rt, s.rt.handlers.kernelCommand, { giveawayId: GID, command: { type: 'open_window', args: {} } });
    expect(await s.announcer.handle(giveawayStream(GID), window)).toEqual({ sent: 1, failed: 0, skipped: 0 });
    // AT = 12:00Z, Fenster 120 s, Europe/Berlin im Oktober = UTC+2.
    expect(s.sent).toEqual([{ channel: P1, text: `Anmeldefenster für „Key“ offen bis 14:02! Mach mit: im Portal. ${LINK}` }]);
    const registered = await must(s.rt, s.rt.handlers.register, { giveawayId: GID, pid: P3 }, { actor: `user:${P3}` });
    expect(await s.announcer.handle(giveawayStream(GID), registered)).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(s.sent).toHaveLength(1);
  });

  it('attach subscribes to every stream of the bus and handles bundles in order; idle waits for them', async () => {
    const s = await setup({ channels: [ref(P1)] });
    const stop = s.announcer.attach(s.bus);
    await createOpen(s.rt);
    await s.announcer.idle();
    expect(s.sent).toEqual([{ channel: P1, text: `Giveaway „Key“ ist offen! Mach im Portal mit. ${LINK}` }]);
    // Der eigene Nachweis (announcement_sent) löst keine weitere Ansage aus.
    expect(await s.recorded()).toHaveLength(1);
    stop();
    await must(s.rt, s.rt.handlers.pause, { giveawayId: GID });
    await s.announcer.idle();
    expect(s.sent).toHaveLength(1);
  });
});
