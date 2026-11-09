import { describe, expect, it } from 'vitest';
import { BANNED_WORDS, LABEL_MAX_WORDS, MAX_WORDS, checkLabel, checkText, extractAllStrings, extractUiTexts } from '../src/shared/text-rules.js';

const words = (n: number) => Array.from({ length: n }, (_, i) => `Wort${i + 1}`).join(' ');

describe('Textregeln (NEW_DESIGN.md 11.6)', () => {
  it('checkText flags 21 words, a semicolon, a banned word, passive voice and a missing end mark; accepts project texts', () => {
    expect(MAX_WORDS).toBe(20);
    expect(BANNED_WORDS).toContain('nahtlos');
    expect(checkText('Melde dich zuerst an.')).toEqual([]);
    expect(checkText('Dieses Giveaway gehört nicht zu deinem Team.')).toEqual([]);
    expect(checkText('Höchstens ${max} Tickets je Person. Du hast ${have}.')).toEqual([]);
    expect(checkText('Der Topf hat sich geändert. Ziehe erneut.')).toEqual([]);
    expect(checkText('Du bist in diesem Team gesperrt.')).toEqual([]);
    expect(checkText(`${words(20)}.`)).toEqual([]);
    expect(checkText(`${words(21)}.`)).toEqual(['zu_lang']);
    expect(checkText(`Kurz. ${words(21)}.`)).toEqual(['zu_lang']);
    expect(checkText('Erst prüfen; dann ziehen.')).toEqual(['semikolon']);
    expect(checkText('Die nahtlose Verbindung steht.')).toEqual(['bannwort:nahtlos']);
    expect(checkText('Das Giveaway wird gerade geprüft.')).toEqual(['passiv']);
    expect(checkText('Der Boost wurde beendet. Starte einen neuen Boost.')).toEqual(['passiv']);
    expect(checkText('Die Daten werden exportiert.')).toEqual(['passiv']);
    expect(checkText('Melde dich an')).toEqual(['satzzeichen']);
    expect(checkText('Fertig!')).toEqual([]);
    expect(checkText('Weiter?')).toEqual([]);
    expect(checkText(`${words(21)}; weiter`)).toEqual(['zu_lang', 'semikolon', 'satzzeichen']);
  });

  it('extractUiTexts finds reject messages, why, message and text literals with line numbers, including template strings', () => {
    const src = [
      "import { reject } from './x.js';",
      "const a = reject('x', 'Melde dich an.');",
      "registry.register({ reversal: { kind: 'none', why: 'Bleibt so.' } });",
      'const m = { message: `Dir fehlen ${n} Coins für ${count} Tickets.` };',
      "const t = { text: 'Twitch antwortet nicht.' };",
      "const other = 'kein UI-Text';",
      "const label = { label: 'Coin-Basis' };",
      "return reject(\n  'two_lines',\n  'Auf zwei Zeilen.',\n);",
      "const display = { emptyPool: 'Niemand ist angemeldet.' };",
      "const TOO_LATE_TEXT = 'Nach der Ziehung geht das nicht mehr.';",
      "export const SELF_TEXT = 'Nur du selbst.';",
    ].join('\n');
    expect(extractUiTexts(src)).toEqual([
      { text: 'Melde dich an.', line: 2 },
      { text: 'Bleibt so.', line: 3 },
      { text: 'Dir fehlen ${n} Coins für ${count} Tickets.', line: 4 },
      { text: 'Twitch antwortet nicht.', line: 5 },
      { text: 'Auf zwei Zeilen.', line: 10 },
      { text: 'Niemand ist angemeldet.', line: 12 },
      { text: 'Nach der Ziehung geht das nicht mehr.', line: 13 },
      { text: 'Nur du selbst.', line: 14 },
    ]);
  });
});

describe('Beschriftungen und ganze Dateien (Teilprojekt 8b)', () => {
  it('checkLabel allows a label without a period, rejects a semicolon, a banned word and 7 words', () => {
    expect(LABEL_MAX_WORDS).toBe(6);
    expect(checkLabel('Giveaway starten')).toEqual([]);
    expect(checkLabel('Weiter: Rechtstexte')).toEqual([]);
    expect(checkLabel(words(6))).toEqual([]);
    expect(checkLabel(words(7))).toEqual(['zu_lang']);
    expect(checkLabel('Erst prüfen; dann ziehen')).toEqual(['semikolon']);
    expect(checkLabel('Die nahtlose Verbindung')).toEqual(['bannwort:nahtlos']);
  });

  it('extractAllStrings finds single- and backtick-quoted strings with line numbers, skips import lines and comments', () => {
    const src = [
      "import { x } from './x.js';",
      "// 'Kommentar' bleibt draußen",
      '/* `auch` dieser */',
      'export const L = {',
      "  a: 'Giveaway starten',",
      '  b: (n: number) => `Noch ${n} Tage`,',
      "  c: 'Mit \\'Zitat\\'',",
      '};',
    ].join('\n');
    expect(extractAllStrings(src)).toEqual([
      { text: 'Giveaway starten', line: 5 },
      { text: 'Noch ${n} Tage', line: 6 },
      { text: "Mit 'Zitat'", line: 7 },
    ]);
  });
});
