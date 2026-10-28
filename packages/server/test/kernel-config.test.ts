import { describe, expect, it } from 'vitest';
import type { ConfigSchema } from '../src/kernel-api/index.js';
import { defaultConfig, validateConfig } from '../src/framework/kernel-config.js';

interface Cfg {
  windowSec: number;
  announce: boolean;
  note: string;
}

const schema: ConfigSchema<Cfg> = {
  windowSec: { kind: 'int', label: 'Fensterlänge', help: 'Dauer', default: 120, min: 10, max: 3600, unit: 'sec' },
  announce: { kind: 'bool', label: 'announce', help: 'Ansage', default: true },
  note: { kind: 'text', label: 'note', help: 'Notiz', default: '', maxLength: 20 },
};
const defaults = { windowSec: 120, announce: true, note: '' };

describe('kernel-config', () => {
  it('defaultConfig liefert die Defaults', () => {
    expect(defaultConfig(schema)).toEqual(defaults);
  });

  it('leere Eingabe ergibt Defaults', () => {
    expect(validateConfig(schema, {})).toEqual({ ok: true, value: defaults });
  });

  it('sammelt alle Fehler in einer Meldung', () => {
    const r = validateConfig(schema, { windowSec: 5, announce: 'ja', note: 'x'.repeat(21), extra: 1 });
    expect(r).toEqual({
      rejected: true,
      code: 'invalid_config',
      message: [
        'Fensterlänge: Erlaubt ist eine ganze Zahl von 10 bis 3600.',
        'announce: Erlaubt ist an oder aus.',
        'note: Höchstens 20 Zeichen.',
        'extra: Dieses Feld gibt es nicht.',
      ].join('\n'),
    });
  });

  it('lehnt Kommazahlen ab', () => {
    const r = validateConfig(schema, { windowSec: 10.5 });
    expect(r).toMatchObject({ rejected: true, code: 'invalid_config' });
  });

  it('lehnt Nicht-Objekte ab', () => {
    expect(validateConfig(schema, null)).toEqual({
      rejected: true,
      code: 'invalid_config',
      message: 'Die Einstellungen fehlen.',
    });
  });

  it('übernimmt gültige Werte', () => {
    expect(validateConfig(schema, { windowSec: 30, announce: false, note: 'hi' })).toEqual({
      ok: true,
      value: { windowSec: 30, announce: false, note: 'hi' },
    });
  });
  it('lehnt Schlüssel der Prototype-Kette als unbekannt ab', () => {
    const msg = (k: string) => ({ rejected: true, code: 'invalid_config', message: k + ': Dieses Feld gibt es nicht.' });
    expect(validateConfig(schema, { constructor: 1 })).toEqual(msg('constructor'));
    expect(validateConfig(schema, JSON.parse('{"__proto__":1}'))).toEqual(msg('__proto__'));
  });

  it('lehnt NaN und Infinity ab', () => {
    expect(validateConfig(schema, { windowSec: NaN })).toMatchObject({ rejected: true });
    expect(validateConfig(schema, { windowSec: Infinity })).toMatchObject({ rejected: true });
  });

  it('nimmt die Grenzwerte an', () => {
    expect(validateConfig(schema, { windowSec: 10 })).toMatchObject({ ok: true });
    expect(validateConfig(schema, { windowSec: 3600 })).toMatchObject({ ok: true });
  });

  it('lehnt ein Array als Eingabe ab', () => {
    expect(validateConfig(schema, [])).toEqual({ rejected: true, code: 'invalid_config', message: 'Die Einstellungen fehlen.' });
  });

  it('verändert die Eingabe nicht und gibt sie nicht zurück', () => {
    const input = { windowSec: 30 };
    const r = validateConfig(schema, input);
    expect(input).toEqual({ windowSec: 30 });
    expect(r).toMatchObject({ ok: true });
    if ('ok' in r) expect(r.value).not.toBe(input);
  });
});
