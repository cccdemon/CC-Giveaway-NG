// Textregeln für UI- und Fehlertexte (NEW_DESIGN.md 11.6): kurz, aktiv, ohne Werbewörter, ohne Semikolon.
// Rein, ohne I/O. Der Linter in scripts/text-lint.ts liest damit alle Texte im Quellcode.

export const MAX_WORDS = 20;

/** Werbewörter und Floskeln, die in keinem Text stehen. Wortanfang zählt: „nahtlose“ ist „nahtlos“. */
export const BANNED_WORDS: readonly string[] = [
  'nahtlos',
  'leistungsstark',
  'revolutionär',
  'innovativ',
  'intuitiv',
  'problemlos',
  'mühelos',
  'optimal',
  'umfassend',
  'bequem',
  'einfach nur',
  'state of the art',
];

/** Vorgangspassiv: eine Form von „werden“ und im selben Satz ein Partizip (ge…t, ge…en, be…t, ver…t, …iert). */
const PASSIVE_RE = /(?<!\p{L})(?:wird|werden|wurde|wurden)(?!\p{L})[^.!?]*?(?<!\p{L})(?:ge\p{L}{2,}(?:t|en)|(?:be|ver|er|ent|zer|emp)\p{L}{3,}(?:t|en)|\p{L}{3,}iert)(?!\p{L})/iu;
/** Platzhalter einer Vorlage zählen als ein Wort. */
const HOLE_RE = /\$\{[^}]*\}/g;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const wordCount = (s: string): number => s.split(/\s+/).filter((w) => w.length > 0).length;

/** Gründe, warum ein Text die Regeln verletzt. Leer = in Ordnung. */
export function checkText(text: string): string[] {
  const reasons: string[] = [];
  const plain = text.replace(HOLE_RE, 'X').trim();
  if (sentences(plain).some((s) => wordCount(s) > MAX_WORDS)) reasons.push('zu_lang');
  if (plain.includes(';')) reasons.push('semikolon');
  for (const word of BANNED_WORDS) {
    if (new RegExp(`(?<!\\p{L})${escapeRe(word)}`, 'iu').test(plain)) reasons.push(`bannwort:${word}`);
  }
  if (PASSIVE_RE.test(plain)) reasons.push('passiv');
  if (!/[.!?]$/.test(plain)) reasons.push('satzzeichen');
  return reasons;
}

export interface UiText {
  text: string;
  line: number;
}

/**
 * Zeichenketten an UI-Stellen: reject('code', '…'), why: '…', message: '…', text: '…', emptyPool: '…' und Konstanten
 * nach der Konvention `X_TEXT = '…'`. Auch Vorlagen mit `…${…}…`.
 */
const UI_TEXT_RE = /(\breject\(\s*'[^']*'\s*,\s*|\bwhy:\s*|\bmessage:\s*|\btext:\s*|\bemptyPool:\s*|\b[A-Z][A-Z0-9_]*_TEXT\s*=\s*)(?:'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;

export function extractUiTexts(source: string): UiText[] {
  const out: UiText[] = [];
  for (const m of source.matchAll(UI_TEXT_RE)) {
    const text = m[2] ?? m[3] ?? '';
    const at = (m.index ?? 0) + m[1]!.length;
    const line = 1 + (source.slice(0, at).match(/\n/g)?.length ?? 0);
    out.push({ text: text.replace(/\\'/g, "'"), line });
  }
  return out;
}
