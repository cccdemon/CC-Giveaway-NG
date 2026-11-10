import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from './api/types.js';
import { historyText } from './history-text.js';

const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const CAROL = 'cccccccc-0000-4000-8000-000000000003';
const CHANNEL = 'aaaaaaaa-0000-4000-8000-000000000001';
const GONE = 'dddddddd-0000-4000-8000-000000000004';
const names = { [BOB]: 'Bob', [CAROL]: 'Carol', [CHANNEL]: 'kanal_nord' };

const entry = (type: string, payload: unknown): HistoryEntry => ({
  id: 'e',
  seq: 1,
  type,
  at: '2026-10-15T12:00:00.000Z',
  actor: { kind: 'system', name: 'ingest' },
  reason: null,
  reversesEventId: null,
  reverted: false,
  reversal: { kind: 'compensate' },
  payload,
});

describe('historyText', () => {
  it('renders German sentences for registered, withdrawn, status change, corrected, drawn, voided, boost and tickets', () => {
    expect(historyText(entry('participant_registered', { pid: BOB }), names, false)).toBe('Bob hat sich angemeldet.');
    expect(historyText(entry('participant_withdrawn', { pid: BOB }), names, false)).toBe('Bob hat die Teilnahme zurückgezogen.');
    expect(historyText(entry('giveaway_status_changed', { from: 'open', to: 'paused' }), names, false)).toBe('Giveaway pausiert.');
    expect(historyText(entry('giveaway_status_changed', { from: 'draft', to: 'open' }), names, false)).toBe('Giveaway geöffnet.');
    expect(historyText(entry('watch_corrected', { channel: CHANNEL, entries: [{ pid: BOB, sec: 1800 }] }), names, false)).toBe('Zeit von Bob bei kanal_nord um +30 min korrigiert.');
    expect(historyText(entry('watch_corrected', { channel: CHANNEL, entries: [{ pid: BOB, sec: -45 }] }), names, false)).toBe('Zeit von Bob bei kanal_nord um -45 s korrigiert.');
    expect(historyText(entry('giveaway_drawn', { winners: [BOB, CAROL], pool: [], gates: [], excluded: [] }), names, false)).toBe('Gezogen: Bob, Carol.');
    expect(historyText(entry('event_voided', { targetType: 'giveaway_drawn' }), names, false)).toBe('Aufgehoben: Ziehung.');
    expect(historyText(entry('boost_started', { factor: 2, until: '2026-10-15T13:15:00.000Z' }), names, false)).toMatch(/^Boost ×2 gestartet, bis \d+\. Okt\., \d\d:15\.$/);
    expect(historyText(entry('boost_ended', {}), names, false)).toBe('Boost beendet.');
    expect(historyText(entry('tickets_bought', { pid: BOB, count: 3, coins: 30 }), names, false)).toBe('Bob kauft 3 Tickets für 30 Coins.');
    expect(historyText(entry('watch_credited', { minute: 'm', channel: CHANNEL, factor: 2, entries: [{ pid: BOB, sec: 60 }, { pid: CAROL, sec: 60 }] }), names, false)).toBe('Zuschauzeit bei kanal_nord: 2 Personen, 4 min.');
    expect(historyText(entry('winner_status_set', { pid: BOB, from: 'pending', to: 'shipped' }), names, false)).toBe('Gewinn von Bob: versendet.');
    expect(historyText(entry('giveaway_settings_changed', { before: { prize: 'A', keyword: null }, after: { prize: 'B', keyword: null } }), names, false)).toBe('Regeln geändert: Gewinn.');
    expect(historyText(entry('instant_window_opened', { until: '2026-10-15T12:02:00.000Z' }), names, false)).toMatch(/^Anmeldefenster offen bis \d+\. Okt\., \d\d:02\.$/);
  });

  it('masks participant names in streamer mode but not channel names, and names deleted participants', () => {
    expect(historyText(entry('participant_registered', { pid: BOB }), names, true)).toBe('Teilnehmer ·bbbb hat sich angemeldet.');
    expect(historyText(entry('watch_corrected', { channel: CHANNEL, entries: [{ pid: BOB, sec: 60 }] }), names, true)).toBe('Zeit von Teilnehmer ·bbbb bei kanal_nord um +1 min korrigiert.');
    expect(historyText(entry('participant_registered', { pid: GONE }), names, false)).toBe('gelöschter Teilnehmer #dddddddd hat sich angemeldet.');
  });

  it('announcement_sent renders sent and failed announcements with kind label and channel name', () => {
    expect(historyText(entry('announcement_sent', { kind: 'opened', channel: CHANNEL, triggerEventId: '1', ok: true, messageId: 'm' }), names, true)).toBe('Ansage „Geöffnet“ bei kanal_nord gesendet.');
    expect(historyText(entry('announcement_sent', { kind: 'winner', channel: CHANNEL, triggerEventId: '1', ok: false, error: 'helix_ratelimited' }), names, false)).toBe('Ansage „Gewinner“ bei kanal_nord fehlgeschlagen: Twitch bremst den Bot.');
    expect(historyText(entry('announcement_sent', { kind: 'winner', channel: CHANNEL, triggerEventId: '1', ok: false, error: 'odd_code' }), names, false)).toBe('Ansage „Gewinner“ bei kanal_nord fehlgeschlagen: odd_code.');
  });

  it('falls back to type and payload keys for unknown types', () => {
    expect(historyText(entry('legacy_imported', { entries: [], a: 1 }), names, false)).toBe('legacy_imported: entries, a.');
    expect(historyText(entry('weird', null), names, false)).toBe('weird.');
  });
});
