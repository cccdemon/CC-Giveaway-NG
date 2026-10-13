import { JournalError } from './types.js';

const FORBIDDEN = /^(twitch_?id|twitch_?login|login|user_?name|display_?name)$/i;

export function assertNoTwitchIdentity(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoTwitchIdentity(v, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN.test(k)) {
      throw new JournalError('identity_in_payload', `Das Feld ${path}.${k} enthält Twitch-Daten. Ereignisse speichern nur die pid.`);
    }
    assertNoTwitchIdentity(v, `${path}.${k}`);
  }
}
