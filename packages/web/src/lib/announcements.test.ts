import { describe, expect, it } from 'vitest';
import { cleanAnnouncements, kindLabel, kindsForKernel, validateAnnouncements } from './announcements.js';
import type { AnnouncementKind } from './api/types.js';

export const KINDS: AnnouncementKind[] = [
  { kind: 'opened', default: 'Giveaway „{preis}“ ist offen! Schreib {keyword} in den Chat und mach mit.', placeholders: ['{preis}', '{keyword}'], kernel: null },
  { kind: 'winner', default: 'Gewinner von „{preis}“: {gewinner}! Melde dich innerhalb von {frist} Tagen.', placeholders: ['{preis}', '{gewinner}', '{frist}'], kernel: null },
  { kind: 'instant_window_opened', default: 'Anmeldefenster für „{preis}“ offen bis {bis}!', placeholders: ['{preis}', '{keyword}', '{bis}'], kernel: 'instant' },
  { kind: 'tickets_bought', default: 'Tickets!', placeholders: ['{preis}'], kernel: 'tickets' },
];

describe('announcements', () => {
  it('kindsForKernel keeps framework kinds and only the chosen kernel; kindLabel names known kinds', () => {
    expect(kindsForKernel(KINDS, 'instant').map((k) => k.kind)).toEqual(['opened', 'winner', 'instant_window_opened']);
    expect(kindsForKernel(KINDS, null).map((k) => k.kind)).toEqual(['opened', 'winner']);
    expect(kindLabel('opened')).toBe('Geöffnet');
    expect(kindLabel('instant_window_opened')).toBe('Anmeldefenster offen');
    expect(kindLabel('unknown_kind')).toBe('unknown_kind');
  });

  it('validateAnnouncements rejects a link, an unknown placeholder, an overlong template and an empty winner text', () => {
    const base = { muted: false, links: true };
    expect(validateAnnouncements({ ...base, texts: { opened: 'Los {preis} {keyword}' } }, KINDS, 'instant')).toEqual({});
    expect(validateAnnouncements({ ...base, texts: { opened: 'Siehe https://x.example' } }, KINDS, 'instant')).toEqual({ opened: expect.stringContaining('Links') });
    expect(validateAnnouncements({ ...base, texts: { opened: 'Gewinner {gewinner}' } }, KINDS, 'instant')).toEqual({ opened: expect.stringContaining('{gewinner}') });
    expect(validateAnnouncements({ ...base, texts: { opened: 'x'.repeat(401) } }, KINDS, 'instant')).toEqual({ opened: expect.stringContaining('400') });
    expect(validateAnnouncements({ ...base, texts: { winner: '   ' } }, KINDS, 'instant')).toEqual({ winner: expect.any(String) });
    expect(validateAnnouncements({ ...base, texts: { paused: '' } }, KINDS, 'instant')).toEqual({});
    // Ohne Katalog keine Platzhalter-Prüfung, Link und Länge bleiben.
    expect(validateAnnouncements({ ...base, texts: { opened: '{irgendwas}' } }, [], 'instant')).toEqual({});
    expect(validateAnnouncements({ ...base, texts: { opened: 'http://x' } }, [], 'instant')).toHaveProperty('opened');
  });

  it('cleanAnnouncements drops empty templates and trims the rest', () => {
    expect(cleanAnnouncements({ muted: true, links: false, texts: { opened: '  Los  ', paused: '   ' } })).toEqual({ muted: true, links: false, texts: { opened: 'Los' } });
  });
});
