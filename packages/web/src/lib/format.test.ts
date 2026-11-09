import { describe, expect, it } from 'vitest';
import { date, dateTime, duration, number, percent, relative } from './format.js';

describe('format (de-DE)', () => {
  it('percent formats 0.0023 as "0,23 %" and null as "–"', () => {
    // Intl setzt ein geschütztes Leerzeichen vor das Prozentzeichen.
    expect(percent(0.0023)).toBe('0,23 %');
    expect(percent(1)).toBe('100,00 %');
    expect(percent(null)).toBe('–');
  });

  it('duration renders 0, 37 min, 1 h 23 min, 100 h', () => {
    expect(duration(0)).toBe('0 min');
    expect(duration(37 * 60 + 59)).toBe('37 min');
    expect(duration(83 * 60)).toBe('1 h 23 min');
    expect(duration(100 * 3600)).toBe('100 h');
    expect(duration(-5)).toBe('0 min');
  });

  it('relative renders seconds, minutes, hours and days in German', () => {
    const now = new Date('2026-10-15T12:00:00Z');
    expect(relative('2026-10-15T11:59:52Z', now)).toBe('vor 8 s');
    expect(relative('2026-10-15T11:54:00Z', now)).toBe('vor 6 min');
    expect(relative('2026-10-15T09:00:00Z', now)).toBe('vor 3 h');
    expect(relative('2026-10-12T12:00:00Z', now)).toBe('vor 3 Tagen');
    expect(relative('2026-10-14T12:00:00Z', now)).toBe('vor 1 Tag');
    expect(relative('2026-10-15T12:00:03Z', now)).toBe('gerade eben');
  });

  it('dateTime and date use the German short form, number groups thousands', () => {
    expect(dateTime('2026-10-04T16:02:00Z', 'UTC')).toBe('4. Okt., 16:02');
    expect(date('2026-09-30T10:00:00Z', 'UTC')).toBe('30. Sep. 2026');
    expect(number(4812)).toBe('4.812');
  });
});
