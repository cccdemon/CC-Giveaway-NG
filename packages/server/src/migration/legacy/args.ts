// Argumente des Werkzeugs migrate-legacy, rein und testbar.
import { parseArgs } from 'node:util';
import { reportPathOf } from './report.js';

export const USAGE = 'Aufruf: npm run migrate-legacy -- --file <pfad> [--dry-run] [--report <pfad>] [--only <sessionId,…>]';

export interface CliArgs {
  file: string;
  dryRun: boolean;
  /** Ziel des Berichts, Default neben der Datei. */
  report: string;
  /** Nur diese Alt-Instanzen übernehmen (Test vor dem Stichtag); leer = alle. */
  only: string[];
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: { file: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, report: { type: 'string' }, only: { type: 'string' } },
    strict: true,
  });
  if (!values.file) throw new Error(`Die Datei fehlt. ${USAGE}`);
  const only = (values.only ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return { file: values.file, dryRun: values['dry-run'] === true, report: values.report ?? reportPathOf(values.file), only };
}
