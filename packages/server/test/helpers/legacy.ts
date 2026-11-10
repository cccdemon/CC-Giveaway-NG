import { readFileSync } from 'node:fs';
import { parseBackup, type LegacyBackup } from '../../src/migration/legacy/format.js';

/** Export v2 nach dem Prod-Befund (Logins ersetzt): zwei Mitglieder, drei Instanzen, ein Gesperrter, ein unbekannter Login. */
export const FIXTURE_TEXT = readFileSync(new URL('../fixtures/legacy/export-v2.json', import.meta.url), 'utf8');
export const fixture = (): LegacyBackup => parseBackup(FIXTURE_TEXT);
