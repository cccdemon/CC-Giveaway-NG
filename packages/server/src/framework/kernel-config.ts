import { reject, type ConfigField, type ConfigSchema, type Rejection } from '../kernel-api/index.js';

export function defaultConfig<C>(schema: ConfigSchema<C>): C {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    out[key] = (schema as Record<string, ConfigField>)[key]?.default;
  }
  return out as C;
}

function problem(field: ConfigField, value: unknown): string | null {
  switch (field.kind) {
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= field.min && value <= field.max
        ? null
        : `Erlaubt ist eine ganze Zahl von ${field.min} bis ${field.max}.`;
    case 'bool':
      return typeof value === 'boolean' ? null : 'Erlaubt ist an oder aus.';
    case 'text':
      return typeof value === 'string' && value.length <= field.maxLength
        ? null
        : `Höchstens ${field.maxLength} Zeichen.`;
  }
}

/** Fehlende Felder → Default. Unbekannte Felder → Ablehnung. Alle Fehler in einer Meldung, je Zeile „<label>: <was falsch ist>“. */
export function validateConfig<C>(schema: ConfigSchema<C>, input: unknown): { ok: true; value: C } | Rejection {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return reject('invalid_config', 'Die Einstellungen fehlen.');
  }
  const given = input as Record<string, unknown>;
  const fields = schema as Record<string, ConfigField>;
  const value: Record<string, unknown> = {};
  const lines: string[] = [];
  for (const key of Object.keys(fields)) {
    const field = fields[key];
    if (!field) continue;
    if (!Object.hasOwn(given, key)) {
      value[key] = field.default;
      continue;
    }
    const msg = problem(field, given[key]);
    if (msg) lines.push(`${field.label}: ${msg}`);
    else value[key] = given[key];
  }
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(fields, key)) lines.push(`${key}: Dieses Feld gibt es nicht.`);
  }
  if (lines.length > 0) return reject('invalid_config', lines.join('\n'));
  return { ok: true, value: value as C };
}
