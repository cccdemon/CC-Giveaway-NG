import { describe, expect, it } from 'vitest';
import {
  ANNOUNCEMENT_DEFAULTS,
  DEFAULTS,
  FRAMEWORK_KINDS,
  MESSAGE_MAX,
  PLACEHOLDERS,
  kindsFor,
  planAnnouncement,
  renderAnnouncement,
  validateAnnouncements,
} from '../src/framework/giveaway/announcements.js';
import { defaultKernels } from '../src/framework/kernel-registry.js';
import { isRejection } from '../src/shared/rejection.js';
import { GID, P1, P2 } from './helpers/giveaway.js';

const kernels = defaultKernels();
const instant = kernels.get('instant');
const watchtime = kernels.get('watchtime');
const names = { [P1]: 'Bob', [P2]: 'Carol' };
const base = { id: GID, prize: 'Spielepaket', keyword: '!herbst', claimDays: 14, announcements: ANNOUNCEMENT_DEFAULTS, kernel: instant, publicUrl: 'https://g.example' };
const ev = (type: string, payload: unknown) => ({ type, payload });

describe('Chat-Ansagen (NEW_DESIGN.md 10.3)', () => {
  it('renderAnnouncement replaces {preis}, {keyword}, {gewinner}, {frist}, {faktor}, {dauer}, {bis}, appends the link and cuts at 500', () => {
    expect(renderAnnouncement('Giveaway {preis}: schreib {keyword}.', { prize: 'Key', keyword: '!go' })).toBe('Giveaway Key: schreib !go.');
    expect(renderAnnouncement('Gewinner: {gewinner}. Frist {frist} Tage.', { prize: 'Key', keyword: null, winners: ['Bob', 'Carol'], claimDays: 14 })).toBe('Gewinner: Bob, Carol. Frist 14 Tage.');
    expect(renderAnnouncement('Boost ×{faktor} für {dauer}!', { prize: 'Key', keyword: null, factor: 2, durationSec: 900 })).toBe('Boost ×2 für 15 min!');
    expect(renderAnnouncement('Offen bis {bis}.', { prize: 'Key', keyword: null, until: '2026-10-15T12:02:00.000Z' })).toBe('Offen bis 14:02.');
    expect(renderAnnouncement('Schreib {keyword}.', { prize: 'Key', keyword: null })).toBe('Schreib im Portal.');
    expect(renderAnnouncement('Los!', { prize: 'Key', keyword: null, link: 'https://g.example/g/1' })).toBe('Los! https://g.example/g/1');
    const long = renderAnnouncement('x'.repeat(480), { prize: 'Key', keyword: null, link: 'https://g.example/g/1' });
    expect(long.length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(long.endsWith('https://g.example/g/1')).toBe(true);
  });

  it('planAnnouncement maps status changes, draws and boosts to kinds; muted suppresses all but winner; winner uses display names, never pids', () => {
    expect(planAnnouncement(ev('giveaway_status_changed', { from: 'draft', to: 'open' }), base, names)).toEqual({
      kind: 'opened',
      text: `${renderAnnouncement(DEFAULTS.opened.text, { prize: 'Spielepaket', keyword: '!herbst' })} https://g.example/g/${GID}`,
    });
    expect(planAnnouncement(ev('giveaway_status_changed', { from: 'paused', to: 'open' }), base, names)?.kind).toBe('resumed');
    expect(planAnnouncement(ev('giveaway_status_changed', { from: 'open', to: 'paused' }), base, names)?.kind).toBe('paused');
    expect(planAnnouncement(ev('giveaway_status_changed', { from: 'open', to: 'closed' }), base, names)?.kind).toBe('closed');
    expect(planAnnouncement(ev('giveaway_status_changed', { from: 'open', to: 'cancelled' }), base, names)).toBeNull();
    expect(planAnnouncement(ev('boost_started', { factor: 3, until: '2026-10-15T12:30:00.000Z' }), { ...base, boostDurationSec: 1800 }, names)?.kind).toBe('boost_started');
    expect(planAnnouncement(ev('boost_ended', {}), base, names)?.kind).toBe('boost_ended');
    const winner = planAnnouncement(ev('giveaway_drawn', { winners: [P1, P2], pool: [], gates: [], excluded: [] }), base, names);
    expect(winner?.kind).toBe('winner');
    expect(winner?.text).toContain('Bob, Carol');
    expect(winner?.text).not.toContain(P1);
    const muted = { ...base, announcements: { ...ANNOUNCEMENT_DEFAULTS, muted: true } };
    expect(planAnnouncement(ev('giveaway_status_changed', { from: 'draft', to: 'open' }), muted, names)).toBeNull();
    expect(planAnnouncement(ev('giveaway_drawn', { winners: [P1], pool: [], gates: [], excluded: [] }), muted, names)?.kind).toBe('winner');
    const noLink = { ...base, announcements: { ...ANNOUNCEMENT_DEFAULTS, links: false } };
    expect(planAnnouncement(ev('giveaway_status_changed', { from: 'draft', to: 'open' }), noLink, names)?.text).not.toContain('https://');
    expect(planAnnouncement(ev('participant_registered', { pid: P1 }), base, names)).toBeNull();
  });

  it('planAnnouncement falls back to the without-keyword default and renders {keyword} as „im Portal“ in own templates', () => {
    const noKeyword = { ...base, keyword: null };
    const opened = planAnnouncement(ev('giveaway_status_changed', { from: 'draft', to: 'open' }), noKeyword, names);
    expect(opened?.text.startsWith(DEFAULTS.opened.withoutKeyword!.replace('{preis}', 'Spielepaket'))).toBe(true);
    const own = { ...noKeyword, announcements: { ...ANNOUNCEMENT_DEFAULTS, links: false, texts: { opened: 'Jetzt {keyword} tippen.' } } };
    expect(planAnnouncement(ev('giveaway_status_changed', { from: 'draft', to: 'open' }), own, names)?.text).toBe('Jetzt im Portal tippen.');
  });

  it('validateAnnouncements rejects links, unknown placeholders, over-long templates, empty winner text and a muted winner; accepts kernel kinds', () => {
    const ok = validateAnnouncements({ muted: true, links: false, texts: { opened: 'Los, {preis}!', instant_window_opened: 'Fenster bis {bis} für {preis}.' } }, instant);
    expect(isRejection(ok)).toBe(false);
    const link = validateAnnouncements({ ...ANNOUNCEMENT_DEFAULTS, texts: { opened: 'Siehe https://x.example' } }, instant);
    expect(link).toMatchObject({ code: 'invalid_announcement' });
    const unknown = validateAnnouncements({ ...ANNOUNCEMENT_DEFAULTS, texts: { opened: 'Hallo {name}' } }, instant);
    expect(unknown).toMatchObject({ code: 'invalid_announcement' });
    const wrongKind = validateAnnouncements({ ...ANNOUNCEMENT_DEFAULTS, texts: { closed: 'Gewinner {gewinner}' } }, instant);
    expect(wrongKind).toMatchObject({ code: 'invalid_announcement' });
    const long = validateAnnouncements({ ...ANNOUNCEMENT_DEFAULTS, texts: { opened: 'x'.repeat(401) } }, instant);
    expect(long).toMatchObject({ code: 'invalid_announcement' });
    const emptyWinner = validateAnnouncements({ ...ANNOUNCEMENT_DEFAULTS, texts: { winner: '   ' } }, instant);
    expect(emptyWinner).toMatchObject({ code: 'invalid_announcement' });
    const foreignKind = validateAnnouncements({ ...ANNOUNCEMENT_DEFAULTS, texts: { instant_window_opened: 'x' } }, watchtime);
    expect(foreignKind).toMatchObject({ code: 'invalid_announcement' });
    expect(validateAnnouncements(undefined, instant)).toEqual(ANNOUNCEMENT_DEFAULTS);
    expect(validateAnnouncements({ muted: 'ja' }, instant)).toMatchObject({ code: 'invalid_announcement' });
  });

  it('kindsFor lists framework kinds plus instant window kinds with defaults', () => {
    const kinds = kindsFor(instant);
    expect(kinds.map((k) => k.kind)).toEqual([...FRAMEWORK_KINDS, 'instant_window_opened', 'instant_window_closed']);
    expect(kinds.find((k) => k.kind === 'winner')).toEqual({ kind: 'winner', default: DEFAULTS.winner.text, placeholders: PLACEHOLDERS.winner, kernel: null });
    expect(kinds.find((k) => k.kind === 'instant_window_opened')).toMatchObject({ kernel: 'instant', placeholders: ['{preis}', '{keyword}', '{bis}'] });
    expect(kindsFor(watchtime).map((k) => k.kind)).toEqual([...FRAMEWORK_KINDS]);
    for (const k of kindsFor(instant)) expect(k.default).not.toMatch(/https?:\/\//);
  });
});
