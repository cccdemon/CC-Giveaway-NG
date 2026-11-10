// Argumente des Werkzeugs migrate-legacy, rein und testbar.
import { parseArgs } from 'node:util';
import { reportPathOf } from './report.js';

export const USAGE = 'Aufruf: npm run migrate-legacy -- --file <pfad> [--dry-run] [--report <pfad>]';

export interface CliArgs {
  file: string;
  dryRun: boolean;
  /** Ziel des Berichts, Default neben der Datei. */
  report: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: { file: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, report: { type: 'string' } },
    strict: true,
  });
  if (!values.file) throw new Error(`Die Datei fehlt. ${USAGE}`);
  return { file: values.file, dryRun: values['dry-run'] === true, report: values.report ?? reportPathOf(values.file) };
}
