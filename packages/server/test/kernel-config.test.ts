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
});
