// Deutscher Text-Linter (NEW_DESIGN.md 11.6, 12.2): prüft alle UI- und Fehlertexte. Exit 1 bei Treffern.
// Ohne Argumente: src/**/*.ts dieses Pakets (reject-, why-, message-, text-, emptyPool-Texte und _TEXT-Konstanten).
// Mit --labels <datei> oder --texts <datei> (mehrfach): jede Zeichenkette dieser Dateien, als Beschriftung oder als Satz.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLabel, checkText, extractAllStrings, extractUiTexts, type UiText } from '../src/shared/text-rules.js';

const root = fileURLToPath(new URL('../', import.meta.url));

interface Job {
  file: string;
  texts: UiText[];
  check: (text: string) => string[];
}

function parseArgs(argv: string[]): Job[] {
  const jobs: Job[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const mode = argv[i];
    const file = argv[i + 1];
    if ((mode !== '--labels' && mode !== '--texts') || file === undefined) {
      throw new Error(`Unbekanntes Argument: ${mode ?? ''}. Erlaubt sind --labels <datei> und --texts <datei>.`);
    }
    const abs = resolve(process.cwd(), file);
    jobs.push({ file: abs, texts: extractAllStrings(readFileSync(abs, 'utf8')), check: mode === '--labels' ? checkLabel : checkText });
  }
  return jobs;
}

function defaultJobs(): Job[] {
  const srcDir = join(root, 'src');
  return readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => join(d.parentPath, d.name))
    .sort()
    .map((file) => ({
      file,
      // Ein einzelnes Wort ohne Leerzeichen ist ein Code (z. B. zod-Meldung 'url'), kein Text für Menschen.
      texts: extractUiTexts(readFileSync(file, 'utf8')).filter((t) => /\s/.test(t.text.trim())),
      check: checkText,
    }));
}

const jobs = process.argv.length > 2 ? parseArgs(process.argv.slice(2)) : defaultJobs();

let problems = 0;
let checked = 0;
for (const job of jobs) {
  for (const { text, line } of job.texts) {
    checked += 1;
    const reasons = job.check(text);
    if (reasons.length === 0) continue;
    problems += 1;
    console.log(`${relative(process.cwd(), job.file).replaceAll('\\', '/')}:${line}: ${reasons.join(', ')} – ${text}`);
  }
}

console.log(`${checked} Texte geprüft, ${problems} Verstöße.`);
process.exitCode = problems > 0 ? 1 : 0;
