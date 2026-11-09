import { describe, expect, it } from 'vitest';
import { BANNED_WORDS, MAX_WORDS, checkText, extractUiTexts } from '../src/shared/text-rules.js';

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
    ].join('\n');
    expect(extractUiTexts(src)).toEqual([
      { text: 'Melde dich an.', line: 2 },
      { text: 'Bleibt so.', line: 3 },
      { text: 'Dir fehlen ${n} Coins für ${count} Tickets.', line: 4 },
      { text: 'Twitch antwortet nicht.', line: 5 },
      { text: 'Auf zwei Zeilen.', line: 10 },
    ]);
  });
});
